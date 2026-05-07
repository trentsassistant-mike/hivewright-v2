import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSuiteIsolation,
  createFixtureNamespace,
  type FixtureNamespace,
  type TestDbIsolationLease,
  testSql as sql,
  truncateAll,
} from "../_lib/test-db";
import {
  bootstrapFirstOwner,
  canAccessHive,
  canMutateHive,
  countUsers,
  verifyCredentials,
} from "@/auth/users";
import { hashPassword, verifyPassword } from "@/auth/password";

let fixture: FixtureNamespace;
let hiveA: string;
let hiveB: string;
let isolationLease: TestDbIsolationLease;

beforeAll(async () => {
  isolationLease = await acquireSuiteIsolation(sql);
});

beforeEach(async () => {
  fixture = createFixtureNamespace("auth-users");
  hiveA = fixture.uuid("hive-a");
  hiveB = fixture.uuid("hive-b");
  await truncateAll(sql, { preserveReadOnlyTables: false });
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${hiveA}, ${fixture.slug("hive-a")}, 'Hive A', 'digital'),
      (${hiveB}, ${fixture.slug("hive-b")}, 'Hive B', 'digital')
  `;
});

afterAll(async () => {
  await isolationLease.release();
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", () => {
    const stored = hashPassword("hunter2-hunter2");
    expect(verifyPassword("hunter2-hunter2", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });
});

describe("bootstrapFirstOwner", () => {
  it("creates the first owner when users table is empty", async () => {
    expect(await countUsers(sql)).toBe(0);
    const owner = await bootstrapFirstOwner(sql, {
      email: fixture.email("trent"),
      password: "change-me-soon-plz",
      displayName: "Trent",
    });
    expect(owner.isSystemOwner).toBe(true);
    expect(await countUsers(sql)).toBe(1);
  });

  it("refuses to run a second time", async () => {
    await bootstrapFirstOwner(sql, {
      email: fixture.email("owner-a"),
      password: "password123!",
    });
    await expect(
      bootstrapFirstOwner(sql, {
        email: fixture.email("owner-b"),
        password: "password123!",
      }),
    ).rejects.toThrow(/already exist/);
  });
});

describe("verifyCredentials", () => {
  it("returns the user on correct password, null on wrong", async () => {
    const email = fixture.email("owner");
    await bootstrapFirstOwner(sql, {
      email: email.toUpperCase(),
      password: "right-passw0rd",
    });
    const ok = await verifyCredentials(sql, email, "right-passw0rd");
    expect(ok?.email).toBe(email.toUpperCase());
    const bad = await verifyCredentials(sql, email, "nope");
    expect(bad).toBeNull();
  });
});

describe("canAccessHive", () => {
  it("system owner can access every hive", async () => {
    const owner = await bootstrapFirstOwner(sql, {
      email: fixture.email("system-owner"),
      password: "password123!",
    });
    expect(await canAccessHive(sql, owner.id, hiveA)).toBe(true);
    expect(await canAccessHive(sql, owner.id, hiveB)).toBe(true);
  });

  it("non-system user needs an explicit membership", async () => {
    const owner = await bootstrapFirstOwner(sql, {
      email: fixture.email("system-owner"),
      password: "password123!",
    });
    // Add a normal user.
    const memberEmail = fixture.email("member");
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, is_system_owner)
      VALUES (${memberEmail}, ${hashPassword("password123!")}, false)
      RETURNING id
    `;
    expect(await canAccessHive(sql, u.id, hiveA)).toBe(false);
    await sql`
      INSERT INTO hive_memberships (user_id, hive_id, role)
      VALUES (${u.id}, ${hiveA}::uuid, 'member')
    `;
    expect(await canAccessHive(sql, u.id, hiveA)).toBe(true);
    expect(await canAccessHive(sql, u.id, hiveB)).toBe(false);
    // System owner still has access.
    expect(await canAccessHive(sql, owner.id, hiveB)).toBe(true);
  });

  it("allows viewer memberships as read-only hive access", async () => {
    const viewerEmail = fixture.email("viewer");
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, is_system_owner)
      VALUES (${viewerEmail}, ${hashPassword("password123!")}, false)
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_memberships (user_id, hive_id, role)
      VALUES (${u.id}, ${hiveA}::uuid, 'viewer')
    `;

    expect(await canAccessHive(sql, u.id, hiveA)).toBe(true);
    expect(await canAccessHive(sql, u.id, hiveB)).toBe(false);
    expect(await canMutateHive(sql, u.id, hiveA)).toBe(false);
  });
});

describe("canMutateHive", () => {
  it("allows owners and members, but not viewers", async () => {
    const owner = await bootstrapFirstOwner(sql, {
      email: fixture.email("system-owner"),
      password: "password123!",
    });
    const [member] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, is_system_owner)
      VALUES (${fixture.email("member")}, ${hashPassword("password123!")}, false)
      RETURNING id
    `;
    const [viewer] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, is_system_owner)
      VALUES (${fixture.email("viewer")}, ${hashPassword("password123!")}, false)
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_memberships (user_id, hive_id, role)
      VALUES
        (${member.id}, ${hiveA}::uuid, 'member'),
        (${viewer.id}, ${hiveA}::uuid, 'viewer')
    `;

    expect(await canMutateHive(sql, owner.id, hiveB)).toBe(true);
    expect(await canMutateHive(sql, member.id, hiveA)).toBe(true);
    expect(await canMutateHive(sql, member.id, hiveB)).toBe(false);
    expect(await canMutateHive(sql, viewer.id, hiveA)).toBe(false);
  });
});
