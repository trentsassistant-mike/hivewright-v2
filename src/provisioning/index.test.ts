import { describe, expect, it } from "vitest";
import { provisionerFor } from "./index";
import { isCodexCompatibleModel } from "./codex";
import { GeminiProvisioner } from "./gemini";

describe("provisionerFor", () => {
  it("resolves the Gemini CLI provisioner", () => {
    expect(provisionerFor("gemini")).toBeInstanceOf(GeminiProvisioner);
  });
});

describe("isCodexCompatibleModel", () => {
  it("allows internal Codex aliases", () => {
    expect(isCodexCompatibleModel("openai-codex/gpt-5.5")).toBe(true);
  });

  it("rejects non-Codex provider model ids", () => {
    expect(isCodexCompatibleModel("anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isCodexCompatibleModel("mistral/mistral-large-latest")).toBe(false);
  });
});
