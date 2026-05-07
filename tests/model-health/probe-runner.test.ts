import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterProbe, ProbeResult } from "@/adapters/types";
import { createCredentialFingerprint, encrypt } from "@/credentials/encryption";
import {
  createRuntimeCredentialFingerprint,
  runModelHealthProbes,
  selectDueModelHealthProbeRoutes,
} from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const ENCRYPTION_KEY = "model-health-probe-runner-test-key";
const NOW = new Date("2026-05-02T00:00:00.000Z");

function healthyProbe(input: Partial<ProbeResult> = {}): ProbeResult {
  return {
    healthy: true,
    status: "healthy",
    failureClass: null,
    latencyMs: 123,
    costEstimateUsd: 0.000004,
    reason: {
      code: "probe_ok",
      message: "Probe completed successfully.",
      failureClass: null,
      retryable: false,
    },
    ...input,
  };
}

function unhealthyProbe(): ProbeResult {
  return {
    healthy: false,
    status: "unhealthy",
    failureClass: "quota",
    latencyMs: 456,
    costEstimateUsd: 0,
    reason: {
      code: "quota_exhausted",
      message: "Provider quota or rate limit is exhausted.",
      failureClass: "quota",
      retryable: true,
    },
  };
}

function scopeDeniedProbe(): ProbeResult {
  return {
    healthy: false,
    status: "unhealthy",
    failureClass: "scope",
    latencyMs: 456,
    costEstimateUsd: 0,
    reason: {
      code: "scope_denied",
      message: "Credential lacks the scope or model entitlement required for this probe.",
      failureClass: "scope",
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
  await truncateAll(sql);
});

describe("runModelHealthProbes", () => {
  it("probes an enabled hive model with its decrypted credential and upserts healthy cache", async () => {
    const hiveId = await createHive("probe-runner-hive");
    const secret = "sk-model-health-test";
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
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES (${hiveId}, 'openai', 'gpt-5.5', 'codex', ${credential.id}, true)
    `;

    const probe = vi.fn(async () => healthyProbe());
    const result = await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey: ENCRYPTION_KEY,
      now: NOW,
      healthyTtlMs: 3_600_000,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    expect(result).toMatchObject({
      considered: 1,
      probed: 1,
      healthy: 1,
      unhealthy: 0,
      skippedFresh: 0,
      skippedCredentialErrors: 0,
    });
    expect(probe).toHaveBeenCalledWith("gpt-5.5", {
      provider: "openai",
      baseUrl: null,
      fingerprint,
      secrets: { OPENAI_API_KEY: secret },
    });

    const [health] = await sql<{
      fingerprint: string;
      model_id: string;
      status: string;
      last_failure_reason: string | null;
      latency_ms: number;
      sample_cost_usd: string;
      next_probe_at: Date;
    }[]>`
      SELECT fingerprint, model_id, status, last_failure_reason, latency_ms, sample_cost_usd, next_probe_at
      FROM model_health
      WHERE fingerprint = ${fingerprint} AND model_id = 'openai-codex/gpt-5.5'
    `;
    expect(health).toMatchObject({
      fingerprint,
      model_id: "openai-codex/gpt-5.5",
      status: "healthy",
      last_failure_reason: null,
      latency_ms: 123,
      sample_cost_usd: "0.000004",
    });
    expect(new Date(health.next_probe_at).getTime()).toBeGreaterThan(
      new Date("2026-05-02T00:50:00.000Z").getTime(),
    );
    expect(new Date(health.next_probe_at).getTime()).toBeLessThan(
      new Date("2026-05-02T01:10:00.000Z").getTime(),
    );
  });

  it("skips a shared credential/model cache row while it is still fresh", async () => {
    const [hiveA, hiveB] = await Promise.all([
      createHive("probe-runner-shared-a"),
      createHive("probe-runner-shared-b"),
    ]);
    const secret = "shared-secret";
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
          'OpenRouter',
          'OPENROUTER_API_KEY',
          ${encrypt(secret, ENCRYPTION_KEY)},
          ${fingerprint}
        )
        RETURNING id
      `;
      await sql`
        INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
        VALUES (${hiveId}, 'openrouter', 'kimi-k2.6', 'codex', ${credential.id}, true)
      `;
    }
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (${fingerprint}, 'kimi-k2.6', 'healthy', ${NOW}, ${new Date(NOW.getTime() + 30_000)})
    `;

    const probe = vi.fn(async () => healthyProbe());
    const result = await runModelHealthProbes(sql, {
      hiveId: hiveB,
      encryptionKey: ENCRYPTION_KEY,
      now: NOW,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    expect(result.probed).toBe(0);
    expect(result.skippedFresh).toBe(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("re-probes a route when last_probed_at is stale even if next_probe_at is still in the future", async () => {
    const hiveId = await createHive("probe-runner-stale-last-probed");
    const secret = "stale-openrouter-secret";
    const fingerprint = createCredentialFingerprint({
      provider: "OPENROUTER_API_KEY",
      baseUrl: null,
      secretValue: secret,
    });
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO credentials (hive_id, name, key, value, fingerprint)
      VALUES (
        ${hiveId},
        'OpenRouter',
        'OPENROUTER_API_KEY',
        ${encrypt(secret, ENCRYPTION_KEY)},
        ${fingerprint}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES (${hiveId}, 'openrouter', 'openrouter/gpt-5.5-mini', 'codex', ${credential.id}, true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (
        ${fingerprint},
        'openrouter/gpt-5.5-mini',
        'healthy',
        ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)},
        ${new Date(NOW.getTime() + 15 * 60 * 1000)}
      )
    `;

    const probe = vi.fn(async () => healthyProbe());
    const result = await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey: ENCRYPTION_KEY,
      now: NOW,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    expect(result).toMatchObject({
      considered: 1,
      probed: 1,
      healthy: 1,
      skippedFresh: 0,
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("records unhealthy probe results with failure metadata and retry timing", async () => {
    const hiveId = await createHive("probe-runner-unhealthy");
    const secret = "quota-secret";
    const fingerprint = createCredentialFingerprint({
      provider: "ANTHROPIC_API_KEY",
      baseUrl: null,
      secretValue: secret,
    });
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO credentials (hive_id, name, key, value, fingerprint)
      VALUES (
        ${hiveId},
        'Anthropic',
        'ANTHROPIC_API_KEY',
        ${encrypt(secret, ENCRYPTION_KEY)},
        ${fingerprint}
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES (${hiveId}, 'anthropic', 'claude-opus-4.7', 'claude-code', ${credential.id}, true)
    `;

    const result = await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey: ENCRYPTION_KEY,
      now: NOW,
      unhealthyRetryMs: 900_000,
      adapterFactory: async () => ({ probe: vi.fn(async () => unhealthyProbe()) } satisfies AdapterProbe),
    });

    expect(result).toMatchObject({ probed: 1, healthy: 0, unhealthy: 1 });

    const [health] = await sql<{
      status: string;
      last_failed_at: Date | null;
      last_failure_reason: string | null;
      next_probe_at: Date;
    }[]>`
      SELECT status, last_failed_at, last_failure_reason, next_probe_at
      FROM model_health
      WHERE fingerprint = ${fingerprint} AND model_id = 'anthropic/claude-opus-4.7'
    `;
    expect(health.status).toBe("unhealthy");
    expect(new Date(health.last_failed_at!).toISOString()).toBe(NOW.toISOString());
    expect(JSON.parse(health.last_failure_reason!)).toMatchObject({
      code: "quota_exhausted",
      failureClass: "quota",
      retryable: true,
    });
    expect(new Date(health.next_probe_at).getTime()).toBeGreaterThan(
      new Date("2026-05-02T00:10:00.000Z").getTime(),
    );
    expect(new Date(health.next_probe_at).getTime()).toBeLessThan(
      new Date("2026-05-02T00:20:00.000Z").getTime(),
    );
  });

  it("quarantines a non-retryable scope_denied route after a small repeated failure threshold", async () => {
    const hiveId = await createHive("probe-runner-scope-denied");
    const secret = "scope-secret";
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
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES (${hiveId}, 'openai', 'openai-codex/gpt-5.5', 'codex', ${credential.id}, true)
    `;

    const adapterFactory = async () => ({ probe: vi.fn(async () => scopeDeniedProbe()) } satisfies AdapterProbe);

    await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey: ENCRYPTION_KEY,
      now: NOW,
      adapterFactory,
    });
    await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey: ENCRYPTION_KEY,
      now: new Date(NOW.getTime() + 60_000),
      includeFresh: true,
      adapterFactory,
    });

    const [health] = await sql<{
      status: string;
      last_failure_reason: string | null;
      next_probe_at: Date | null;
    }[]>`
      SELECT status, last_failure_reason, next_probe_at
      FROM model_health
      WHERE fingerprint = ${fingerprint} AND model_id = 'openai-codex/gpt-5.5'
    `;
    expect(health.status).toBe("quarantined");
    expect(health.next_probe_at).toBeNull();
    expect(JSON.parse(health.last_failure_reason!)).toMatchObject({
      code: "scope_denied",
      retryable: false,
      quarantine: {
        active: true,
        reason: "scope_denied",
      },
      consecutiveNonRetryableFailures: 2,
    });
  });

  it("uses a stable runtime fingerprint for models without stored credentials", async () => {
    const hiveId = await createHive("probe-runner-runtime-auth");
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES (${hiveId}, 'ollama', 'qwen3:32b', 'ollama', NULL, true)
    `;

    const probe = vi.fn(async () => healthyProbe({ costEstimateUsd: 0 }));
    await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey: ENCRYPTION_KEY,
      now: NOW,
      adapterFactory: async () => ({ probe } satisfies AdapterProbe),
    });

    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "ollama",
      adapterType: "ollama",
      baseUrl: null,
    });
    expect(probe).toHaveBeenCalledWith("qwen3:32b", {
      provider: "ollama",
      baseUrl: null,
      fingerprint,
      secrets: {},
    });

    const [health] = await sql<{ status: string }[]>`
      SELECT status FROM model_health
      WHERE fingerprint = ${fingerprint} AND model_id = 'ollama/qwen3:32b'
    `;
    expect(health.status).toBe("healthy");
  });

  it("selects only due shared route identities instead of duplicating per hive", async () => {
    const [hiveA, hiveB, hiveC] = await Promise.all([
      createHive("probe-due-a"),
      createHive("probe-due-b"),
      createHive("probe-due-c"),
    ]);
    const sharedSecret = "shared-secret";
    const sharedFingerprint = createCredentialFingerprint({
      provider: "OPENROUTER_API_KEY",
      baseUrl: null,
      secretValue: sharedSecret,
    });

    for (const hiveId of [hiveA, hiveB]) {
      const [credential] = await sql<{ id: string }[]>`
        INSERT INTO credentials (hive_id, name, key, value, fingerprint)
        VALUES (
          ${hiveId},
          'OpenRouter',
          'OPENROUTER_API_KEY',
          ${encrypt(sharedSecret, ENCRYPTION_KEY)},
          ${sharedFingerprint}
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

    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled, capabilities)
      VALUES (
        ${hiveC},
        'local',
        'qwen3:32b',
        'ollama',
        true,
        ${sql.json(["text", "code"])}
      )
    `;

    const runtimeFingerprint = createRuntimeCredentialFingerprint({
      provider: "local",
      adapterType: "ollama",
      baseUrl: null,
    });
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES
        (
          ${sharedFingerprint},
          'openrouter/gpt-5.5-mini',
          'healthy',
          ${new Date("2026-05-01T20:00:00.000Z")},
          ${new Date("2026-05-01T23:00:00.000Z")}
        ),
        (
          ${runtimeFingerprint},
          'ollama/qwen3:32b',
          'healthy',
          ${NOW},
          ${new Date("2026-05-02T00:30:00.000Z")}
        )
    `;

    const routes = await selectDueModelHealthProbeRoutes(sql, {
      now: NOW,
      limit: 10,
    });

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      fingerprint: sharedFingerprint,
      modelId: "openrouter/gpt-5.5-mini",
      adapterType: "codex",
      provider: "openrouter",
    });
  });

  it("treats a healthy route as due when last_probed_at is stale even if next_probe_at is still in the future", async () => {
    const hiveId = await createHive("probe-due-stale-last-probed");
    const secret = "due-stale-secret";
    const fingerprint = createCredentialFingerprint({
      provider: "OPENROUTER_API_KEY",
      baseUrl: null,
      secretValue: secret,
    });
    const [credential] = await sql<{ id: string }[]>`
      INSERT INTO credentials (hive_id, name, key, value, fingerprint)
      VALUES (
        ${hiveId},
        'OpenRouter',
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
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, last_probed_at, next_probe_at)
      VALUES (
        ${fingerprint},
        'openrouter/gpt-5.5-mini',
        'healthy',
        ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)},
        ${new Date(NOW.getTime() + 15 * 60 * 1000)}
      )
    `;

    const routes = await selectDueModelHealthProbeRoutes(sql, {
      now: NOW,
      limit: 10,
    });

    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      fingerprint,
      modelId: "openrouter/gpt-5.5-mini",
      adapterType: "codex",
      provider: "openrouter",
    });
  });
});
