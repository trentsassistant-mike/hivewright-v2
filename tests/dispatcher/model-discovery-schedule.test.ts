import { beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../../src/credentials/encryption";
import {
  discoverModelsForAdapter,
  discoveryConfigForAdapter,
} from "../../src/model-discovery/providers";
import { runModelDiscoveryImport } from "../../src/model-discovery/service";
import {
  runScheduledModelDiscovery,
  shouldRunModelDiscovery,
} from "../../src/dispatcher/model-discovery-schedule";
import { testSql as sql, truncateAll } from "../_lib/test-db";

vi.mock("../../src/model-discovery/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/model-discovery/providers")>();
  return {
    ...actual,
    discoveryConfigForAdapter: vi.fn(actual.discoveryConfigForAdapter),
    discoverModelsForAdapter: vi.fn(async ({ adapterType, provider }) => [{
      provider,
      adapterType,
      modelId: `${provider}/scheduled-model`,
      displayName: "Scheduled Model",
      family: "scheduled",
      capabilities: ["text", "code"],
      local: adapterType === "ollama",
    }]),
  };
});

vi.mock("../../src/model-discovery/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/model-discovery/service")>();
  return {
    ...actual,
    runModelDiscoveryImport: vi.fn(async () => ({
      runId: "11111111-1111-4111-8111-111111111111",
      catalogIds: [],
      modelsSeen: 1,
      modelsImported: 1,
      modelsAutoEnabled: 1,
      modelsMarkedStale: 0,
    })),
  };
});

const HIVE_ID = "aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa";
const OTHER_HIVE_ID = "bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-6666-4666-8666-cccccccccccc";
const SECOND_CREDENTIAL_ID = "dddddddd-6666-4666-8666-dddddddddddd";
const ENCRYPTION_KEY = "scheduled-discovery-test-key";

const mockedDiscoverModelsForAdapter = vi.mocked(discoverModelsForAdapter);
const mockedDiscoveryConfigForAdapter = vi.mocked(discoveryConfigForAdapter);
const mockedRunModelDiscoveryImport = vi.mocked(runModelDiscoveryImport);

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_ID}, 'scheduled-discovery-hive', 'Scheduled Discovery Hive', 'digital'),
      (${OTHER_HIVE_ID}, 'other-scheduled-discovery-hive', 'Other Scheduled Discovery Hive', 'digital')
  `;
});

describe("shouldRunModelDiscovery", () => {
  it("runs cloud discovery daily and ollama discovery every six hours", () => {
    const now = new Date("2026-05-04T12:00:00.000Z");

    expect(shouldRunModelDiscovery({
      adapterType: "gemini",
      lastStartedAt: new Date("2026-05-03T11:59:00.000Z"),
      now,
    })).toBe(true);
    expect(shouldRunModelDiscovery({
      adapterType: "gemini",
      lastStartedAt: new Date("2026-05-04T01:00:00.000Z"),
      now,
    })).toBe(false);
    expect(shouldRunModelDiscovery({
      adapterType: "ollama",
      lastStartedAt: new Date("2026-05-04T05:59:00.000Z"),
      now,
    })).toBe(true);
  });
});

describe("runScheduledModelDiscovery", () => {
  it("discovers due adapter-config and enabled-model candidates", async () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES
        (${HIVE_ID}, 'gemini', '{}'::jsonb),
        (${HIVE_ID}, 'codex', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO credentials (id, hive_id, name, key, value)
      VALUES (
        ${CREDENTIAL_ID},
        ${OTHER_HIVE_ID},
        'Ollama URL',
        'OLLAMA_BASE_URL',
        ${encrypt("http://ollama.test:11434", ENCRYPTION_KEY)}
      )
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES (${OTHER_HIVE_ID}, 'local', 'local/qwen', 'ollama', ${CREDENTIAL_ID}, true)
    `;
    await sql`
      INSERT INTO model_discovery_runs (
        hive_id,
        adapter_type,
        provider,
        source,
        status,
        started_at,
        completed_at
      )
      VALUES (
        ${HIVE_ID},
        'codex',
        'openai',
        'openai_models_api',
        'completed',
        ${new Date("2026-05-04T08:00:00.000Z")},
        ${new Date("2026-05-04T08:01:00.000Z")}
      )
    `;

    const result = await runScheduledModelDiscovery(sql, { now });

    expect(result).toEqual({ candidates: 3, attempted: 2, succeeded: 2, failed: 0 });
    expect(mockedDiscoveryConfigForAdapter).toHaveBeenCalledWith({
      adapterType: "gemini",
      provider: null,
    });
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledWith({
      adapterType: "gemini",
      provider: "google",
    });
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledWith({
      adapterType: "ollama",
      provider: "local",
      credentials: { OLLAMA_BASE_URL: "http://ollama.test:11434" },
    });
    expect(mockedRunModelDiscoveryImport).toHaveBeenCalledTimes(2);
    expect(mockedRunModelDiscoveryImport).toHaveBeenCalledWith(sql, expect.objectContaining({
      hiveId: OTHER_HIVE_ID,
      adapterType: "ollama",
      provider: "local",
      credentialId: CREDENTIAL_ID,
      assignCredentialToHiveModels: false,
      source: "ollama_tags_api",
    }));
  });

  it("records a failed discovery run when provider discovery fails", async () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (${HIVE_ID}, 'claude-code', '{}'::jsonb)
    `;
    mockedDiscoverModelsForAdapter.mockRejectedValueOnce(
      new Error("Anthropic Models API request failed: 500"),
    );

    const result = await runScheduledModelDiscovery(sql, { now });

    expect(result).toEqual({ candidates: 1, attempted: 1, succeeded: 0, failed: 1 });
    expect(mockedRunModelDiscoveryImport).not.toHaveBeenCalled();

    const [run] = await sql<{ status: string; error: string | null }[]>`
      SELECT status, error
      FROM model_discovery_runs
      WHERE hive_id = ${HIVE_ID}
        AND adapter_type = 'claude-code'
    `;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Anthropic Models API request failed: 500");
  });

  it("uses one deterministic stored credential without duplicating adapter discovery", async () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    await sql`
      INSERT INTO credentials (id, hive_id, name, key, value)
      VALUES
        (
          ${CREDENTIAL_ID},
          ${HIVE_ID},
          'Gemini key one',
          'GEMINI_API_KEY',
          ${encrypt("gemini-key-one", ENCRYPTION_KEY)}
        ),
        (
          ${SECOND_CREDENTIAL_ID},
          ${HIVE_ID},
          'Gemini key two',
          'GEMINI_API_KEY',
          ${encrypt("gemini-key-two", ENCRYPTION_KEY)}
        )
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, credential_id, enabled)
      VALUES
        (${HIVE_ID}, 'google', 'google/gemini-one', 'gemini', ${CREDENTIAL_ID}, true),
        (${HIVE_ID}, 'google', 'google/gemini-two', 'gemini', ${SECOND_CREDENTIAL_ID}, true)
    `;

    const result = await runScheduledModelDiscovery(sql, { now });

    expect(result).toEqual({ candidates: 1, attempted: 1, succeeded: 1, failed: 0 });
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledWith({
      adapterType: "gemini",
      provider: "google",
      credentials: { GEMINI_API_KEY: "gemini-key-one" },
    });
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledTimes(1);
    expect(mockedRunModelDiscoveryImport).toHaveBeenCalledWith(sql, expect.objectContaining({
      credentialId: CREDENTIAL_ID,
      assignCredentialToHiveModels: false,
    }));
  });

  it("skips a due candidate while another dispatcher holds its discovery lock", async () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (${HIVE_ID}, 'gemini', '{}'::jsonb)
    `;

    const lockSql = await sql.reserve();
    try {
      await lockSql`
        SELECT pg_advisory_lock(
          hashtext('hivewright:model-discovery'),
          hashtext(${`${HIVE_ID}:gemini`})
        )
      `;

      const result = await runScheduledModelDiscovery(sql, { now });

      expect(result).toEqual({ candidates: 1, attempted: 0, succeeded: 0, failed: 0 });
      expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();
      expect(mockedRunModelDiscoveryImport).not.toHaveBeenCalled();
    } finally {
      await lockSql`
        SELECT pg_advisory_unlock(
          hashtext('hivewright:model-discovery'),
          hashtext(${`${HIVE_ID}:gemini`})
        )
      `;
      lockSql.release();
    }
  });

  it("rechecks cadence after acquiring the discovery lock", async () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (${HIVE_ID}, 'gemini', '{}'::jsonb)
    `;

    const result = await runScheduledModelDiscovery(sql, {
      now,
      onLockAcquired: async () => {
        await sql`
          INSERT INTO model_discovery_runs (
            hive_id,
            adapter_type,
            provider,
            source,
            status,
            started_at,
            completed_at
          )
          VALUES (
            ${HIVE_ID},
            'gemini',
            'google',
            'gemini_models_api',
            'completed',
            ${new Date("2026-05-04T11:59:00.000Z")},
            ${new Date("2026-05-04T11:59:10.000Z")}
          )
        `;
      },
    });

    expect(result).toEqual({ candidates: 1, attempted: 0, succeeded: 0, failed: 0 });
    expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();
  });
});
