import type { Sql } from "postgres";
import { hashPassword } from "./password";

export const LOCAL_OWNER_RESET_FLAG = "ALLOW_LOCAL_OWNER_SESSION_RESET";
export const DEFAULT_LOCAL_OWNER_EMAIL = "owner-qa@hivewright.local";
export const DEFAULT_LOCAL_OWNER_DISPLAY_NAME = "Local QA Owner";

export interface LocalOwnerSessionInput {
  email: string;
  password: string;
  displayName?: string;
}

export interface LocalOwnerSessionResult {
  mode: "created" | "updated";
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isSystemOwner: boolean;
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function assertLocalOwnerSessionResetAllowed(databaseUrl: string): void {
  if (process.env[LOCAL_OWNER_RESET_FLAG] !== "1") {
    throw new Error(
      `Local owner reset is disabled. Export ${LOCAL_OWNER_RESET_FLAG}=1 to enable it.`,
    );
  }

  const runtimeEnv = (process.env.APP_ENV ?? process.env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  if (runtimeEnv === "production") {
    throw new Error("Local owner reset is blocked when APP_ENV/NODE_ENV is production.");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Local owner reset requires a valid DATABASE_URL.");
  }

  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(
      `Local owner reset only targets loopback databases. Refusing host '${parsed.hostname}'.`,
    );
  }
}

export async function seedLocalOwnerSession(
  sql: Sql,
  input: LocalOwnerSessionInput,
): Promise<LocalOwnerSessionResult> {
  if (!input.email.trim()) {
    throw new Error("email is required");
  }
  if (input.password.length < 8) {
    throw new Error("password must be at least 8 characters");
  }

  const email = input.email.trim().toLowerCase();
  const passwordHash = hashPassword(input.password);
  const displayName = input.displayName?.trim() || DEFAULT_LOCAL_OWNER_DISPLAY_NAME;

  const existingRows = await sql<{
    id: string;
    email: string;
    displayName: string | null;
    isSystemOwner: boolean;
  }[]>`
    SELECT id,
           email,
           display_name AS "displayName",
           is_system_owner AS "isSystemOwner"
    FROM users
    WHERE lower(email) = lower(${email})
    LIMIT 1
  `;

  if (existingRows[0]) {
    const [updated] = await sql<{
      id: string;
      email: string;
      displayName: string | null;
      isSystemOwner: boolean;
    }[]>`
      UPDATE users
      SET email = ${email},
          password_hash = ${passwordHash},
          display_name = ${displayName},
          is_active = true,
          is_system_owner = true,
          updated_at = now()
      WHERE id = ${existingRows[0].id}::uuid
      RETURNING id,
                email,
                display_name AS "displayName",
                is_system_owner AS "isSystemOwner"
    `;
    return { mode: "updated", user: updated };
  }

  const [created] = await sql<{
    id: string;
    email: string;
    displayName: string | null;
    isSystemOwner: boolean;
  }[]>`
    INSERT INTO users (email, display_name, password_hash, is_active, is_system_owner)
    VALUES (${email}, ${displayName}, ${passwordHash}, true, true)
    RETURNING id,
              email,
              display_name AS "displayName",
              is_system_owner AS "isSystemOwner"
  `;
  return { mode: "created", user: created };
}
