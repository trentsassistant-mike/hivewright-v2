import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import {
  shouldRunSynthesis,
  findCandidatePairs,
  runSynthesis,
} from "@/memory/synthesis";
import type { ModelCallerConfig } from "@/memory/model-caller";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  // syncRoleLibrary populates role_templates (needed for tasks.assigned_to FK)
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('p4-syn-test', 'P4 Synthesis Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;
});

async function createTaskAndWP(role: string, dept: string, content: string, summary: string) {
  const [task] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
    VALUES (${bizId}, ${role}, 'owner', ${'p4-syn-' + dept}, 'Test brief', 'completed')
    RETURNING *
  `;
  await sql`
    INSERT INTO work_products (task_id, hive_id, role_slug, department, content, summary, synthesized)
    VALUES (${task.id}, ${bizId}, ${role}, ${dept}, ${content}, ${summary}, false)
  `;
  return task.id;
}

describe("shouldRunSynthesis", () => {
  it("returns true when 5+ unsynthesized work products exist", async () => {
    for (let i = 0; i < 5; i++) {
      await createTaskAndWP("dev-agent", "engineering", `WP content ${i}`, `p4-syn-summary-${i}`);
    }
    const should = await shouldRunSynthesis(sql, bizId);
    expect(should).toBe(true);
  });

  it("returns false when fewer than 5 unsynthesized WPs and synthesis ran recently", async () => {
    await createTaskAndWP("dev-agent", "engineering", "Single WP", "p4-syn-single");
    // Simulate a recently synthesized WP (within the last 24h)
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'p4-syn-recent', 'Test brief', 'completed')
      RETURNING *
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, department, content, summary, synthesized, created_at)
      VALUES (${task.id}, ${bizId}, 'dev-agent', 'engineering', 'Already synthesized', 'p4-syn-synth', true, NOW())
    `;
    const should = await shouldRunSynthesis(sql, bizId);
    expect(should).toBe(false);
  });
});

describe("findCandidatePairs", () => {
  it("finds pairs from different departments", () => {
    const wps = [
      { id: "1", department: "engineering", content: "API handles 100 req/min", roleSlug: "dev-agent" },
      { id: "2", department: "marketing", content: "Traffic spikes during Easter", roleSlug: "content-writer" },
      { id: "3", department: "engineering", content: "Database optimized for reads", roleSlug: "dev-agent" },
    ];
    const pairs = findCandidatePairs(wps);
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(pair[0].department).not.toBe(pair[1].department);
    }
  });
});

describe("runSynthesis", () => {
  it("discovers insights from cross-department work products and marks WPs synthesized", async () => {
    await createTaskAndWP("dev-agent", "engineering", "API rate limit is 100/min, batch mode supported", "p4-syn-eng-wp");
    await createTaskAndWP("research-analyst", "marketing", "Competitor offers unlimited API calls as selling point", "p4-syn-mkt-wp");
    await createTaskAndWP("dev-agent", "engineering", "Server capacity at 60%", "p4-syn-eng-wp2");
    await createTaskAndWP("content-writer", "marketing", "Customer feedback mentions slow API", "p4-syn-mkt-wp2");
    await createTaskAndWP("bookkeeper", "finance", "API provider costs $500/month", "p4-syn-fin-wp");

    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        response: JSON.stringify({
          hasInsight: true,
          content: "p4-syn-API rate limit may be causing customer complaints while competitor has no limits",
          connectionType: "opportunity",
          confidence: 0.75,
          affectedDepartments: ["engineering", "marketing"],
        }),
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    const modelConfig: ModelCallerConfig = {
      ollamaUrl: "http://localhost:11434",
      generationModel: "mistral",
      embeddingModel: "all-minilm",
      fetchFn: mockFetch as unknown as typeof fetch,
    };

    const result = await runSynthesis(sql, bizId, modelConfig);
    expect(result.insightsCreated).toBeGreaterThanOrEqual(1);

    const insights = await sql`SELECT * FROM insights WHERE content LIKE 'p4-syn-%'`;
    expect(insights.length).toBeGreaterThanOrEqual(1);

    const unsynthesized = await sql`
      SELECT COUNT(*)::int AS count FROM work_products
      WHERE hive_id = ${bizId} AND synthesized = false AND summary LIKE 'p4-syn-%'
    `;
    expect(unsynthesized[0].count).toBe(0);
  });
});
