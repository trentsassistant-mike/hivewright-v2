import { describe, it, expect } from "vitest";
import { parseSupervisorActions } from "@/supervisor/parse-actions";

/**
 * Mirrors the doctor parse-diagnosis test pattern (see
 * tests/doctor/parse-diagnosis.test.ts). The supervisor's structured-output
 * contract is a single fenced ```json block whose body is a
 * `SupervisorActions` object ({ summary, findings_addressed, actions[] }).
 *
 * All negative paths MUST return { ok: false } with a kind (no_block |
 * malformed | invalid_shape) so the runtime's malformed-escalation path
 * can distinguish "the agent forgot the block" from "the agent emitted
 * the wrong shape" for Tier 3 decision context.
 */
describe("parseSupervisorActions", () => {
  it("extracts a well-formed SupervisorActions block", () => {
    const payload = {
      summary: "No findings require action.",
      findings_addressed: [],
      actions: [{ kind: "noop", reasoning: "clean hive" }],
    };
    const output = [
      "Hive scan reviewed.",
      "",
      "```json",
      JSON.stringify(payload),
      "```",
    ].join("\n");

    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toBe("No findings require action.");
      expect(result.value.actions).toHaveLength(1);
      expect(result.value.actions[0].kind).toBe("noop");
    }
  });

  it("extracts the LAST fenced json block if multiple are present", () => {
    const first = {
      summary: "draft",
      findings_addressed: [],
      actions: [{ kind: "noop", reasoning: "draft" }],
    };
    const second = {
      summary: "final",
      findings_addressed: ["unsatisfied_completion:abc"],
      actions: [
        {
          kind: "spawn_followup",
          originalTaskId: "22222222-2222-2222-2222-222222222222",
          assignedTo: "dev-agent",
          title: "implement X",
          brief: "based on analysis…",
        },
      ],
    };
    const output = [
      "Draft:",
      "```json",
      JSON.stringify(first),
      "```",
      "On reflection, this is the right response:",
      "```json",
      JSON.stringify(second),
      "```",
    ].join("\n");

    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toBe("final");
      expect(result.value.actions[0].kind).toBe("spawn_followup");
    }
  });

  it("returns no_block when no fenced json block is present", () => {
    const result = parseSupervisorActions(
      "I reviewed the findings and decided nothing is needed.",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("no_block");
      expect(result.error).toMatch(/no.*json.*block/i);
    }
  });

  it("returns malformed when the JSON body is unparseable", () => {
    const output = "```json\n{summary: not-quoted, actions: []}\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("malformed");
      expect(result.error).toMatch(/malformed|parse/i);
    }
  });

  it("returns invalid_shape when actions array is missing", () => {
    const output =
      "```json\n" +
      JSON.stringify({ summary: "x", findings_addressed: [] }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid_shape");
      expect(result.error).toMatch(/actions/);
    }
  });

  it("returns invalid_shape when summary is missing", () => {
    const output =
      "```json\n" +
      JSON.stringify({ findings_addressed: [], actions: [] }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid_shape");
      expect(result.error).toMatch(/summary/);
    }
  });

  it("returns invalid_shape when findings_addressed is missing", () => {
    const output =
      "```json\n" +
      JSON.stringify({ summary: "x", actions: [] }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid_shape");
      expect(result.error).toMatch(/findings_addressed/);
    }
  });

  it("returns invalid_shape when action kind is unknown", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: [],
        actions: [{ kind: "nuke_database", reasoning: "lol" }],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid_shape");
      expect(result.error).toMatch(/unknown action kind.*nuke_database/i);
    }
  });

  it("validates spawn_followup requires originalTaskId/assignedTo/title/brief", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: [],
        actions: [
          {
            kind: "spawn_followup",
            originalTaskId: "22222222-2222-2222-2222-222222222222",
            assignedTo: "dev-agent",
            // missing title + brief
          },
        ],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_shape");
  });

  it("validates wake_goal requires goalId + reasoning", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: [],
        actions: [{ kind: "wake_goal" }],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_shape");
  });

  it("validates create_decision tier must be 2 or 3", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: [],
        actions: [
          {
            kind: "create_decision",
            tier: 1,
            title: "x",
            context: "y",
          },
        ],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("invalid_shape");
      expect(result.error).toMatch(/tier/i);
    }
  });

  it("accepts create_decision with tier 3 + recommendation", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: ["aging_decision:abc"],
        actions: [
          {
            kind: "create_decision",
            tier: 3,
            title: "Owner input needed",
            context: "3 recurring failures in the last 24h",
            recommendation: "Pause the sprint while we investigate.",
          },
        ],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const action = result.value.actions[0];
      expect(action.kind).toBe("create_decision");
      if (action.kind === "create_decision") expect(action.tier).toBe(3);
    }
  });

  it("accepts create_decision with structured named options", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: ["aging_decision:abc"],
        actions: [
          {
            kind: "create_decision",
            tier: 3,
            title: "Choose Gemini CLI auth path",
            context: "The adapter can proceed through several named runtime/auth paths.",
            recommendation: "Use GCA login.",
            options: [
              {
                key: "api-key-runtime",
                label: "Use Gemini API key runtime",
                consequence: "Fastest automation path, but stores a credential.",
                canonicalResponse: "approved",
              },
              {
                key: "gca-login",
                label: "Use GCA login",
                consequence: "Owner can select this directly instead of using Discuss.",
                response: "approved",
              },
              {
                key: "defer-gemini-adapter",
                label: "Defer Gemini adapter work",
                consequence: "Leaves the goal parked.",
                canonical_response: "rejected",
              },
            ],
          },
        ],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const action = result.value.actions[0];
      expect(action.kind).toBe("create_decision");
      if (action.kind === "create_decision") {
        expect(action.options?.map((option) => option.key)).toEqual([
          "api-key-runtime",
          "gca-login",
          "defer-gemini-adapter",
        ]);
      }
    }
  });

  it("rejects malformed create_decision named options", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: [],
        actions: [
          {
            kind: "create_decision",
            tier: 3,
            title: "Choose path",
            context: "Missing option label.",
            options: [{ key: "gca-login", consequence: "Owner signs in." }],
          },
        ],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/options\[0\]\.label/);
  });

  it("accepts a mixed action list (close_task + mark_unresolvable + log_insight)", () => {
    const output =
      "```json\n" +
      JSON.stringify({
        summary: "Cleaned up three stalled rows.",
        findings_addressed: [
          "stalled_task:aaa",
          "stalled_task:bbb",
          "stalled_task:ccc",
        ],
        actions: [
          {
            kind: "close_task",
            taskId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            note: "owner resolved offline",
          },
          {
            kind: "mark_unresolvable",
            taskId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            reason: "role no longer exists",
          },
          {
            kind: "log_insight",
            category: "operations",
            content: "Three stalls in one hour — investigate adapter timeouts.",
          },
        ],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.actions).toHaveLength(3);
  });

  it("accepts uppercase ```JSON fence (LLMs sometimes capitalise)", () => {
    const output =
      "```JSON\n" +
      JSON.stringify({
        summary: "x",
        findings_addressed: [],
        actions: [{ kind: "noop", reasoning: "variant fence" }],
      }) +
      "\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(true);
  });

  it("returns malformed when JSON root is not an object", () => {
    const output = "```json\n[1,2,3]\n```";
    const result = parseSupervisorActions(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("malformed");
  });
});
