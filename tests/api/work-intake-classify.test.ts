import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let stubOutcome: unknown = null;
vi.mock("@/work-intake/runner", () => ({
  runClassifier: vi.fn(async () => stubOutcome),
}));

let POST: typeof import("@/app/api/work-intake/classify/route").POST;

beforeEach(async () => {
  await truncateAll(sql);
  ({ POST } = await import("@/app/api/work-intake/classify/route"));
});

function req(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/work-intake/classify", () => {
  it("returns 400 when input missing", async () => {
    const res = await POST(req("http://localhost/api/work-intake/classify", {}));
    expect(res.status).toBe(400);
  });

  it("returns the classifier outcome and does not write to DB when dryRun=true", async () => {
    stubOutcome = {
      result: { type: "task", role: "dev-agent", confidence: 0.9, reasoning: "x" },
      attempts: [{ provider: "ollama", model: "qwen3:32b", prompt: "p", input: "x",
        responseRaw: "", tokensIn: 10, tokensOut: 5, costCents: 0, latencyMs: 100, success: true, errorReason: null }],
      usedFallback: false, providerUsed: "ollama", modelUsed: "qwen3:32b",
    };

    const res = await POST(req("http://localhost/api/work-intake/classify?dryRun=true", { input: "fix typo" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.result.type).toBe("task");
    expect(body.data.result.role).toBe("dev-agent");
    expect(body.data.provider).toBe("ollama");
    expect(body.data.latencyMs).toBe(100);

    const logs = await sql`SELECT count(*)::int AS n FROM classifier_logs`;
    expect(logs[0].n).toBe(0);
  });
});
