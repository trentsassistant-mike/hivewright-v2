---
name: hive-supervisor-heartbeat
description: Mandatory ordered heartbeat gates for hive-supervisor runs
---

# Hive Supervisor Heartbeat Gates

Read this skill before processing every hive-supervisor heartbeat. These gates
are procedural checks, not advisory notes. Run them in order and do not skip a
later gate by saying the earlier one is probably irrelevant.

Apply these gates to every finding type, including `recurring_failure`, before
emitting any `spawn_followup`, `noop`, or terminal supervisor reply.

## Source Basis

This skill is a synthesis of the full unsuperseded `role_memory` corpus for
role `hive-supervisor` and all `standing_instructions` rows for hive
`b6b815ba-5109-4066-8a33-cc5560d3a0e1`, queried from the repository database on
2026-04-29. Canonical source records include:

- `role_memory.cd57fede-9a6c-4971-b9be-4aca82b4e92f`: bounded QA verification
  must confirm absence of `thread-not-found` errors during action or task
  registration.
- `standing_instructions.de5cce3a-acf0-4032-aeb2-4384f193bfe8`: QA's
  `failed to record rollout items: thread not found` log narrows the issue to
  the Codex adapter/session layer.
- `standing_instructions.9579bb7c-ea42-46d3-a241-3ecf6a93e855`: the
  undocumented session error is a critical known Codex adapter/session
  vulnerability, not a logging-only anomaly.
- `role_memory.2d2ab6b3-7581-4245-9508-971f8b00d8ce`: a named blocker such as
  the `/hi` redirect requires a runtime/UI investigation gate before file
  mapping, handoff note writing, or other decomposition steps.
- `standing_instructions.655c1cd3-5e42-4af4-a242-e5cb7c17768b`: the `/hi`
  redirect may be the clearest symptom of the recurring dev-agent QA failure
  and must be prioritized before process remediation.
- `role-library/hive-supervisor/ROLE.md`: choose the lightest-touch action;
  when unsure, emit `create_decision` with `tier: 2` so the EA can triage.
- `src/supervisor/index.ts`: heartbeat briefs require `findings_addressed` to
  reference finding IDs from the report.
- Decision `2cbd7895-bcbd-42cb-81d6-9b81c3cafc21`: after `spawn_followup`
  actions are written, the supervisor must verify that the dispatcher actually
  registered the spawned task rows before treating the follow-ups as in flight.

Where the records used different wording, the gates below use a conservative
synthesis that preserves the operational requirement.

## Ordered Non-Skippable Checklist

### 1. Stderr Scan

Before judging any health finding, scan the heartbeat input, task logs, session
stderr, runtime warnings, and any attached or quoted session log text for:

- `thread not found`
- `failed to record rollout items`
- `rollout-record`
- `rollout registration failed`

If any match is present, emit a `create_decision` action, normally `tier: 2`,
that names the stderr line, the affected task or session if known, and the
recommended Codex adapter/session investigation. Do not silently continue, do
not classify the heartbeat as clean, and do not proceed to `spawn_followup`
until the `create_decision` path has been evaluated and either emitted or
explicitly rejected with a reason tied to a newer canonical source.

### 2. Standing Instructions Check

Before structural decomposition, read the active Standing Instructions section
and check for any named runtime blocker, including examples such as `/hi`
redirects, missing runtime routes, API routing discrepancies, non-resolvable
hosts, or session/logging infrastructure blockers.

If a named runtime blocker is present and is relevant to the finding, insert an
investigation task or decision ahead of any decomposition, file mapping, handoff
writing, or implementation task. Do not proceed to decomposition until the
blocker has a bounded investigation path with a clear PASS/FAIL outcome.

### 3. Lightest-Touch Action First

For each finding, evaluate whether `create_decision` with Tier 2 or Tier 3
routing is the lightest-touch action before choosing `spawn_followup`.

If the finding is ambiguous, audit-shaped, infrastructure-shaped, strategic, or
depends on owner or EA judgement, emit `create_decision` instead of
`spawn_followup`. Do not spawn a follow-up until you have justified why a direct
task is lighter and safer than a decision, and include that justification in
the reasoning or action context.

### 4. Non-Truncated Output

Inventory every finding ID reported in the heartbeat input before writing the
final `SupervisorActions` JSON. Compare that inventory with
`findings_addressed`.

If any finding ID from the heartbeat input is omitted, add it to
`findings_addressed` and provide an action or explicit `noop` reasoning for it.
Do not finish with tail truncation, generic "remaining findings" language, or
silent omissions. If the heartbeat input is too large to cover in one compact
paragraph, keep the summary short but preserve full finding-ID coverage in the
JSON.

### 5. Post-Action Registration Verification

After the `SupervisorActions` JSON has been written, but before the supervisor
reply is considered terminal, verify registration for every emitted
`spawn_followup` action.

For each `spawn_followup`, perform a database-level confirmation that a task row
exists for the spawned work. Match on the heartbeat start time, assignee, and
title or an equivalent uniquely identifying brief/title shape. A valid check is:

```sql
SELECT id
FROM tasks
WHERE created_at > <heartbeat_started_at>
  AND assigned_to = <action.assignedTo>
  AND title = <action.title>;
```

Equivalent repository helpers or stricter predicates are acceptable only when
they prove the same persisted task-row fact. The emitted action alone is not
proof that work is scheduled.

If any spawned action cannot be confirmed as registered, do not treat that
follow-up as in flight. Emit a `create_decision` action with `tier: 2` that
names the missing registration, the suspected rollout/session error, and the
affected `spawn_followup` action title or brief. This decision must replace any
terminal claim that the unconfirmed follow-up was successfully scheduled.

This gate is the post-action counterpart to Gate 1's stderr scan. The canonical
failure mode is the rollout-record / `thread not found` session-layer error
where an agent emits a spawn action but the dispatcher fails to persist the
resulting task row.
