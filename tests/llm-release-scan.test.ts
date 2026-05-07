import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "./_lib/test-db";
import { runLlmReleaseScan } from "@/llm-release-scan";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type, description)
    VALUES ('llm-release-scan-test', 'LLM Release Scan Test', 'digital', 'scan test')
    RETURNING id
  `;
  hiveId = hive.id;
});

describe("runLlmReleaseScan", () => {
  it("creates an owner-gated Tier-2 decision and visible run record for newly detected models", async () => {
    const result = await runLlmReleaseScan(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId: "11111111-1111-1111-1111-111111111111" },
    }, {
      now: new Date("2026-04-25T00:00:00.000Z"),
      fetchSource: async (url) => ({
        ok: true,
        status: 200,
        text: url.includes("openai")
          ? "OpenAI models: gpt-9.1. Pricing for gpt-9.1 is $1.20 per 1M input tokens and $8.40 per 1M output tokens."
          : "No new model ids on this source.",
      }),
    });

    expect(result.newModelsDetected).toBe(1);
    expect(result.decisionsCreated).toBe(1);
    expect(result.heartbeatRecorded).toBe(false);
    expect(result.sourceEvidence.find((source) => source.provider === "openai")).toMatchObject({
      researchMethod: "direct-fetch",
    });
    expect(result.candidates[0]).toMatchObject({
      provider: "openai",
      modelId: "openai/gpt-9.1",
      pricing: {
        inputPer1MTokensUsd: 1.2,
        outputPer1MTokensUsd: 8.4,
      },
      proposedPatchTargets: [
        "src/adapters/provider-config.ts",
        "src/app/(dashboard)/roles/page.tsx",
        "src/app/(dashboard)/setup/adapters/page.tsx",
        "src/app/(dashboard)/hives/new/page.tsx",
      ],
    });

    const [run] = await sql<Array<{
      trigger_type: string;
      status: string;
      evaluated_candidates: number;
      created_decisions: number;
      noop_count: number;
    }>>`
      SELECT trigger_type, status, evaluated_candidates, created_decisions, noop_count
      FROM initiative_runs
      WHERE id = ${result.runId}::uuid
    `;
    expect(run).toEqual({
      trigger_type: "llm-release-scan",
      status: "completed",
      evaluated_candidates: 1,
      created_decisions: 1,
      noop_count: 0,
    });

    const [decisionRecord] = await sql<Array<{
      action_taken: string;
      candidate_ref: string;
      evidence: {
        candidate: { provider: string; modelId: string; sourceUrls: string[] };
        governance: {
          tier: number;
          autoApprovable: boolean;
          ownerGatedPatch: boolean;
          autoApply: boolean;
        };
      };
      created_decision_id: string;
    }>>`
      SELECT action_taken, candidate_ref, evidence, created_decision_id
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}::uuid
    `;
    expect(decisionRecord.action_taken).toBe("decision");
    expect(decisionRecord.candidate_ref).toBe("openai/gpt-9.1");
    expect(decisionRecord.evidence.candidate.provider).toBe("openai");
    expect(decisionRecord.evidence.candidate.sourceUrls).toContain("https://platform.openai.com/docs/models");
    expect(decisionRecord.evidence.governance).toEqual({
      tier: 2,
      autoApprovable: true,
      ownerGatedPatch: true,
      autoApply: false,
    });

    const [decision] = await sql<Array<{
      status: string;
      kind: string;
      context: string;
      recommendation: string;
      options: { kind: string; modelProposal: { source: string; modelId: string; autoApply: boolean } };
    }>>`
      SELECT status, kind, context, recommendation, options
      FROM decisions
      WHERE id = ${decisionRecord.created_decision_id}::uuid
    `;
    expect(decision.status).toBe("pending");
    expect(decision.kind).toBe("release_scan_model_proposal");
    expect(decision.context).toContain("\"modelId\": \"openai/gpt-9.1\"");
    expect(decision.context).toContain("\"autoApply\": false");
    expect(decision.options.modelProposal).toMatchObject({
      source: "release-scan",
      modelId: "openai/gpt-9.1",
      autoApply: false,
    });
    expect(decision.recommendation).toContain("do not auto-apply");
  });

  it("records an explicit heartbeat when no unregistered models are found", async () => {
    const result = await runLlmReleaseScan(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId: "22222222-2222-2222-2222-222222222222" },
    }, {
      now: new Date("2026-04-25T01:00:00.000Z"),
      fetchSource: async () => ({
        ok: true,
        status: 200,
        text: "The currently listed model is gpt-5.5 with no newer ids on this source.",
      }),
    });

    expect(result.newModelsDetected).toBe(0);
    expect(result.decisionsCreated).toBe(0);
    expect(result.heartbeatRecorded).toBe(true);

    const [run] = await sql<Array<{
      status: string;
      evaluated_candidates: number;
      created_decisions: number;
      noop_count: number;
    }>>`
      SELECT status, evaluated_candidates, created_decisions, noop_count
      FROM initiative_runs
      WHERE id = ${result.runId}::uuid
    `;
    expect(run).toEqual({
      status: "completed",
      evaluated_candidates: 0,
      created_decisions: 0,
      noop_count: 1,
    });

    const [heartbeat] = await sql<Array<{
      action_taken: string;
      rationale: string;
      evidence: {
        kind: string;
        heartbeat: boolean;
        checkedProviders: string[];
        sourceEvidence: Array<{ provider: string; url: string; status: string }>;
      };
    }>>`
      SELECT action_taken, rationale, evidence
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}::uuid
    `;
    expect(heartbeat.action_taken).toBe("noop");
    expect(heartbeat.rationale).toMatch(/no unregistered candidate models/);
    expect(heartbeat.evidence.kind).toBe("llm-release-scan-heartbeat");
    expect(heartbeat.evidence.heartbeat).toBe(true);
    expect(heartbeat.evidence.checkedProviders).toEqual([
      "anthropic",
      "openai",
      "google",
      "meta",
      "mistral",
      "xai",
    ]);
    expect(heartbeat.evidence.sourceEvidence).toHaveLength(12);

    const decisions = await sql`SELECT id FROM decisions WHERE hive_id = ${hiveId}`;
    expect(decisions).toHaveLength(0);
  });

  it("accepts agent WebSearch evidence as the production research source", async () => {
    const result = await runLlmReleaseScan(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId: "33333333-3333-3333-3333-333333333333" },
    }, {
      now: new Date("2026-04-25T02:00:00.000Z"),
      researchOfficialSources: async () => [{
        provider: "openai",
        url: "https://platform.openai.com/docs/models",
        ok: true,
        researchMethod: "agent-web-search",
        text: "Official WebSearch evidence: model gpt-9.2. Input $2.00 per 1M input tokens. Output $9.00 per 1M output tokens.",
      }],
    });

    expect(result.newModelsDetected).toBe(1);
    expect(result.sourceEvidence).toEqual([
      expect.objectContaining({
        provider: "openai",
        url: "https://platform.openai.com/docs/models",
        status: "ok",
        researchMethod: "agent-web-search",
        discoveredModelIds: ["openai/gpt-9.2"],
      }),
    ]);
    expect(result.candidates[0]).toMatchObject({
      modelId: "openai/gpt-9.2",
      pricing: {
        inputPer1MTokensUsd: 2,
        outputPer1MTokensUsd: 9,
      },
    });
  });
});
