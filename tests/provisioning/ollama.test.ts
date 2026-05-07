import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OllamaProvisioner } from "../../src/provisioning/ollama";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.OLLAMA_ENDPOINT = "http://ollama.test:11434";
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.OLLAMA_ENDPOINT;
  vi.restoreAllMocks();
});

describe("OllamaProvisioner.check", () => {
  it("returns satisfied when /api/tags lists the model", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "qwen3.5:27b" }] }),
    } as Response);

    const p = new OllamaProvisioner();
    const status = await p.check({ slug: "research-analyst", recommendedModel: "ollama/qwen3.5:27b" });
    expect(status.satisfied).toBe(true);
  });

  it("returns fixable=true when GPU reachable but model missing", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: "other-model" }] }),
    } as Response);

    const p = new OllamaProvisioner();
    const status = await p.check({ slug: "research-analyst", recommendedModel: "ollama/qwen3.5:27b" });
    expect(status.satisfied).toBe(false);
    expect(status.fixable).toBe(true);
    expect(status.reason).toMatch(/not pulled/i);
  });

  it("returns fixable=false when GPU unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const p = new OllamaProvisioner();
    const status = await p.check({ slug: "research-analyst", recommendedModel: "ollama/qwen3.5:27b" });
    expect(status.satisfied).toBe(false);
    expect(status.fixable).toBe(false);
    expect(status.reason).toMatch(/unreachable|offline/i);
  });
});

describe("OllamaProvisioner.provision", () => {
  it("yields pulling events and completes satisfied", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(JSON.stringify({ status: "pulling manifest" }) + "\n"));
        controller.enqueue(enc.encode(JSON.stringify({ status: "downloading", completed: 50, total: 100 }) + "\n"));
        controller.enqueue(enc.encode(JSON.stringify({ status: "success" }) + "\n"));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, body, status: 200 } as unknown as Response);

    const p = new OllamaProvisioner();
    const events = [];
    for await (const ev of p.provision({ slug: "r", recommendedModel: "ollama/qwen3.5:27b" })) {
      events.push(ev);
    }
    expect(events[0]).toMatchObject({ phase: "checking" });
    expect(events.some((e) => e.phase === "pulling" && (e as { percentComplete?: number }).percentComplete === 50)).toBe(true);
    expect(events.at(-1)).toMatchObject({ phase: "done", status: { satisfied: true } });
  });

  it("surfaces error frames as not-satisfied", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: "model not found" }) + "\n"));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({ ok: true, body, status: 200 } as unknown as Response);

    const p = new OllamaProvisioner();
    const events = [];
    for await (const ev of p.provision({ slug: "r", recommendedModel: "ollama/nonexistent" })) {
      events.push(ev);
    }
    expect(events.at(-1)).toMatchObject({ phase: "done", status: { satisfied: false } });
  });
});
