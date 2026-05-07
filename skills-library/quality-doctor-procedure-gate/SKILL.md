---
name: quality-doctor-procedure-gate
description: Quality-doctor diagnosis procedure that gates artifact evidence and enforces the canonical cause-to-action contract before JSON output
---

# Quality Doctor Procedure Gate

Use this skill inside every quality-doctor task. A quality-doctor task is any doctor task spawned by `createQualityDoctorTask` with `created_by='quality-doctor'`, or any task titled `Quality diagnosis: ...`.

This skill is mandatory before emitting the final diagnosis JSON. It prevents two failure modes:

- Choosing a `cause` whose recommendation belongs to another remediation path.
- Citing task IDs, work product IDs, task logs, or other artifacts that were not actually retrieved or provided in the brief.

## Procedure

Follow these steps in order. Do not skip the consistency gate.

1. **List artifact IDs in the brief.**
   - Record every task ID, parent task ID, work product ID, task log reference, commit SHA, document path, URL, and explicit database row reference that appears in the brief.
   - If the brief contains only embedded artifact text and no retrievable ID, write `not provided` for that artifact type in your scratch notes.

2. **Retrieve or mark each artifact.**
   - Retrieve each listed artifact using the tools and context available to the role.
   - If an artifact is embedded directly in the brief, treat the embedded text as retrieved evidence and label it `provided in brief`.
   - If an artifact ID cannot be retrieved, label it `not retrieved` and do not rely on its contents.
   - Never invent, paraphrase, or cite an artifact that was not retrieved or provided in the brief.

3. **Pick exactly one cause.**
   - Select one cause from the canonical table below.
   - Write a one-line justification grounded only in retrieved or provided evidence.
   - If evidence could fit multiple causes, choose the cause that matches the failed capability most directly.

4. **Write the mandated recommendation.**
   - Use the recommendation form required by the selected cause in the table.
   - Do not use quality-reviewer, general doctor, or dispatcher action names as the recommendation.
   - `split_task`, `retry_with_doctor`, `retry`, `rerun`, `auto_install`, and `install_connector` are not valid quality-doctor recommendation actions.

5. **Run the consistency gate.**
   - Compare `(cause, recommendation)` against the canonical table.
   - If the recommendation does not match the selected cause, reject your draft and restart from step 3.
   - If the recommendation relies on an unretrieved artifact, reject your draft and restart from step 2.
   - Only emit JSON after the gate passes.

## Canonical Cause-To-Action Table

| Cause | Use When | Mandatory Recommendation Form |
|---|---|---|
| `wrong_model` | The assigned role had the needed brief, artifacts, tools, and skill, but the output was shallow, generic, low-reasoning, or below the required model capability. | Recommend a Tier 2 `quality_doctor_recommendation` decision routed through model-efficiency sweeper guardrails before any model swap. |
| `missing_skill` | The role had access to needed artifacts and tools, but lacked a reusable procedure, domain workflow, or specialized operating pattern. | Recommend creating or sourcing a skill. State that the dispatcher must call `createOrUpdateSkillCandidateFromSignal` and emit a Tier 2 decision proposing skill generation or sourcing. |
| `missing_tool_connector_credential` | The role lacked required data, connector access, credentials, API permission, or an installed/enabled tool, or it faked/skipped work because access was missing. | Recommend a Tier 2 decision for connector, credential, permission, or tool enablement remediation. Explicitly state that nothing should be auto-installed and no credential should be invented. |
| `wrong_role_or_brief` | The task was assigned to the wrong role, the acceptance criteria were malformed, the scope was too broad, or the brief needs reroute, decomposition, or rewrite. | Recommend sending the issue to the supervisor for reroute, split, or brief rewrite. Keep the wording as a supervisor decision, not a direct doctor action. |

## Output Contract

Emit exactly one fenced `json` block and nothing else. The parser accepts only a JSON object with these keys:

```json
{"cause":"wrong_model|missing_skill|missing_tool_connector_credential|wrong_role_or_brief","details":"Evidence-grounded diagnosis.","recommendation":"Cause-matched Tier 2 recommendation."}
```

Rules for the JSON:

- `cause` must be exactly one of the four canonical strings.
- `details` must include the retrieved evidence basis and must not mention unretrieved artifacts as facts.
- `recommendation` must match the mandatory recommendation form for the chosen cause.
- Do not add preamble, markdown explanation, trailing text, or extra fenced blocks.

## Worked Examples

Good:

```json
{"cause":"missing_tool_connector_credential","details":"The provided task log says the agent could not access the required Figma connector and no retrieved artifact shows an enabled credential. The failure is access-related, not a task-shape issue.","recommendation":"Emit a Tier 2 quality_doctor_recommendation decision for connector or credential remediation. Do not auto-install a connector, invent credentials, or split the task until the access decision is resolved."}
```

Bad:

```json
{"cause":"missing_tool_connector_credential","details":"The agent could not access the required connector.","recommendation":"split_task"}
```

Why it fails: `split_task` is not the mandated action for `missing_tool_connector_credential`. Restart from step 3 and produce the Tier 2 connector or credential decision path.

Good:

```json
{"cause":"wrong_role_or_brief","details":"The provided brief asks one role to resolve repository coordinates, map frontend files, verify scripts, write documentation, stage, and commit. The evidence points to over-broad task shape rather than missing credentials or a missing reusable skill.","recommendation":"Emit a Tier 2 quality_doctor_recommendation decision sending this to the supervisor for reroute, split, or brief rewrite."}
```
