import type { Sql } from "postgres";
import { hashPassword, verifyPassword } from "./password";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  isSystemOwner: boolean;
}

export interface HiveMembership {
  hiveId: string;
  role: "owner" | "member" | "viewer";
}

/**
 * Total number of active users. When zero, the login page renders a
 * one-time "create owner" form instead of sign-in. Once non-zero, the old
 * single-password fallback is disabled.
 */
export async function countUsers(sql: Sql): Promise<number> {
  const [row] = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM users WHERE is_active = true
  `;
  return row.c;
}

export async function findUserByEmail(
  sql: Sql,
  email: string,
): Promise<AuthUser | null> {
  const [row] = await sql`
    SELECT id, email, display_name AS "displayName",
           is_system_owner AS "isSystemOwner"
    FROM users
    WHERE lower(email) = lower(${email}) AND is_active = true
  `;
  return (row as unknown as AuthUser) ?? null;
}

export async function verifyCredentials(
  sql: Sql,
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const [row] = await sql`
    SELECT id, email, display_name AS "displayName",
           password_hash AS "passwordHash",
           is_system_owner AS "isSystemOwner"
    FROM users
    WHERE lower(email) = lower(${email}) AND is_active = true
  `;
  if (!row) return null;
  const ok = verifyPassword(password, (row.passwordHash as unknown) as string);
  if (!ok) return null;
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: (row.displayName as string | null) ?? null,
    isSystemOwner: Boolean(row.isSystemOwner),
  };
}

/**
 * Bootstrap the first owner. Only works when no active users exist — used
 * by the first-run setup flow. Subsequent owners are added via the
 * authenticated admin API.
 */
export async function bootstrapFirstOwner(
  sql: Sql,
  input: { email: string; password: string; displayName?: string },
): Promise<AuthUser> {
  const count = await countUsers(sql);
  if (count > 0) {
    throw new Error(
      "Users already exist — first-owner bootstrap can only run on an empty users table",
    );
  }
  const hash = hashPassword(input.password);
  const [row] = await sql<
    { id: string; email: string; displayName: string | null; isSystemOwner: boolean }[]
  >`
    INSERT INTO users (email, display_name, password_hash, is_system_owner)
    VALUES (${input.email}, ${input.displayName ?? null}, ${hash}, true)
    RETURNING id, email, display_name AS "displayName",
              is_system_owner AS "isSystemOwner"
  `;
  return row;
}

export async function listMemberships(
  sql: Sql,
  userId: string,
): Promise<HiveMembership[]> {
  const rows = await sql`
    SELECT hive_id AS "hiveId", role
    FROM hive_memberships
    WHERE user_id = ${userId}
  `;
  return (rows as unknown as HiveMembership[]) ?? [];
}

export async function canAccessHive(
  sql: Sql,
  userId: string,
  hiveId: string,
): Promise<boolean> {
  // System owners implicitly have read access to every hive.
  const [user] = await sql<{ isSystemOwner: boolean }[]>`
    SELECT is_system_owner AS "isSystemOwner" FROM users WHERE id = ${userId}
  `;
  if (user?.isSystemOwner) return true;

  const [row] = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM hive_memberships
    WHERE user_id = ${userId}
      AND hive_id = ${hiveId}::uuid
  `;
  return row.c > 0;
}

export async function canMutateHive(
  sql: Sql,
  userId: string,
  hiveId: string,
): Promise<boolean> {
  // System owners implicitly have write access to every hive.
  const [user] = await sql<{ isSystemOwner: boolean }[]>`
    SELECT is_system_owner AS "isSystemOwner" FROM users WHERE id = ${userId}
  `;
  if (user?.isSystemOwner) return true;

  const [row] = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM hive_memberships
    WHERE user_id = ${userId}
      AND hive_id = ${hiveId}::uuid
      AND role IN ('owner', 'member')
  `;
  return row.c > 0;
}
