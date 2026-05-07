import { beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/model-health/sync-models/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-8888-4888-8888-aaaaaaaaaaaa";

beforeEach(async () => {
  await truncateAll(sql, { preserveReadOnlyTables: false });
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'model-sync-api', 'Model Sync API', 'digital')
  `;
});

describe("POST /api/model-health/sync-models", () => {
  it("requires hiveId", async () => {
    const res = await POST(new Request("http://localhost/api/model-health/sync-models", {
      method: "POST",
      body: JSON.stringify({}),
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
  });

  it("syncs configured role models for the requested hive", async () => {
    await sql`
      INSERT INTO role_templates (
        slug,
        name,
        department,
        type,
        adapter_type,
        recommended_model,
        active
      )
      VALUES (
        'hive-supervisor',
        'Hive Supervisor',
        'ops',
        'system',
        'codex',
        'openai-codex/gpt-5.5',
        true
      )
      ON CONFLICT (slug) DO UPDATE
        SET active = EXCLUDED.active,
            adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;

    const res = await POST(new Request("http://localhost/api/model-health/sync-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE_ID }),
    }));
    const body = await res.json();
    const rows = await sql`
      SELECT provider, model_id, adapter_type
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
    `;

    expect(res.status).toBe(200);
    expect(body.data.result).toMatchObject({ upserted: 1 });
    expect(rows).toEqual([
      {
        provider: "openai",
        model_id: "openai-codex/gpt-5.5",
        adapter_type: "codex",
      },
    ]);
  });
});
