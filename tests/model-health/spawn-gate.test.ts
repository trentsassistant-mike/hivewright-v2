import { beforeEach, describe, expect, it } from "vitest";
import { checkModelSpawnHealth } from "@/model-health/spawn-gate";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa";
const NOW = new Date("2026-05-03T00:00:00.000Z");

beforeEach(async () => {
  await truncateAll(sql, { preserveReadOnlyTables: false });
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'spawn-gate', 'Spawn Gate', 'digital')
  `;
});

describe("checkModelSpawnHealth", () => {
  it("allows a model when the hive registry row has fresh healthy probe evidence", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', true)
    `;
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at,
        next_probe_at
      )
      VALUES (
        ${fingerprint},
        'openai-codex/gpt-5.5',
        'healthy',
        ${NOW},
        ${new Date(NOW.getTime() + 60 * 60 * 1000)}
      )
    `;

    const decision = await checkModelSpawnHealth(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
    });

    expect(decision).toMatchObject({
      canRun: true,
      reason: "fresh_healthy_probe",
      status: "healthy",
    });
  });

  it("blocks an unregistered adapter/model path before spawn", async () => {
    const decision = await checkModelSpawnHealth(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
    });

    expect(decision).toMatchObject({
      canRun: false,
      reason: "model_registry_missing",
    });
  });

  it("blocks stale health evidence even when the previous probe was healthy", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "local",
      adapterType: "ollama",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'local', 'qwen3:32b', 'ollama', true)
    `;
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at,
        next_probe_at
      )
      VALUES (
        ${fingerprint},
        'qwen3:32b',
        'healthy',
        ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)},
        ${new Date(NOW.getTime() - 60 * 1000)}
      )
    `;

    const decision = await checkModelSpawnHealth(sql, {
      hiveId: HIVE_ID,
      adapterType: "ollama",
      modelId: "qwen3:32b",
      now: NOW,
    });

    expect(decision).toMatchObject({
      canRun: false,
      reason: "health_probe_stale",
      status: "healthy",
    });
  });

  it("blocks a healthy route when last_probed_at is stale even if next_probe_at is still in the future", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "anthropic",
      adapterType: "claude-code",
      baseUrl: null,
    });
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'anthropic', 'anthropic/claude-sonnet-4-6', 'claude-code', true)
    `;
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at,
        next_probe_at
      )
      VALUES (
        ${fingerprint},
        'anthropic/claude-sonnet-4-6',
        'healthy',
        ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)},
        ${new Date(NOW.getTime() + 15 * 60 * 1000)}
      )
    `;

    const decision = await checkModelSpawnHealth(sql, {
      hiveId: HIVE_ID,
      adapterType: "claude-code",
      modelId: "anthropic/claude-sonnet-4-6",
      now: NOW,
    });

    expect(decision).toMatchObject({
      canRun: false,
      reason: "health_probe_stale",
      status: "healthy",
    });
  });

  it("blocks unhealthy probe evidence and returns the recorded failure reason", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "anthropic",
      adapterType: "claude-code",
      baseUrl: null,
    });
    const failure = {
      code: "quota_exhausted",
      message: "weekly Anthropic limit reached",
      failureClass: "quota",
      retryable: true,
    };
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'anthropic', 'anthropic/claude-opus-4-7', 'claude-code', true)
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
        'anthropic/claude-opus-4-7',
        'unhealthy',
        ${NOW},
        ${NOW},
        ${JSON.stringify(failure)},
        ${new Date(NOW.getTime() + 15 * 60 * 1000)}
      )
    `;

    const decision = await checkModelSpawnHealth(sql, {
      hiveId: HIVE_ID,
      adapterType: "claude-code",
      modelId: "anthropic/claude-opus-4-7",
      now: NOW,
    });

    expect(decision).toMatchObject({
      canRun: false,
      reason: "health_probe_unhealthy",
      status: "unhealthy",
      failureReason: JSON.stringify(failure),
    });
  });

  it("treats quarantined scope_denied routes as unavailable rather than runnable readiness", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });
    const failure = {
      code: "scope_denied",
      message: "Credential lacks the scope or model entitlement required for this probe.",
      failureClass: "scope",
      retryable: false,
      quarantine: {
        active: true,
        reason: "scope_denied",
      },
      consecutiveNonRetryableFailures: 2,
    };
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', true)
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
        ${NOW},
        ${NOW},
        ${JSON.stringify(failure)},
        NULL
      )
    `;

    const decision = await checkModelSpawnHealth(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      now: NOW,
    });

    expect(decision).toMatchObject({
      canRun: false,
      reason: "health_probe_quarantined",
      status: "quarantined",
      failureReason: JSON.stringify(failure),
    });
  });
});
