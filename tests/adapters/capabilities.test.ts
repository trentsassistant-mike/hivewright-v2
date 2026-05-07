import { describe, expect, it } from "vitest";
import { adapterSupports, getAdapterCapabilities } from "@/adapters/capabilities";

describe("adapter capability profiles", () => {
  it("marks only persistent-session adapters as resumable", () => {
    expect(adapterSupports("codex", "persistentSessions")).toBe(true);
    expect(adapterSupports("openclaw", "persistentSessions")).toBe(true);
    expect(adapterSupports("claude-code", "persistentSessions")).toBe(false);
    expect(adapterSupports("gemini", "persistentSessions")).toBe(false);
    expect(adapterSupports("ollama", "persistentSessions")).toBe(false);
    expect(adapterSupports("openai-image", "persistentSessions")).toBe(false);
  });

  it("returns conservative defaults for unknown adapters", () => {
    expect(getAdapterCapabilities("future-provider")).toEqual({
      persistentSessions: false,
      streaming: false,
      localRuntime: false,
      toolUse: false,
      worktreeContext: false,
      imageGeneration: false,
    });
  });

  it("captures local and image runtime capabilities separately", () => {
    expect(adapterSupports("ollama", "localRuntime")).toBe(true);
    expect(adapterSupports("openai-image", "imageGeneration")).toBe(true);
    expect(adapterSupports("codex", "imageGeneration")).toBe(false);
  });
});
