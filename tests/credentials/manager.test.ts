import { describe, it, expect, beforeEach } from "vitest";
import {
  backfillCredentialFingerprints,
  storeCredential,
  loadCredentials,
  deleteCredential,
} from "@/credentials/manager";
import { createCredentialFingerprint, encrypt } from "@/credentials/encryption";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const TEST_KEY = "p6-cred-manager-encryption-key";
const TEST_PREFIX = "p6-cred-";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('p6-cred-test', 'P6 Credential Test', 'digital')
    RETURNING id
  `;
  bizId = biz.id;
});

describe("storeCredential", () => {
  it("stores credential with encrypted value (not plaintext in DB)", async () => {
    const plainValue = "my-super-secret-token";

    const { id } = await storeCredential(sql, {
      hiveId: bizId,
      name: "Test API Token",
      key: `${TEST_PREFIX}store-test`,
      value: plainValue,
      rolesAllowed: [],
      encryptionKey: TEST_KEY,
    });

    expect(id).toBeTruthy();

    // Verify the raw DB value is NOT the plaintext
    const [row] = await sql`SELECT value FROM credentials WHERE id = ${id}`;
    expect(row.value).not.toBe(plainValue);
    // Should be iv:authTag:ciphertext format (two colons)
    expect(row.value.split(":")).toHaveLength(3);
  });

  it("stores a deterministic fingerprint without exposing plaintext", async () => {
    const plainValue = "fingerprint-secret-token";
    const { id } = await storeCredential(sql, {
      hiveId: bizId,
      name: "Fingerprint API Token",
      key: `${TEST_PREFIX}fingerprint-store`,
      value: plainValue,
      rolesAllowed: [],
      encryptionKey: TEST_KEY,
    });

    const [row] = await sql`SELECT fingerprint, value FROM credentials WHERE id = ${id}`;

    expect(row.fingerprint).toBe(createCredentialFingerprint({
      provider: `${TEST_PREFIX}fingerprint-store`,
      baseUrl: null,
      secretValue: plainValue,
    }));
    expect(row.fingerprint).not.toContain(plainValue);
    expect(row.value).not.toBe(plainValue);
  });
});

describe("loadCredentials", () => {
  it("loads and decrypts credentials, filtering by role access", async () => {
    // Store one accessible cred (rolesAllowed = []) — all roles
    await storeCredential(sql, {
      hiveId: bizId,
      name: "Open Cred",
      key: `${TEST_PREFIX}load-open`,
      value: "open-value",
      rolesAllowed: [],
      encryptionKey: TEST_KEY,
    });

    // Store one role-restricted cred that this role can access
    await storeCredential(sql, {
      hiveId: bizId,
      name: "Allowed Role Cred",
      key: `${TEST_PREFIX}load-allowed`,
      value: "allowed-value",
      rolesAllowed: ["dev-agent", "qa-agent"],
      encryptionKey: TEST_KEY,
    });

    // Store one role-restricted cred that this role cannot access
    await storeCredential(sql, {
      hiveId: bizId,
      name: "Restricted Cred",
      key: `${TEST_PREFIX}load-restricted`,
      value: "restricted-value",
      rolesAllowed: ["admin-only"],
      encryptionKey: TEST_KEY,
    });

    const results = await loadCredentials(sql, {
      hiveId: bizId,
      keys: [
        `${TEST_PREFIX}load-open`,
        `${TEST_PREFIX}load-allowed`,
        `${TEST_PREFIX}load-restricted`,
      ],
      roleSlug: "dev-agent",
      encryptionKey: TEST_KEY,
    });

    // Should get 2: open + allowed; not restricted
    expect(results).toHaveLength(2);
    const keys = results.map((r) => r.key);
    expect(keys).toContain(`${TEST_PREFIX}load-open`);
    expect(keys).toContain(`${TEST_PREFIX}load-allowed`);
    expect(keys).not.toContain(`${TEST_PREFIX}load-restricted`);

    // Values are decrypted
    const open = results.find((r) => r.key === `${TEST_PREFIX}load-open`)!;
    expect(open.value).toBe("open-value");
    const allowed = results.find((r) => r.key === `${TEST_PREFIX}load-allowed`)!;
    expect(allowed.value).toBe("allowed-value");
  });

  it("includes system-wide credentials (hive_id IS NULL) for any hive", async () => {
    const sysKey = `${TEST_PREFIX}system-cred`;

    // Store a system-wide credential (no hiveId)
    await storeCredential(sql, {
      hiveId: null,
      name: "System Wide Cred",
      key: sysKey,
      value: "system-secret",
      rolesAllowed: [],
      encryptionKey: TEST_KEY,
    });

    const results = await loadCredentials(sql, {
      hiveId: bizId,
      keys: [sysKey],
      roleSlug: "any-role",
      encryptionKey: TEST_KEY,
    });

    expect(results).toHaveLength(1);
    expect(results[0].key).toBe(sysKey);
    expect(results[0].value).toBe("system-secret");
    expect(results[0].hiveId).toBeNull();
  });
});

describe("deleteCredential", () => {
  it("deletes the row and returns deleted=true", async () => {
    const { id } = await storeCredential(sql, {
      hiveId: bizId,
      name: "to-be-deleted",
      key: `${TEST_PREFIX}delete-me`,
      value: "secret",
      rolesAllowed: [],
      encryptionKey: TEST_KEY,
    });

    const result = await deleteCredential(sql, id);
    expect(result.deleted).toBe(true);

    const rows = await sql`SELECT id FROM credentials WHERE id = ${id}`;
    expect(rows).toHaveLength(0);
  });

  it("returns deleted=false for an unknown id", async () => {
    const result = await deleteCredential(
      sql,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result.deleted).toBe(false);
  });
});

describe("backfillCredentialFingerprints", () => {
  it("backfills existing null fingerprints idempotently", async () => {
    const encryptedValue = encrypt("legacy-secret-value", TEST_KEY);
    const [legacy] = await sql`
      INSERT INTO credentials (hive_id, name, key, value, roles_allowed)
      VALUES (
        ${bizId},
        'Legacy Credential',
        ${`${TEST_PREFIX}legacy-provider`},
        ${encryptedValue},
        ${sql.json([])}
      )
      RETURNING id
    `;

    const firstRun = await backfillCredentialFingerprints(sql, {
      encryptionKey: TEST_KEY,
    });

    expect(firstRun).toEqual({ scanned: 1, updated: 1, failed: 0 });

    const [row] = await sql`
      SELECT fingerprint
      FROM credentials
      WHERE id = ${legacy.id}
    `;
    expect(row.fingerprint).toBe(createCredentialFingerprint({
      provider: `${TEST_PREFIX}legacy-provider`,
      baseUrl: null,
      secretValue: "legacy-secret-value",
    }));

    const secondRun = await backfillCredentialFingerprints(sql, {
      encryptionKey: TEST_KEY,
    });

    expect(secondRun).toEqual({ scanned: 0, updated: 0, failed: 0 });
  });
});
