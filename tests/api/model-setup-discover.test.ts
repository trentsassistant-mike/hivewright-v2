import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { POST } from "../../src/app/api/model-setup/discover/route";
import { encrypt } from "../../src/credentials/encryption";
import { discoverModelsForAdapter } from "../../src/model-discovery/providers";
import { testSql as sql, truncateAll } from "../_lib/test-db";

vi.mock("../../src/app/api/_lib/auth", () => ({
  requireSystemOwner: vi.fn(async () => ({
    user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
  })),
}));

vi.mock("../../src/model-discovery/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/model-discovery/providers")>();
  return {
    ...actual,
    discoverModelsForAdapter: vi.fn(async () => [{
      provider: "google",
      adapterType: "gemini",
      modelId: "google/gemini-api-new",
      displayName: "Gemini API New",
      family: "gemini",
      capabilities: ["text", "code"],
      local: false,
    }]),
  };
});

const HIVE_ID = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const OTHER_HIVE_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-2222-4222-8222-cccccccccccc";
const OTHER_CREDENTIAL_ID = "dddddddd-2222-4222-8222-dddddddddddd";
const ENCRYPTION_KEY = "model-setup-discover-test-key";

const mockedDiscoverModelsForAdapter = vi.mocked(discoverModelsForAdapter);
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_ID}, 'api-discovery-hive', 'API Discovery Hive', 'digital'),
      (${OTHER_HIVE_ID}, 'other-api-discovery-hive', 'Other API Discovery Hive', 'digital')
  `;
});

afterEach(() => {
  if (originalEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalEncryptionKey;
});

describe("POST /api/model-setup/discover", () => {
  it("discovers and auto-enables adapter models", async () => {
    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({ hiveId: HIVE_ID, adapterType: "gemini" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      result: {
        modelsSeen: 1,
        modelsImported: 1,
        modelsAutoEnabled: 1,
        modelsMarkedStale: 0,
      },
    });
    expect(body.data.result.runId).toBeTruthy();
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledWith({
      adapterType: "gemini",
      provider: "google",
      credentials: {},
    });

    const [row] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-api-new'
    `;
    expect(row.enabled).toBe(true);
  });

  it("does not require a cloud provider credential before live discovery", async () => {
    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({ hiveId: HIVE_ID, adapterType: "codex" }),
    }));

    expect(res.status).toBe(200);
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledWith({
      adapterType: "codex",
      provider: "openai",
      credentials: {},
    });
  });

  it("requires a system owner", async () => {
    const { requireSystemOwner } = await import("../../src/app/api/_lib/auth");
    vi.mocked(requireSystemOwner).mockResolvedValueOnce({
      response: NextResponse.json(
        { error: "Forbidden: system owner role required" },
        { status: 403 },
      ),
    });

    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({ hiveId: HIVE_ID, adapterType: "gemini" }),
    }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: system owner role required" });
    expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();
  });

  it("rejects non-object JSON bodies", async () => {
    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: "null",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("JSON body must be an object");
    expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();
  });

  it("validates hive existence before live discovery", async () => {
    const missingHiveId = "eeeeeeee-2222-4222-8222-eeeeeeeeeeee";

    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({ hiveId: missingHiveId, adapterType: "gemini" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("hive not found");
    expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();
  });

  it("rejects unsupported adapter types without importing", async () => {
    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({ hiveId: HIVE_ID, adapterType: "openclaw" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("unsupported model discovery adapter type: openclaw");
    expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();

    const [runCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM model_discovery_runs
    `;
    expect(Number(runCount.count)).toBe(0);
  });

  it("uses a scoped credential for provider discovery and imported hive models", async () => {
    await sql`
      INSERT INTO credentials (id, hive_id, name, key, value)
      VALUES (
        ${CREDENTIAL_ID},
        ${HIVE_ID},
        'Gemini API Key',
        'GEMINI_API_KEY',
        ${encrypt("gemini-secret", ENCRYPTION_KEY)}
      )
    `;

    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({
        hiveId: HIVE_ID,
        adapterType: "gemini",
        credentialId: CREDENTIAL_ID,
      }),
    }));

    expect(res.status).toBe(200);
    expect(mockedDiscoverModelsForAdapter).toHaveBeenCalledWith({
      adapterType: "gemini",
      provider: "google",
      credentials: { GEMINI_API_KEY: "gemini-secret" },
    });

    const [row] = await sql<{ credential_id: string | null }[]>`
      SELECT credential_id FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-api-new'
    `;
    expect(row.credential_id).toBe(CREDENTIAL_ID);
  });

  it("rejects credentials from another hive before discovery", async () => {
    await sql`
      INSERT INTO credentials (id, hive_id, name, key, value)
      VALUES (
        ${OTHER_CREDENTIAL_ID},
        ${OTHER_HIVE_ID},
        'Other Gemini API Key',
        'GEMINI_API_KEY',
        ${encrypt("other-secret", ENCRYPTION_KEY)}
      )
    `;

    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({
        hiveId: HIVE_ID,
        adapterType: "gemini",
        credentialId: OTHER_CREDENTIAL_ID,
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("credential must be global or belong to the selected hive");
    expect(mockedDiscoverModelsForAdapter).not.toHaveBeenCalled();
  });

  it("surfaces provider failures without writing import results", async () => {
    await sql`
      INSERT INTO credentials (id, hive_id, name, key, value)
      VALUES (
        ${CREDENTIAL_ID},
        ${HIVE_ID},
        'Gemini API Key',
        'GEMINI_API_KEY',
        ${encrypt("gemini-secret", ENCRYPTION_KEY)}
      )
    `;
    mockedDiscoverModelsForAdapter.mockRejectedValueOnce(
      new Error("Gemini Models API request failed: 401 Unauthorized"),
    );

    const res = await POST(new Request("http://localhost/api/model-setup/discover", {
      method: "POST",
      body: JSON.stringify({ hiveId: HIVE_ID, adapterType: "gemini" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe("Gemini Models API request failed: 401 Unauthorized");

    const [runCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM model_discovery_runs
    `;
    const [hiveModelCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM hive_models
    `;
    expect(Number(runCount.count)).toBe(0);
    expect(Number(hiveModelCount.count)).toBe(0);
  });
});
