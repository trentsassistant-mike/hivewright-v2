import type { Sql } from "postgres";

export interface MalformedSupervisorEscalation {
  hiveId: string;
  /** The supervisor_reports row we've already persisted for this heartbeat. */
  reportId: string;
  /** Short, machine-readable reason from parseSupervisorActions. */
  reason: string;
  /** The agent's raw stdout — truncated before it hits decisions.context. */
  rawOutput: string;
}

/**
 * Raw-output cap for decisions.context. decisions.title is varchar(500);
 * context is TEXT so the real ceiling is much higher, but dumping 20k of
 * unrendered LLM slop into the Decisions UI is unhelpful. Keep a bounded
 * slice so the EA's context card stays readable.
 */
const RAW_OUTPUT_CAP = 4000;

/**
 * Malformed-output escalation hook for the supervisor runtime. Symmetrical
 * to `escalateMalformedDiagnosis` in `src/doctor/escalate.ts` (which handles
 * the doctor-path equivalent), but routes to the Hive Supervisor's
 * `supervisor_reports` audit row.
 *
 * **Governance contract (do not weaken):** the created decision row MUST
 * have `status='ea_review'`. Malformed supervisor output is a prompt/code
 * problem; the EA should attempt autonomous recovery (retry the scan,
 * downgrade to a heartbeat no-op, or escalate in plain English) before
 * anything reaches the owner's Decisions queue. See the
 * `decisions_via_ea_first` feedback memory. The parallel unit tests in
 * tests/supervisor/escalate-malformed.test.ts lock this in.
 */
export async function escalateMalformedSupervisorOutput(
  sql: Sql,
  input: MalformedSupervisorEscalation,
): Promise<void> {
  const { hiveId, reportId, reason, rawOutput } = input;

  const truncatedOutput =
    rawOutput.length > RAW_OUTPUT_CAP
      ? rawOutput.slice(0, RAW_OUTPUT_CAP) +
        `\n\n[... truncated ${rawOutput.length - RAW_OUTPUT_CAP} chars ...]`
      : rawOutput;

  const context = [
    "The Hive Supervisor produced output the runtime could not parse.",
    "",
    `Parse failure reason: ${reason}`,
    `Report ID: ${reportId}`,
    "",
    "Raw output (truncated):",
    "```",
    truncatedOutput,
    "```",
    "",
    "EA autonomous-recovery options:",
    "  1. Trigger another heartbeat immediately (transient prompt glitch).",
    "  2. Disable the heartbeat schedule temporarily and notify an operator.",
    "  3. Escalate to the owner in plain English if the pattern recurs.",
  ].join("\n");

  await sql.begin(async (tx) => {
    // Persist the escalation on the supervisor_reports audit row so the
    // dashboard can show "this heartbeat produced malformed output" next
    // to the agent task, in parallel with the decision that was created.
    await tx`
      UPDATE supervisor_reports
      SET action_outcomes = ${sql.json([
        {
          status: "error",
          detail: `malformed supervisor output: ${reason}`,
        },
      ])}
      WHERE id = ${reportId}
    `;

    // Governance-critical: ea_review, NEVER pending. Owner is a USER, not
    // a developer — the EA is the buffer that rewrites parse errors into
    // owner-friendly context before anything pages the owner.
    await tx`
      INSERT INTO decisions (
        hive_id, title, context, priority, status, kind
      )
      VALUES (
        ${hiveId},
        ${"Hive supervisor emitted malformed output"},
        ${context},
        'urgent',
        'ea_review',
        'supervisor_malformed'
      )
    `;
  });
}
