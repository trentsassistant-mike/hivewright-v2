import { describe, it, expect } from "vitest";

// Pure-function tests for the codex supervisor backend. The startGoalSupervisor /
// wakeUpSupervisor entry points spawn a real codex CLI subprocess so we don't
// exercise them in unit tests — that path is verified live via dispatcher logs.
//
// Here we focus on the selector behaviour and the thread_id extractor.

describe("supervisor-codex extractThreadId behaviour (via JSONL parsing)", () => {
  it("pulls thread_id from a thread.started event", async () => {
    const { extractThreadIdForTest } = await import("./supervisor-codex-helpers");
    const stdout = [
      '{"type":"thread.started","thread_id":"abc-123-uuid"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(extractThreadIdForTest(stdout)).toBe("abc-123-uuid");
  });

  it("returns null when no thread.started event is present", async () => {
    const { extractThreadIdForTest } = await import("./supervisor-codex-helpers");
    const stdout = '{"type":"turn.completed"}';
    expect(extractThreadIdForTest(stdout)).toBeNull();
  });

  it("ignores malformed JSONL lines instead of throwing", async () => {
    const { extractThreadIdForTest } = await import("./supervisor-codex-helpers");
    const stdout = 'garbage line\n{not valid json\n{"type":"thread.started","thread_id":"good-uuid"}';
    expect(extractThreadIdForTest(stdout)).toBe("good-uuid");
  });
});
