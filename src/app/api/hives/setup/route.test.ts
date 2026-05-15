import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "os";
import path from "path";

const mocks = vi.hoisted(() => {
  const tx = Object.assign(vi.fn(), {
    unsafe: vi.fn(),
    json: vi.fn((value: unknown) => value),
  });
  const sql = Object.assign(vi.fn(), {
    begin: vi.fn(async (cb: (tx: typeof mocks.tx) => Promise<unknown>) => cb(tx)),
    json: vi.fn((value: unknown) => value),
  });
  return {
    sql,
    tx,
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    rmSync: vi.fn(),
    requireApiUser: vi.fn(),
    seedDefaultSchedules: vi.fn(),
    getConnectorDefinition: vi.fn(),
    storeCredential: vi.fn(),
  };
});

vi.mock("fs", () => ({
  default: {
    mkdirSync: mocks.mkdirSync,
    existsSync: mocks.existsSync,
    rmSync: mocks.rmSync,
  },
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/hives/seed-schedules", () => ({
  seedDefaultSchedules: mocks.seedDefaultSchedules,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinition: mocks.getConnectorDefinition,
}));

vi.mock("@/credentials/manager", () => ({
  storeCredential: mocks.storeCredential,
}));

import { POST } from "./route";

const TEST_HIVES_ROOT = path.join(os.tmpdir(), "hw-hives-setup-route-test");
const configuredHivePath = (slug: string, leaf: "projects" | "skills" | "ea") =>
  path.join(TEST_HIVES_ROOT, slug, leaf);

const connectorDefinition = {
  slug: "discord-webhook",
  name: "Discord webhook",
  setupFields: [
    { key: "webhookUrl", label: "Webhook URL", required: true },
    { key: "defaultUsername", label: "Sender name" },
  ],
  secretFields: ["webhookUrl"],
};

function setupRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/hives/setup", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/hives/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.HIVES_WORKSPACE_ROOT = TEST_HIVES_ROOT;
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.seedDefaultSchedules.mockResolvedValue(undefined);
    mocks.getConnectorDefinition.mockReturnValue(connectorDefinition);
    mocks.storeCredential.mockResolvedValue({ id: "credential-1" });
    mocks.sql.mockResolvedValue([]);
    mocks.tx.mockReset();
    mocks.tx.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("INSERT INTO hives")) {
        return [{
          id: "hive-1",
          name: "Test Hive",
          slug: "test-hive",
          type: "digital",
          description: null,
        }];
      }
      if (query.includes("INSERT INTO goals")) {
        return [{ id: "goal-1" }];
      }
      return [];
    });
    mocks.tx.unsafe.mockReset();
    mocks.tx.json.mockImplementation((value: unknown) => value);
  });

  it("creates the hive and required setup records in one server-side setup call", async () => {
    mocks.tx.unsafe.mockResolvedValueOnce([{ slug: "dev-agent" }]);

    const res = await POST(setupRequest({
      hive: { name: "Test Hive", slug: "test-hive", type: "digital" },
      roleOverrides: {
        "dev-agent": { adapterType: "codex", recommendedModel: "openai-codex/gpt-5.5" },
      },
      connectors: [{
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        fields: {
          webhookUrl: "https://example.test/webhook",
          defaultUsername: "HiveWright",
        },
      }],
      projects: [{ name: "Website", slug: "website" }],
      initialGoal: "Ship the first owner workflow",
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ id: "hive-1", name: "Test Hive", slug: "test-hive", type: "digital" });
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.mkdirSync).toHaveBeenCalledWith(configuredHivePath("test-hive", "projects"), { recursive: true });
    expect(mocks.mkdirSync).toHaveBeenCalledWith(configuredHivePath("test-hive", "skills"), { recursive: true });
    expect(mocks.mkdirSync).toHaveBeenCalledWith(configuredHivePath("test-hive", "ea"), { recursive: true });
    expect(mocks.seedDefaultSchedules).toHaveBeenCalledWith(mocks.tx, {
      id: "hive-1",
      name: "Test Hive",
      description: null,
    }, {
      enabled: true,
    });
    expect(mocks.tx).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining("SELECT id FROM adapter_config WHERE adapter_type = ")]),
      "dispatcher",
    );
    expect(mocks.tx.json).toHaveBeenCalledWith({ maxConcurrentTasks: 3, setupPreset: "owner-setup" });
    expect(mocks.tx.json).toHaveBeenCalledWith(expect.objectContaining({ setupPreset: "balanced", confidenceThreshold: 0.6 }));
    expect(mocks.tx.json).toHaveBeenCalledWith({ enabled: true, prepareOnSetup: true, setupPreset: "ready" });
    expect(mocks.tx.unsafe).toHaveBeenCalledWith(
      "UPDATE role_templates SET adapter_type = $1, recommended_model = $2 WHERE slug = $3 RETURNING slug",
      ["codex", "openai-codex/gpt-5.5", "dev-agent"],
    );
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      mocks.tx,
      expect.objectContaining({ hiveId: "hive-1", value: JSON.stringify({ webhookUrl: "https://example.test/webhook" }) }),
    );
  });

  it("uses HIVES_WORKSPACE_ROOT for hive and project setup folders", async () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-setup-hives";

    const res = await POST(setupRequest({
      hive: { name: "Test Hive", slug: "test-hive", type: "digital" },
      projects: [{ name: "Website", slug: "website" }],
    }));

    expect(res.status).toBe(201);
    expect(mocks.tx.mock.calls[0]).toContain("/tmp/hw-setup-hives/test-hive/projects");
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/tmp/hw-setup-hives/test-hive/projects", { recursive: true });
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/tmp/hw-setup-hives/test-hive/skills", { recursive: true });
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/tmp/hw-setup-hives/test-hive/ea", { recursive: true });
    expect(mocks.mkdirSync).toHaveBeenCalledWith("/tmp/hw-setup-hives/test-hive/projects/website", { recursive: true });
  });

  it("fails the whole setup when a selected connector is incomplete", async () => {
    const res = await POST(setupRequest({
      hive: { name: "Test Hive", slug: "test-hive", type: "digital" },
      connectors: [{
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        fields: {},
      }],
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Please complete Webhook URL before creating this hive.");
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.storeCredential).not.toHaveBeenCalled();
  });

  it("persists customized operating preferences at the setup API boundary", async () => {
    const res = await POST(setupRequest({
      hive: { name: "Test Hive", slug: "test-hive", type: "digital" },
      operatingPreferences: {
        maxConcurrentAgents: 6,
        proactiveWork: false,
        memorySearch: false,
        requestSorting: "goals",
      },
    }));

    expect(res.status).toBe(201);
    expect(mocks.seedDefaultSchedules).toHaveBeenCalledWith(mocks.tx, {
      id: "hive-1",
      name: "Test Hive",
      description: null,
    }, {
      enabled: false,
    });
    expect(mocks.tx.json).toHaveBeenCalledWith({ maxConcurrentTasks: 6, setupPreset: "owner-setup" });
    expect(mocks.tx.json).toHaveBeenCalledWith(expect.objectContaining({ setupPreset: "goals", confidenceThreshold: 0.75 }));
    expect(mocks.tx.json).toHaveBeenCalledWith({ enabled: false, prepareOnSetup: false, setupPreset: "off" });
  });

  it("rejects duplicate hive addresses before setup starts", async () => {
    mocks.sql.mockResolvedValueOnce([{ id: "existing-hive" }]);

    const res = await POST(setupRequest({
      hive: { name: "Test Hive", slug: "test-hive", type: "digital" },
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("That hive address is already in use. Please choose a different hive name or custom hive address.");
    expect(mocks.sql.begin).not.toHaveBeenCalled();
    expect(mocks.mkdirSync).not.toHaveBeenCalled();
  });

  it("fails the whole setup when a role override targets a missing role", async () => {
    mocks.tx.unsafe.mockResolvedValueOnce([]);

    const res = await POST(setupRequest({
      hive: { name: "Test Hive", slug: "test-hive", type: "digital" },
      roleOverrides: {
        "ghost-role": { adapterType: "codex", recommendedModel: "openai-codex/gpt-5.5" },
      },
      connectors: [{
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        fields: { webhookUrl: "https://example.test/webhook" },
      }],
      initialGoal: "Goal that should not persist",
    }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.data).toBeUndefined();
    expect(body.error).toBe("A selected role could not be updated. Please review the runtime choices and try again.");
    expect(mocks.sql.begin).toHaveBeenCalledTimes(1);
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    const queries = mocks.tx.mock.calls
      .map((call: unknown[]) => (Array.isArray(call[0]) ? (call[0] as string[]).join(" ") : ""))
      .join("\n");
    expect(queries).not.toMatch(/INSERT INTO connector_installs/);
    expect(queries).not.toMatch(/INSERT INTO goals/);
  });
});
