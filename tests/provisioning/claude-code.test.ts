import { describe, it, expect } from "vitest";
import { ClaudeCodeProvisioner } from "../../src/provisioning/claude-code";

describe("ClaudeCodeProvisioner", () => {
  it("is always satisfied", async () => {
    const p = new ClaudeCodeProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "claude-sonnet-4-6" });
    expect(status.satisfied).toBe(true);
    expect(status.fixable).toBe(true);
  });

  it("provision yields done immediately", async () => {
    const p = new ClaudeCodeProvisioner();
    const events = [];
    for await (const ev of p.provision({ slug: "dev-agent", recommendedModel: "claude-sonnet-4-6" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("done");
  });
});
