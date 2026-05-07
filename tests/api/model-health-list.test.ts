import { beforeEach, describe, expect, it } from "vitest";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { GET } from "../../src/app/api/model-health/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa";
const OTHER_HIVE_ID = "bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-6666-4666-8666-cccccccccccc";
const FINGERPRINT = "1111111111111111111111111111111111111111111111111111111111111111";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_ID}, 'model-health-list', 'Model Health List', 'digital'),
      (${OTHER_HIVE_ID}, 'other-model-health-list', 'Other Model Health List', 'digital')
  `;
  await sql`
    INSERT INTO credentials (id, hive_id, name, key, value, fingerprint)
    VALUES (${CREDENTIAL_ID}, ${HIVE_ID}, 'OpenAI', 'OPENAI_API_KEY', 'encrypted-value', ${FINGERPRINT})
  `;
});

describe("GET /api/model-health", () => {
  it("requires hiveId", async () => {
    const res = await GET(new Request("http://localhost/api/model-health"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("hiveId is required");
  });

  it("returns enabled hive models with their latest credential-scoped health rows", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        credential_id,
        capabilities,
        fallback_priority,
        enabled
      )
      VALUES
        (
          ${HIVE_ID},
          'openai',
          'openai-codex/gpt-5.5',
          'codex',
          ${CREDENTIAL_ID},
          ${sql.json(["text", "code"])},
          10,
          true
        ),
        (
          ${HIVE_ID},
          'local',
          'qwen3:32b',
          'ollama',
          NULL,
          ${sql.json(["text"])},
          20,
          true
        ),
        (
          ${HIVE_ID},
          'anthropic',
          'anthropic/claude-opus-4-7',
          'claude-code',
          NULL,
          ${sql.json(["text"])},
          30,
          false
        ),
        (
          ${OTHER_HIVE_ID},
          'openai',
          'openai-codex/gpt-5.4',
          'codex',
          NULL,
          ${sql.json(["text"])},
          1,
          true
        )
    `;
    const runtimeFingerprint = createRuntimeCredentialFingerprint({
      provider: "local",
      adapterType: "ollama",
      baseUrl: null,
    });
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at,
        last_failed_at,
        last_failure_reason,
        next_probe_at,
        latency_ms,
        sample_cost_usd
      )
      VALUES
        (
          ${FINGERPRINT},
          'openai-codex/gpt-5.5',
          'healthy',
          '2026-05-02T01:00:00Z',
          NULL,
          NULL,
          '2026-05-02T02:00:00Z',
          1234,
          0.000004
        ),
        (
          ${runtimeFingerprint},
          'qwen3:32b',
          'unhealthy',
          '2026-05-02T01:05:00Z',
          '2026-05-02T01:05:00Z',
          '{"code":"gpu_oom","message":"GPU out of memory","failureClass":"gpu_oom","retryable":true}',
          '2026-05-02T01:20:00Z',
          90,
          0
        )
    `;

    const res = await GET(new Request(`http://localhost/api/model-health?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.hiveId).toBe(HIVE_ID);
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.rows[0]).toMatchObject({
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      credentialName: "OpenAI",
      healthFingerprint: FINGERPRINT,
      status: "healthy",
      latencyMs: 1234,
    });
    expect(body.data.rows[1]).toMatchObject({
      provider: "local",
      adapterType: "ollama",
      modelId: "qwen3:32b",
      credentialName: null,
      healthFingerprint: runtimeFingerprint,
      status: "unhealthy",
      failureClass: "gpu_oom",
      failureMessage: "GPU out of memory",
    });
  });

  it("collapses provider-prefixed aliases into one health row", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        fallback_priority,
        enabled
      )
      VALUES
        (${HIVE_ID}, 'openai', 'gpt-5.5', 'codex', 100, true),
        (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 100, true)
    `;

    const res = await GET(new Request(`http://localhost/api/model-health?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.rows).toHaveLength(1);
    expect(body.data.rows[0]).toMatchObject({
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
    });
  });
});
