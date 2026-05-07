import { afterEach, describe, it, expect } from "vitest";
import { runPreFlightChecks } from "@/dispatcher/pre-flight";
import type { SessionContext } from "@/adapters/types";

const originalOpenAIKey = process.env.OPENAI_API_KEY;
const originalCodexAuthFile = process.env.CODEX_AUTH_FILE;

afterEach(() => {
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
  if (originalCodexAuthFile === undefined) {
    delete process.env.CODEX_AUTH_FILE;
  } else {
    process.env.CODEX_AUTH_FILE = originalCodexAuthFile;
  }
});

describe("runPreFlightChecks", () => {
  it("passes when no workspace is required", async () => {
    const ctx = {
      task: { id: "t1", assignedTo: "dev-agent" },
      roleTemplate: { slug: "dev-agent" },
      projectWorkspace: null,
      model: "anthropic/claude-sonnet-4-6",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when workspace path does not exist", async () => {
    const ctx = {
      task: { id: "t2", assignedTo: "dev-agent" },
      roleTemplate: { slug: "dev-agent" },
      projectWorkspace: "/nonexistent/path/that/should/not/exist",
      model: "anthropic/claude-sonnet-4-6",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("workspace"))).toBe(true);
  });

  it("fails when model is empty", async () => {
    const ctx = {
      task: { id: "t3", assignedTo: "dev-agent" },
      roleTemplate: { slug: "dev-agent" },
      projectWorkspace: null,
      model: "",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes("model"))).toBe(true);
  });

  it("passes with valid workspace path", async () => {
    const ctx = {
      task: { id: "t4", assignedTo: "dev-agent" },
      roleTemplate: { slug: "dev-agent" },
      projectWorkspace: "/tmp",
      model: "anthropic/claude-sonnet-4-6",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(true);
  });

  it("fails clearly when OpenAI Images API auth is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.CODEX_AUTH_FILE = "/tmp/hw-missing-codex-auth.json";
    const ctx = {
      task: { id: "t5", assignedTo: "image-designer" },
      roleTemplate: {
        slug: "image-designer",
        toolsMd: "",
      },
      projectWorkspace: null,
      model: "gpt-image-2",
      primaryAdapterType: "openai-image",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toContain("Missing required OpenAI Images API auth");
    expect(result.failures.join("\n")).toContain("OPENAI_API_KEY");
  });

  it("passes for image-designer when OPENAI_API_KEY is present", async () => {
    process.env.OPENAI_API_KEY = "sk-test-image-key";
    const ctx = {
      task: { id: "t6", assignedTo: "image-designer" },
      roleTemplate: {
        slug: "image-designer",
        toolsMd: "requires: [OPENAI_API_KEY]",
      },
      projectWorkspace: null,
      model: "gpt-image-2",
      primaryAdapterType: "openai-image",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("rejects Codex-managed ChatGPT auth for direct Images API without leaking tokens", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.CODEX_AUTH_FILE = "/tmp/hw-missing-codex-auth.json";
    const ctx = {
      task: { id: "t7", assignedTo: "image-designer" },
      roleTemplate: {
        slug: "image-designer",
        toolsMd: "requires: [OPENAI_API_KEY]",
      },
      projectWorkspace: null,
      model: "gpt-image-2",
      primaryAdapterType: "openai-image",
      credentials: {},
    } as unknown as SessionContext;

    const result = await runPreFlightChecks(ctx);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).not.toContain("codex-oauth-token");
  });
});
