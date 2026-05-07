import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildQualityExtractionPrompt,
  extractImplicitQualitySignals,
  matchSignalToTask,
  parseQualityExtractionResponse,
  type RecentCompletedTask,
} from "@/quality/extractor";
import type { ModelCallerConfig } from "@/memory/model-caller";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const HIVE_B = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const TASK_DASHBOARD = "10000000-0000-4000-8000-000000000001";
const TASK_NAV = "10000000-0000-4000-8000-000000000002";
const OWNER_MESSAGE = "20000000-0000-4000-8000-000000000001";

function modelConfig(payload: unknown): ModelCallerConfig {
  return {
    ollamaUrl: "http://localhost:11434",
    generationModel: "mistral",
    embeddingModel: "all-minilm",
    fetchFn: vi.fn(async () =>
      new Response(JSON.stringify({ response: JSON.stringify(payload) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch,
  };
}

async function seedTask(input: {
  id: string;
  hiveId: string;
  title: string;
  brief: string;
  resultSummary?: string;
  completedAt?: string;
  workProduct?: string;
}) {
  await sql`
    INSERT INTO tasks (
      id,
      hive_id,
      assigned_to,
      created_by,
      status,
      priority,
      title,
      brief,
      result_summary,
      completed_at,
      qa_required
    )
    VALUES (
      ${input.id},
      ${input.hiveId},
      'dev-agent',
      'test',
      'completed',
      5,
      ${input.title},
      ${input.brief},
      ${input.resultSummary ?? null},
      ${input.completedAt ?? "2026-04-26T00:00:00.000Z"},
      false
    )
  `;

  if (input.workProduct) {
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, summary)
      VALUES (${input.id}, ${input.hiveId}, 'dev-agent', ${input.workProduct}, ${input.workProduct})
    `;
  }
}

async function readSignals() {
  return sql<
    {
      task_id: string;
      hive_id: string;
      signal_type: string;
      source: string;
      evidence: string;
      confidence: number;
      owner_message_id: string | null;
    }[]
  >`
    SELECT task_id, hive_id, signal_type, source, evidence, confidence, owner_message_id
    FROM task_quality_signals
    ORDER BY created_at ASC
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_A}, 'quality-a', 'Quality A', 'digital'),
      (${HIVE_B}, 'quality-b', 'Quality B', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('doctor', 'Quality Doctor', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("parseQualityExtractionResponse", () => {
  it("parses ADD and NOOP quality extraction output", () => {
    const parsed = parseQualityExtractionResponse(
      '```json\n{"signals":[{"operation":"ADD","signalType":"positive","evidence":"worked great","confidence":0.9},{"operation":"NOOP","reason":"unrelated"}]}\n```',
    );

    expect(parsed.signals).toHaveLength(2);
    expect(parsed.signals[0]).toMatchObject({
      operation: "ADD",
      signalType: "positive",
      evidence: "worked great",
      confidence: 0.9,
    });
    expect(parsed.signals[1]).toMatchObject({ operation: "NOOP" });
  });

  it("includes owner text in the classifier prompt", () => {
    expect(buildQualityExtractionPrompt("that dashboard fix worked great")).toContain(
      "that dashboard fix worked great",
    );
  });
});

describe("extractImplicitQualitySignals", () => {
  it("stores positive praise for a matching recent completed task", async () => {
    await seedTask({
      id: TASK_DASHBOARD,
      hiveId: HIVE_A,
      title: "Fix dashboard EA chat duplicate messages",
      brief: "Stop duplicate messages in the dashboard EA chat",
      workProduct: "Dashboard EA chat duplicate message fix shipped.",
    });
    const [thread] = await sql<{ id: string }[]>`
      INSERT INTO ea_threads (hive_id, channel_id, status)
      VALUES (${HIVE_A}, 'test-quality', 'active')
      RETURNING id
    `;
    await sql`
      INSERT INTO ea_messages (id, thread_id, role, content, source)
      VALUES (${OWNER_MESSAGE}, ${thread.id}, 'owner', 'that dashboard EA chat fix worked great', 'dashboard')
    `;

    const result = await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "that dashboard EA chat fix worked great",
        ownerMessageId: OWNER_MESSAGE,
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      modelConfig({
        signals: [
          {
            operation: "ADD",
            signalType: "positive",
            evidence: "dashboard EA chat fix worked great",
            confidence: 0.92,
            taskReference: "dashboard EA chat fix",
          },
        ],
      }),
    );

    expect(result.storedSignals).toHaveLength(1);
    const rows = await readSignals();
    expect(rows).toEqual([
      expect.objectContaining({
        task_id: TASK_DASHBOARD,
        hive_id: HIVE_A,
        signal_type: "positive",
        source: "implicit_ea",
        evidence: "dashboard EA chat fix worked great",
        owner_message_id: OWNER_MESSAGE,
      }),
    ]);
  });

  it("stores negative criticism for matching recent work", async () => {
    await seedTask({
      id: TASK_NAV,
      hiveId: HIVE_A,
      title: "Repair tasks page navigation",
      brief: "Fix broken navigation on /tasks",
      workProduct: "Tasks page navigation repair.",
    });

    await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "the tasks navigation is broken since that repair",
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      modelConfig({
        signals: [
          {
            operation: "ADD",
            signalType: "negative",
            evidence: "tasks navigation is broken",
            confidence: 0.88,
            taskReference: "tasks navigation",
          },
        ],
      }),
    );

    expect((await readSignals())[0]).toMatchObject({
      task_id: TASK_NAV,
      signal_type: "negative",
      evidence: "tasks navigation is broken",
    });
  });

  it("stores a neutral reference for a matching recent task", async () => {
    await seedTask({
      id: TASK_DASHBOARD,
      hiveId: HIVE_A,
      title: "Add dashboard live agent panel",
      brief: "Surface live agents on the dashboard",
      workProduct: "Dashboard live agent panel added.",
    });

    await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "about the dashboard live agent panel from yesterday",
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      modelConfig({
        signals: [
          {
            operation: "ADD",
            signalType: "neutral",
            evidence: "dashboard live agent panel from yesterday",
            confidence: 0.78,
            taskReference: "dashboard live agent panel",
          },
        ],
      }),
    );

    expect((await readSignals())[0]).toMatchObject({
      task_id: TASK_DASHBOARD,
      signal_type: "neutral",
    });
  });

  it("does not store unrelated NOOP owner messages", async () => {
    await seedTask({
      id: TASK_DASHBOARD,
      hiveId: HIVE_A,
      title: "Fix dashboard EA chat duplicate messages",
      brief: "Stop duplicate messages in the dashboard EA chat",
    });

    await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "what is on my calendar today?",
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      modelConfig({ signals: [{ operation: "NOOP", reason: "unrelated" }] }),
    );

    expect(await readSignals()).toEqual([]);
  });

  it("does not call the model or store rows when no recent task can match", async () => {
    await seedTask({
      id: TASK_DASHBOARD,
      hiveId: HIVE_A,
      title: "Old dashboard EA chat fix",
      brief: "Completed too long ago",
      completedAt: "2026-04-01T00:00:00.000Z",
    });
    const config = modelConfig({
      signals: [
        {
          operation: "ADD",
          signalType: "positive",
          evidence: "dashboard fix worked great",
          confidence: 0.95,
        },
      ],
    });

    const result = await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "dashboard fix worked great",
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      config,
    );

    expect(result.candidateTasks).toEqual([]);
    expect(config.fetchFn).not.toHaveBeenCalled();
    expect(await readSignals()).toEqual([]);
  });

  it("respects hive scoping when a different hive has similar recent work", async () => {
    await seedTask({
      id: TASK_DASHBOARD,
      hiveId: HIVE_B,
      title: "Fix dashboard EA chat duplicate messages",
      brief: "Stop duplicate messages in the dashboard EA chat",
    });

    await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "dashboard EA chat fix worked great",
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      modelConfig({
        signals: [
          {
            operation: "ADD",
            signalType: "positive",
            evidence: "dashboard EA chat fix worked great",
            confidence: 0.9,
          },
        ],
      }),
    );

    expect(await readSignals()).toEqual([]);
  });

  it("drops classifier outputs below the confidence threshold", async () => {
    await seedTask({
      id: TASK_DASHBOARD,
      hiveId: HIVE_A,
      title: "Fix dashboard EA chat duplicate messages",
      brief: "Stop duplicate messages in the dashboard EA chat",
    });

    await extractImplicitQualitySignals(
      sql,
      {
        hiveId: HIVE_A,
        ownerMessage: "maybe the dashboard chat fix was okay",
        now: new Date("2026-04-27T00:00:00.000Z"),
      },
      modelConfig({
        signals: [
          {
            operation: "ADD",
            signalType: "positive",
            evidence: "dashboard chat fix was okay",
            confidence: 0.54,
            taskReference: "dashboard chat fix",
          },
        ],
      }),
    );

    expect(await readSignals()).toEqual([]);
  });
});

describe("matchSignalToTask", () => {
  it("rejects ambiguous low-margin matches", () => {
    const tasks: RecentCompletedTask[] = [
      {
        id: "task-a",
        hiveId: HIVE_A,
        title: "Fix dashboard chat",
        brief: "Improve dashboard chat",
        resultSummary: null,
        completedAt: new Date(),
        workProductText: null,
      },
      {
        id: "task-b",
        hiveId: HIVE_A,
        title: "Repair dashboard chat",
        brief: "Improve dashboard chat",
        resultSummary: null,
        completedAt: new Date(),
        workProductText: null,
      },
    ];

    expect(
      matchSignalToTask(
        {
          operation: "ADD",
          signalType: "positive",
          evidence: "dashboard chat worked",
          confidence: 0.9,
        },
        tasks,
        "dashboard chat worked",
      ),
    ).toBeNull();
  });
});
