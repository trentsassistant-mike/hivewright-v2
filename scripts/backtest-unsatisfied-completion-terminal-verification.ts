import postgres from "postgres";
import { getTerminalVerificationDecision } from "../src/supervisor/scan";

type UnsatRow = {
  report_id: string;
  ran_at: Date;
  task_id: string;
  assigned_to: string;
  title: string;
  brief: string;
  result_summary: string | null;
  failure_reason: string | null;
  has_work_product: boolean;
};

type Example = {
  taskId: string;
  role: string;
  title: string;
  proofOnly: boolean;
  implementationCue: boolean;
  hasWorkProduct: boolean;
  hasFailureReason: boolean;
};

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://hivewright:placeholder@localhost:5432/hivewrightv2";

const sql = postgres(DATABASE_URL);

async function main() {
  const rows = await sql<UnsatRow[]>`
    SELECT
      r.id AS report_id,
      r.ran_at,
      split_part(f.value->>'id', ':', 2) AS task_id,
      t.assigned_to,
      t.title,
      t.brief,
      t.result_summary,
      t.failure_reason,
      EXISTS (SELECT 1 FROM work_products wp WHERE wp.task_id = t.id) AS has_work_product
    FROM supervisor_reports r
    CROSS JOIN LATERAL jsonb_array_elements(r.report->'findings') f(value)
    JOIN tasks t ON t.id = split_part(f.value->>'id', ':', 2)::uuid
    WHERE r.ran_at > NOW() - interval '30 days'
      AND f.value->>'kind' = 'unsatisfied_completion'
    ORDER BY r.ran_at DESC, task_id
  `;

  const uniqueTasks = new Map<string, UnsatRow>();
  for (const row of rows) {
    if (!uniqueTasks.has(row.task_id)) {
      uniqueTasks.set(row.task_id, row);
    }
  }

  let suppressedReportInstances = 0;
  const suppressedExamples: Example[] = [];
  const keptVerificationExamples: Example[] = [];
  const byRole = new Map<
    string,
    {
      reportInstances: number;
      distinctTasks: number;
      suppressedReportInstances: number;
      suppressedDistinctTasks: number;
    }
  >();

  for (const row of rows) {
    const decision = getTerminalVerificationDecision({
      title: row.title,
      brief: row.brief,
      hasWorkProduct: row.has_work_product,
      failureReason: row.failure_reason,
    });
    const bucket = byRole.get(row.assigned_to) ?? {
      reportInstances: 0,
      distinctTasks: 0,
      suppressedReportInstances: 0,
      suppressedDistinctTasks: 0,
    };
    bucket.reportInstances += 1;
    if (decision.eligible) {
      suppressedReportInstances += 1;
      bucket.suppressedReportInstances += 1;
    }
    byRole.set(row.assigned_to, bucket);
  }

  for (const row of uniqueTasks.values()) {
    const decision = getTerminalVerificationDecision({
      title: row.title,
      brief: row.brief,
      hasWorkProduct: row.has_work_product,
      failureReason: row.failure_reason,
    });
    const bucket = byRole.get(row.assigned_to);
    if (bucket) {
      bucket.distinctTasks += 1;
      if (decision.eligible) {
        bucket.suppressedDistinctTasks += 1;
      }
    }
    const example: Example = {
      taskId: row.task_id,
      role: row.assigned_to,
      title: row.title,
      proofOnly: decision.proofOnly,
      implementationCue: decision.implementationCue,
      hasWorkProduct: row.has_work_product,
      hasFailureReason: row.failure_reason !== null,
    };
    if (decision.eligible && suppressedExamples.length < 5) {
      suppressedExamples.push(example);
    } else if (
      !decision.eligible
      && decision.verificationLike
      && keptVerificationExamples.length < 5
    ) {
      keptVerificationExamples.push(example);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    counts: {
      unsatisfiedCompletionReportInstances: rows.length,
      unsatisfiedCompletionDistinctTasks: uniqueTasks.size,
      suppressedReportInstances,
      suppressedDistinctTasks: Array.from(uniqueTasks.values()).filter((row) =>
        getTerminalVerificationDecision({
          title: row.title,
          brief: row.brief,
          hasWorkProduct: row.has_work_product,
          failureReason: row.failure_reason,
        }).eligible,
      ).length,
      remainingDistinctTasks: Array.from(uniqueTasks.values()).filter((row) =>
        !getTerminalVerificationDecision({
          title: row.title,
          brief: row.brief,
          hasWorkProduct: row.has_work_product,
          failureReason: row.failure_reason,
        }).eligible,
      ).length,
    },
    byRole: Object.fromEntries(
      Array.from(byRole.entries()).sort(([a], [b]) => a.localeCompare(b)),
    ),
    examples: {
      suppressed: suppressedExamples,
      keptVerificationCases: keptVerificationExamples,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
