import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertLocalOwnerSessionResetAllowed,
  LOCAL_OWNER_RESET_FLAG,
  seedLocalOwnerSession,
} from "@/auth/local-owner-session";
import { verifyCredentials } from "@/auth/users";
import {
  acquireSuiteIsolation,
  createFixtureNamespace,
  type FixtureNamespace,
  type TestDbIsolationLease,
  testSql as sql,
  truncateAll,
} from "../_lib/test-db";

const mutableEnv = process.env as Record<string, string | undefined>;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_FLAG = process.env[LOCAL_OWNER_RESET_FLAG];
let fixture: FixtureNamespace;
let isolationLease: TestDbIsolationLease;

beforeAll(async () => {
  isolationLease = await acquireSuiteIsolation(sql);
});

beforeEach(async () => {
  fixture = createFixtureNamespace("local-owner-session");
  await truncateAll(sql, { preserveReadOnlyTables: false });
  delete mutableEnv.APP_ENV;
  mutableEnv.NODE_ENV = "development";
  delete mutableEnv[LOCAL_OWNER_RESET_FLAG];
});

afterAll(async () => {
  await isolationLease.release();
});

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete mutableEnv.NODE_ENV;
  } else {
    mutableEnv.NODE_ENV = ORIGINAL_NODE_ENV;
  }

  if (ORIGINAL_APP_ENV === undefined) {
    delete mutableEnv.APP_ENV;
  } else {
    mutableEnv.APP_ENV = ORIGINAL_APP_ENV;
  }

  if (ORIGINAL_FLAG === undefined) {
    delete mutableEnv[LOCAL_OWNER_RESET_FLAG];
  } else {
    mutableEnv[LOCAL_OWNER_RESET_FLAG] = ORIGINAL_FLAG;
  }
});

describe("assertLocalOwnerSessionResetAllowed", () => {
  it("requires the explicit enable flag", () => {
    expect(() =>
      assertLocalOwnerSessionResetAllowed("postgresql://hivewright:hivewright@localhost:5432/hivewright"),
    ).toThrow(LOCAL_OWNER_RESET_FLAG);
  });

  it("rejects production runtime", () => {
    mutableEnv[LOCAL_OWNER_RESET_FLAG] = "1";
    mutableEnv.NODE_ENV = "production";
    expect(() =>
      assertLocalOwnerSessionResetAllowed("postgresql://hivewright:hivewright@localhost:5432/hivewright"),
    ).toThrow(/production/i);
  });

  it("rejects non-loopback database hosts", () => {
    mutableEnv[LOCAL_OWNER_RESET_FLAG] = "1";
    expect(() =>
      assertLocalOwnerSessionResetAllowed("postgresql://hivewright@db.internal:5432/hivewright"),
    ).toThrow(/loopback/i);
  });

  it("accepts loopback database hosts when explicitly enabled", () => {
    mutableEnv[LOCAL_OWNER_RESET_FLAG] = "1";
    expect(() =>
      assertLocalOwnerSessionResetAllowed("postgresql://hivewright@127.0.0.1:5432/hivewright"),
    ).not.toThrow();
  });
});

describe("seedLocalOwnerSession", () => {
  it("creates a system owner when the email is missing", async () => {
    const email = fixture.email("owner");
    const result = await seedLocalOwnerSession(sql, {
      email,
      password: "local-proof-password",
      displayName: "Owner QA",
    });

    expect(result.mode).toBe("created");
    expect(result.user.isSystemOwner).toBe(true);

    const verified = await verifyCredentials(
      sql,
      email,
      "local-proof-password",
    );
    expect(verified?.email).toBe(email);
    expect(verified?.isSystemOwner).toBe(true);
  });

  it("resets the password and promotes an existing row to active system owner", async () => {
    const email = fixture.email("owner");
    await seedLocalOwnerSession(sql, {
      email,
      password: "first-password",
      displayName: "Owner QA",
    });

    await sql`
      UPDATE users
      SET is_active = false,
          is_system_owner = false,
          display_name = 'Old Name'
      WHERE lower(email) = lower(${email})
    `;

    const result = await seedLocalOwnerSession(sql, {
      email,
      password: "second-password",
      displayName: "Reset Owner QA",
    });

    expect(result.mode).toBe("updated");
    expect(result.user.displayName).toBe("Reset Owner QA");
    expect(result.user.isSystemOwner).toBe(true);

    const stale = await verifyCredentials(
      sql,
      email,
      "first-password",
    );
    expect(stale).toBeNull();

    const verified = await verifyCredentials(
      sql,
      email,
      "second-password",
    );
    expect(verified?.displayName).toBe("Reset Owner QA");
    expect(verified?.isSystemOwner).toBe(true);
  });

  it("reuses the same row and canonicalizes email casing on rerun", async () => {
    const canonicalEmail = fixture.email("owner");
    const [existing] = await sql<{ id: string; email: string }[]>`
      INSERT INTO users (email, display_name, password_hash, is_active, is_system_owner)
      VALUES (${canonicalEmail.toUpperCase()}, 'Legacy Owner', 'stale-hash', false, false)
      RETURNING id, email
    `;

    const result = await seedLocalOwnerSession(sql, {
      email: canonicalEmail,
      password: "fresh-password",
      displayName: "Local QA Owner",
    });

    expect(result.mode).toBe("updated");
    expect(result.user.id).toBe(existing.id);
    expect(result.user.email).toBe(canonicalEmail);
  });
});
