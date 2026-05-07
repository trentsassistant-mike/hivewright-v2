import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { assessBudget } from "@/voice/budget";

describe("assessBudget", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`INSERT INTO hives (id, slug, name, type) VALUES ('00000000-0000-0000-0000-000000000001', 'test', 'Test', 'real')`;
  });

  it("returns warn=false when monthly spend below 80%", async () => {
    const r = await assessBudget("00000000-0000-0000-0000-000000000001", {
      monthlyLlmCap: 10000,
    });
    expect(r.warn).toBe(false);
    expect(r.model).toBe("opus");
    expect(r.pause).toBe(false);
  });

  it("warns at >=80% spend", async () => {
    await sql`INSERT INTO voice_sessions (hive_id, llm_cost_cents, started_at) VALUES ('00000000-0000-0000-0000-000000000001', 8500, NOW())`;
    const r = await assessBudget("00000000-0000-0000-0000-000000000001", {
      monthlyLlmCap: 10000,
    });
    expect(r.warn).toBe(true);
    expect(r.model).toBe("opus");
  });

  it("downgrades to sonnet at >=100%", async () => {
    await sql`INSERT INTO voice_sessions (hive_id, llm_cost_cents, started_at) VALUES ('00000000-0000-0000-0000-000000000001', 10100, NOW())`;
    const r = await assessBudget("00000000-0000-0000-0000-000000000001", {
      monthlyLlmCap: 10000,
    });
    expect(r.model).toBe("sonnet");
  });

  it("pauses at >=120%", async () => {
    await sql`INSERT INTO voice_sessions (hive_id, llm_cost_cents, started_at) VALUES ('00000000-0000-0000-0000-000000000001', 12100, NOW())`;
    const r = await assessBudget("00000000-0000-0000-0000-000000000001", {
      monthlyLlmCap: 10000,
    });
    expect(r.pause).toBe(true);
  });
});
