import { describe, it, expect, beforeEach } from "vitest";
import { POST as createCredential } from "@/app/api/credentials/route";
import { DELETE as deleteCredentialRoute } from "@/app/api/credentials/[id]/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "credentials-delete-";
let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  process.env.ENCRYPTION_KEY ??= "credentials-delete-test-encryption-key";

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'Credentials Delete Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;
});

async function createCred(name: string, key: string): Promise<string> {
  const req = new Request("http://localhost/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hiveId,
      name,
      key,
      value: "secret",
      rolesAllowed: [],
    }),
  });
  const res = await createCredential(req);
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.data.id;
}

describe("DELETE /api/credentials/[id]", () => {
  it("returns 200 and deletes the credential when no installs reference it", async () => {
    const id = await createCred("Stripe key", `${PREFIX}STRIPE_KEY`);

    const req = new Request(`http://localhost/api/credentials/${id}`, {
      method: "DELETE",
    });
    const res = await deleteCredentialRoute(req, {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);

    const rows = await sql`SELECT id FROM credentials WHERE id = ${id}`;
    expect(rows).toHaveLength(0);

    const [event] = await sql<{ event_type: string; actor_id: string; metadata_text: string }[]>`
      SELECT event_type, actor_id, metadata::text AS metadata_text
      FROM agent_audit_events
      WHERE target_type = 'credential'
        AND target_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    expect(event.event_type).toBe("credential.revoked_by_owner");
    expect(event.actor_id).toBe("test-user");
    expect(event.metadata_text).toContain(`${PREFIX}STRIPE_KEY`);
    expect(event.metadata_text).not.toContain("secret");
  });

  it("returns 404 for an unknown credential id", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = new Request(`http://localhost/api/credentials/${fakeId}`, {
      method: "DELETE",
    });
    const res = await deleteCredentialRoute(req, {
      params: Promise.resolve({ id: fakeId }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 with blocking installs when a connector_install references the credential", async () => {
    const id = await createCred("Webhook URL", `${PREFIX}WEBHOOK_URL`);

    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id)
      VALUES (${hiveId}::uuid, 'discord-webhook', 'Test Discord', '{}'::jsonb, ${id}::uuid)
    `;

    const req = new Request(`http://localhost/api/credentials/${id}`, {
      method: "DELETE",
    });
    const res = await deleteCredentialRoute(req, {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/in use/i);
    expect(Array.isArray(body.blockedBy)).toBe(true);
    expect(body.blockedBy).toHaveLength(1);
    expect(body.blockedBy[0].connectorSlug).toBe("discord-webhook");

    // Confirm the credential is still in the DB
    const rows = await sql`SELECT id FROM credentials WHERE id = ${id}`;
    expect(rows).toHaveLength(1);
  });

  it("force=true bypasses the in-use check and orphans the install", async () => {
    const id = await createCred("Forced", `${PREFIX}FORCE_KEY`);

    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id)
      VALUES (${hiveId}::uuid, 'discord-webhook', 'To be orphaned', '{}'::jsonb, ${id}::uuid)
    `;

    const req = new Request(
      `http://localhost/api/credentials/${id}?force=true`,
      { method: "DELETE" },
    );
    const res = await deleteCredentialRoute(req, {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.force).toBe(true);

    const credRows = await sql`SELECT id FROM credentials WHERE id = ${id}`;
    expect(credRows).toHaveLength(0);

    // The install row survives. The connector_installs.credential_id FK has
    // ON DELETE SET NULL, so the install loses its pointer and becomes
    // inert (the runtime will refuse to fire because no secrets resolve).
    const installRows = await sql`
      SELECT id, credential_id FROM connector_installs
      WHERE display_name = 'To be orphaned'
    `;
    expect(installRows).toHaveLength(1);
    expect(installRows[0].credential_id).toBeNull();
  });
});
