import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("hive_models and model_health schema", () => {
  it("stores a per-hive enabled model registry ordered by fallback priority", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('mh-hive-registry', 'Model Health Registry', 'digital')
      RETURNING id
    `;
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO credentials (hive_id, name, key, value, fingerprint)
      VALUES (
        ${hive.id},
        'openrouter-key',
        'OPENROUTER_API_KEY',
        'encrypted-secret',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      )
      RETURNING id
    `;

    await sql`
      INSERT INTO hive_models (
        hive_id, provider, model_id, adapter_type, credential_id,
        capabilities, cost_per_input_token, cost_per_output_token,
        fallback_priority, enabled
      ) VALUES
        (${hive.id}, 'openrouter', 'kimi-k2.6', 'codex', ${credential.id},
         ${sql.json(["chat", "tools"])}, 0.0000001, 0.0000003, 10, true),
        (${hive.id}, 'openai', 'gpt-5.5', 'codex', NULL,
         ${sql.json(["chat", "tools", "persistentSessions"])}, 0.000001, 0.000004, 20, true),
        (${hive.id}, 'anthropic', 'claude-opus-4.7', 'claude-code', NULL,
         ${sql.json(["chat", "tools"])}, 0.000015, 0.000075, 30, false)
    `;

    const enabled = await sql<{ provider: string; model_id: string }[]>`
      SELECT provider, model_id
      FROM hive_models
      WHERE hive_id = ${hive.id} AND enabled = true
      ORDER BY fallback_priority ASC
    `;

    expect(enabled).toEqual([
      { provider: "openrouter", model_id: "kimi-k2.6" },
      { provider: "openai", model_id: "gpt-5.5" },
    ]);
  });

  it("rejects duplicate provider/model rows for the same hive", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('mh-hive-dup', 'Model Health Duplicate', 'digital')
      RETURNING id
    `;

    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type)
      VALUES (${hive.id}, 'openai', 'gpt-5.5', 'codex')
    `;

    await expect(sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type)
      VALUES (${hive.id}, 'openai', 'gpt-5.5', 'codex')
    `).rejects.toThrow();
  });

  it("dedupes model health by credential fingerprint and model_id", async () => {
    const fingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, latency_ms)
      VALUES (${fingerprint}, 'kimi-k2.6', 'healthy', now(), 142)
    `;

    await expect(sql`
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES (${fingerprint}, 'kimi-k2.6', 'healthy')
    `).rejects.toThrow();
  });

  it("lets several hives share one probe row when credentials have the same fingerprint", async () => {
    const sharedFingerprint = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const hives = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES
        ('mh-hive-shared-a', 'Shared A', 'digital'),
        ('mh-hive-shared-b', 'Shared B', 'digital'),
        ('mh-hive-shared-c', 'Shared C', 'digital')
      RETURNING id
    `;

    for (const [index, hive] of hives.entries()) {
      const [credential] = await sql<{ id: string }[]>`
        INSERT INTO credentials (hive_id, name, key, value, fingerprint)
        VALUES (
          ${hive.id},
          ${`shared-key-${index}`},
          'OPENROUTER_API_KEY',
          ${`encrypted-secret-${index}`},
          ${sharedFingerprint}
        )
        RETURNING id
      `;

      await sql`
        INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, fallback_priority)
        VALUES (${hive.id}, 'openrouter', 'kimi-k2.6', 'codex', ${credential.id}, 10)
      `;
    }

    for (let i = 0; i < hives.length; i += 1) {
      await sql`
        INSERT INTO model_health (fingerprint, model_id, status, last_probed_at)
        VALUES (${sharedFingerprint}, 'kimi-k2.6', 'healthy', now())
        ON CONFLICT (fingerprint, model_id) DO UPDATE
          SET status = EXCLUDED.status,
              last_probed_at = EXCLUDED.last_probed_at,
              updated_at = now()
      `;
    }

    const [{ health_rows: healthRows, hive_model_rows: hiveModelRows }] = await sql<{
      health_rows: number;
      hive_model_rows: number;
    }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM model_health WHERE fingerprint = ${sharedFingerprint}) AS health_rows,
        (SELECT COUNT(*)::int FROM hive_models WHERE model_id = 'kimi-k2.6') AS hive_model_rows
    `;

    expect(healthRows).toBe(1);
    expect(hiveModelRows).toBe(3);
  });

  it("supports scheduler due-poll and enabled-model failover reads", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('mh-hive-scheduler', 'Model Health Scheduler', 'digital')
      RETURNING id
    `;
    const fingerprint = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, fallback_priority, enabled)
      VALUES
        (${hive.id}, 'openrouter', 'kimi-k2.6', 'codex', 10, false),
        (${hive.id}, 'openai', 'gpt-5.5', 'codex', 20, true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, next_probe_at)
      VALUES
        (${fingerprint}, 'kimi-k2.6', 'healthy', now() - interval '1 minute'),
        (${fingerprint}, 'gpt-5.5', 'healthy', now() + interval '1 minute')
    `;

    const enabled = await sql<{ model_id: string }[]>`
      SELECT model_id
      FROM hive_models
      WHERE hive_id = ${hive.id} AND enabled = true
      ORDER BY fallback_priority ASC
    `;
    const due = await sql<{ model_id: string }[]>`
      SELECT model_id
      FROM model_health
      WHERE next_probe_at <= now()
      ORDER BY next_probe_at ASC
    `;

    expect(enabled.map((row) => row.model_id)).toEqual(["gpt-5.5"]);
    expect(due.map((row) => row.model_id)).toEqual(["kimi-k2.6"]);
  });

  it("stores read-only routing benchmark and cost scores on hive models", async () => {
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES ('bbbbbbbb-8888-4888-8888-bbbbbbbbbbbb', 'routing-score-hive', 'Routing Score Hive', 'digital')
    `;

    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score
      )
      VALUES (
        'bbbbbbbb-8888-4888-8888-bbbbbbbbbbbb',
        'openai',
        'openai-codex/gpt-5.5',
        'codex',
        96.5,
        25
      )
    `;

    const [row] = await sql<{
      benchmark_quality_score: string | null;
      routing_cost_score: string | null;
    }[]>`
      SELECT benchmark_quality_score, routing_cost_score
      FROM hive_models
      WHERE model_id = 'openai-codex/gpt-5.5'
    `;

    expect(Number(row.benchmark_quality_score)).toBeCloseTo(96.5);
    expect(Number(row.routing_cost_score)).toBe(25);
  });
});
