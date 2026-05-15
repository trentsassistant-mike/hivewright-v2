import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterProbe, ProbeResult } from "@/adapters/types";
import { createCredentialFingerprint, encrypt } from "@/credentials/encryption";
import { runSystemModelHealthRenewal } from "@/dispatcher/model-health-renewal";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const ENCRYPTION_KEY = "dispatcher-model-health-renewal-test-key";
const NOW = new Date("2026-05-05T00:00:00.000Z");

function healthyProbe(costEstimateUsd = 0.000004): ProbeResult {
  return {
    healthy: true,
    status: "healthy",
    failureClass: null,
    latencyMs: 25,
    costEstimateUsd,
    reason: {
      code: "probe_ok",
      message: "Probe completed successfully.",
      failureClass: null,
      retryable: false,
    },
  };
}

async function createHive(slug: string): Promise<string> {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES (${slug}, ${slug}, 'digital')
    RETURNING id
  `;
  return hive.id;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAll(sql);
});

describe("runSystemModelHealthRenewal", () => {
  it("runs as dispatcher-owned infrastructure without any hive schedule rows", async () => {
    const [hiveA, hiveB] = await Promise.all([
      createHive("renewal-a"),
      createHive("renewal-b"),
    ]);
    const secret = "shared-openrouter-secret";
    const fingerprint = createCredentialFingerprint({
      provider: "OPENROUTER_API_KEY",
      baseUrl: null,
      secretValue: secret,
    });

    for (const hiveId of [hiveA, hiveB]) {
      const [credential] = await sql<{ id: string }[]>`
        INSERT INTO credentials (hive_id, name, key, value, fingerprint)
        VALUES (
          ${hiveId},
          'Shared OpenRouter',
          'OPENROUTER_API_KEY',
          ${encrypt(secret, ENCRYPTION_KEY)},
          ${fingerprint}
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled, capabilities)
        VALUES (
          ${hiveId},
          'openrouter',
          'openrouter/gpt-5.5-mini',
          'codex',
          ${credential.id},
          true,
          ${sql.json(["text", "code"])}
        )
      `;
    }

    const probe = vi.fn(async (_modelId, credential) => {
      expect(credential.secrets.OPENROUTER_API_KEY).toBe(secret);
      return healthyProbe();
    });
    const result = await runSystemModelHealthRenewal(sql, {
      now: NOW,
      encryptionKey: ENCRYPTION_KEY,
      maxRoutesPerTick: 10,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    expect(result).toMatchObject({
      candidates: 1,
      attempted: 1,
      probed: 1,
      skippedLocked: 0,
    });
    expect(probe).toHaveBeenCalledTimes(1);

    const schedules = await sql`SELECT COUNT(*)::int AS count FROM schedules`;
    expect(Number(schedules[0].count)).toBe(0);
  });

  it("prioritizes stale model probes for paused hives before the global overdue backlog", async () => {
    const pausedHive = await createHive("renewal-paused-priority");
    const backlogHive = await createHive("renewal-global-backlog");
    const runtimeFingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });

    await sql`
      INSERT INTO hive_runtime_locks (hive_id, creation_paused, reason, paused_by, updated_at, operating_state)
      VALUES (${pausedHive}, true, 'manual pause', 'test', ${NOW}, 'paused')
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled, capabilities)
      VALUES
        (${backlogHive}, 'openai', 'openai-codex/ancient-overdue', 'codex', true, ${sql.json(["text", "code"])}),
        (${pausedHive}, 'openai', 'openai-codex/resume-blocker', 'codex', true, ${sql.json(["text", "code"])})
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES
        (${runtimeFingerprint}, 'openai-codex/ancient-overdue', 'healthy', ${new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000)}, ${new Date(NOW.getTime() - 9 * 24 * 60 * 60 * 1000)}),
        (${runtimeFingerprint}, 'openai-codex/resume-blocker', 'healthy', ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)}, ${new Date(NOW.getTime() - 60 * 60 * 1000)})
    `;

    const probedModels: string[] = [];
    const probe = vi.fn(async (modelId: string) => {
      probedModels.push(modelId);
      return healthyProbe();
    });
    const result = await runSystemModelHealthRenewal(sql, {
      now: NOW,
      maxRoutesPerTick: 1,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    expect(result).toMatchObject({
      candidates: 1,
      attempted: 1,
      probed: 1,
      healthy: 1,
    });
    expect(probedModels).toEqual(["openai-codex/resume-blocker"]);
  });

  it("does not repeatedly probe quarantined non-retryable routes in background renewal", async () => {
    const hiveId = await createHive("renewal-quarantined");
    const secret = "quarantined-openai-secret";
    const fingerprint = createCredentialFingerprint({
      provider: "OPENAI_API_KEY",
      baseUrl: null,
      secretValue: secret,
    });
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO credentials (hive_id, name, key, value, fingerprint)
      VALUES (
        ${hiveId},
        'OpenAI',
        'OPENAI_API_KEY',
        ${encrypt(secret, ENCRYPTION_KEY)},
        ${fingerprint}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled, capabilities)
      VALUES (
        ${hiveId},
        'openai',
        'openai-codex/gpt-5.5',
        'codex',
        ${credential.id},
        true,
        ${sql.json(["text", "code"])}
      )
    `;
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at,
        last_failed_at,
        last_failure_reason,
        next_probe_at
      )
      VALUES (
        ${fingerprint},
        'openai-codex/gpt-5.5',
        'quarantined',
        ${new Date(NOW.getTime() - 60 * 60 * 1000)},
        ${new Date(NOW.getTime() - 60 * 60 * 1000)},
        ${JSON.stringify({
          code: "scope_denied",
          message: "Credential lacks the scope or model entitlement required for this probe.",
          failureClass: "scope",
          retryable: false,
          quarantine: {
            active: true,
            reason: "scope_denied",
          },
          consecutiveNonRetryableFailures: 2,
        })},
        ${new Date(NOW.getTime() - 60 * 1000)}
      )
    `;

    const probe = vi.fn(async () => healthyProbe());
    const result = await runSystemModelHealthRenewal(sql, {
      now: NOW,
      encryptionKey: ENCRYPTION_KEY,
      maxRoutesPerTick: 10,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    expect(result).toMatchObject({
      candidates: 0,
      attempted: 0,
      probed: 0,
      healthy: 0,
      unhealthy: 0,
    });
    expect(probe).not.toHaveBeenCalled();
  });
});
