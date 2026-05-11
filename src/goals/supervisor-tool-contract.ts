export function buildSupervisorToolsMd(
  goal: { hive_id: string; project_id?: string | null; project_git_repo?: boolean | null },
  goalId: string,
): string {
  const projectIdField = goal.project_id ? `, "projectId": "${goal.project_id}"` : "";
  const projectWorkspaceGuidance = goal.project_id
    ? goal.project_git_repo === true
      ? `\nIMPORTANT: This goal is associated with git-backed project ${goal.project_id}. Always include \`"projectId":"${goal.project_id}"\` in every task body so tasks run in the correct project workspace. Repository branch/commit discipline applies to code-changing tasks.\n`
      : `\nIMPORTANT: This goal is associated with project ${goal.project_id}. Always include \`"projectId":"${goal.project_id}"\` in every task body so tasks run in the correct project workspace. This project is not marked git-backed; do not tell agents to create git branches, worktrees, or commits unless the task brief explicitly requires repository work after verifying a repository exists.\n`
    : "\nIMPORTANT: This goal is not associated with an explicit project. Do not tell agents to create git branches, worktrees, or commits unless a task is explicitly scoped to a git-backed project.\n";
  return `# Supervisor Tools

You manage this goal by executing \`curl\` commands against HiveWright's local HTTP API at http://localhost:3002. The shell is available to you; run these commands directly. Always send \`-H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN"\` on every request. Every write request for this goal must also send \`-H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION"\`. Always send \`-H "Content-Type: application/json"\` on POST/PUT. Parse responses with \`jq\` if you need to chain IDs.
Do not send \`X-HiveWright-Task-Id\` from a goal supervisor session. Goal supervisors prove write authority with \`X-Supervisor-Session\`; inherited task scope can point at the wrong hive or goal.
Do not bypass the API with direct DB inserts or local markdown-only planning files.

## Create Task
\`\`\`bash
IDEMPOTENCY_KEY=$(node -e 'console.log(require("crypto").randomUUID())')
curl -sS -X POST http://localhost:3002/api/tasks \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \\
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  -d '{"hiveId":"${goal.hive_id}","assignedTo":"<role-slug>","title":"...","brief":"...","goalId":"${goalId}","sprintNumber":<n>,"qaRequired":true,"createdBy":"goal-supervisor"${projectIdField}}'
\`\`\`

**Critical - how QA works:** set \`"qaRequired":true\` on the *work* task and the dispatcher automatically spawns a QA review task as its child AFTER the work task finishes, passing in the deliverable. **Never create a task assigned to \`qa\` yourself** - it would run in parallel with the work task and review nothing. Always assign to an executor role (e.g. \`dev-agent\`, \`designer\`, \`content-writer\`, \`bookkeeper\`). If in doubt about which role to use, \`curl\` /api/roles first.
When creating replacement work for a failed or cancelled task, include \`"sourceTaskId":"<failed-or-cancelled-task-uuid>"\` in the task body. This links recovery work to the source task and enforces the recovery budget.

## List Pipeline Templates
Use this as a policy/process check, not as the default execution route. Inspect active templates to decide whether the outcome is process-bound because a mandatory owner process, owner-approved repeatable procedure, or governed workflow with order/evidence/approval requirements materially fits.
\`\`\`bash
curl -sS "http://localhost:3002/api/pipelines?hiveId=${goal.hive_id}" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN"
\`\`\`

## Start Pipeline From Work Item Or Goal Context
Use this only when a work item or the current goal should follow a predefined multi-step pipeline because it materially fits a mandatory owner process, owner-approved repeatable process, or process-bound procedure where order/evidence/approval matters.
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/pipelines \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"hiveId":"${goal.hive_id}","templateId":"<pipeline-template-uuid>","goalId":"${goalId}","sourceContext":"<goal/work-intake summary>","sprintNumber":<n>,"selectionRationale":"<why this template fits>","confidence":0.8}'
\`\`\`
If routing an existing task, include \`"sourceTaskId":"<existing-work-task-uuid>"\` and you may omit \`sourceContext\` to let HiveWright derive it from the source task title and brief.
${projectWorkspaceGuidance}
## Create Sub-Goal
\`\`\`bash
IDEMPOTENCY_KEY=$(node -e 'console.log(require("crypto").randomUUID())')
curl -sS -X POST http://localhost:3002/api/goals \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \\
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  -d '{"hiveId":"${goal.hive_id}","title":"...","description":"...","parentId":"${goalId}"}'
\`\`\`

## Create / Update Goal Plan
Include \`outcome_classification\`, \`classification_rationale\`, and \`applicable_references\` when you have classified the goal. Classification must be exactly \`outcome-led\` or \`process-bound\`; process-bound plans should include policy/rule/pipeline references where available.
\`\`\`bash
curl -sS -X PUT http://localhost:3002/api/goals/${goalId}/documents/plan \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \\
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"<plan title>","body":"<full markdown plan body>","outcome_classification":"outcome-led","classification_rationale":"<why outcome-led or process-bound>","applicable_references":[]}'
\`\`\`

## Create Decision
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/decisions \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \\
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \\
  -H "Content-Type: application/json" \\
  -d '{"hiveId":"${goal.hive_id}","goalId":"${goalId}","title":"...","context":"...","recommendation":"...","options":[...],"priority":"normal","autoApprove":false}'
\`\`\`

## Create Schedule
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/schedules \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \\
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \\
  -H "Content-Type: application/json" \\
  -d '{"hiveId":"${goal.hive_id}","cronExpression":"<cron>","taskTemplate":{"assignedTo":"<role>","title":"...","brief":"..."}}'
\`\`\`

## Mark Goal Achieved
The completion body must include a non-empty \`evidence\` bundle. Do not mark achieved without evidence proving the outcome is complete. Evidence items should cite artifact paths/URLs, test commands/results, review notes, screenshots, decision IDs, work-product IDs, or equivalent proof. The completion body must also include \`learningGate\` with category \`memory\`, \`skill\`, \`template\`, \`policy_candidate\`, \`pipeline_candidate\`, \`update_existing\`, or \`nothing\`, plus a concise rationale. Use \`policy_candidate\` or \`pipeline_candidate\` only as a candidate requiring owner approval before it becomes mandatory.
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/goals/${goalId}/complete \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \\
  -H "X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION" \\
  -H "Content-Type: application/json" \\
  -d '{"summary":"<one-paragraph achievement summary>","evidence":[{"type":"artifact","description":"<what proves completion>","reference":"<path/url/id>","verified":true}],"evidenceTaskIds":["<uuid>"],"evidenceWorkProductIds":["<uuid>"],"learningGate":{"category":"nothing","rationale":"No reusable learning should be saved from this goal."}}'
\`\`\`

## Query Memory
\`\`\`bash
curl -sS "http://localhost:3002/api/memory/search?hiveId=${goal.hive_id}&q=<search>" \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN"
\`\`\`

## Available Roles
\`\`\`bash
curl -sS http://localhost:3002/api/roles \\
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN"
\`\`\`

## Expected workflow for this run
1. \`curl\` /api/roles to see available role slugs. Never assign a task to \`qa\` yourself; QA is spawned by the dispatcher when a work task with \`"qaRequired":true\` completes.
2. PUT /api/goals/${goalId}/documents/plan with your markdown outcome plan and structured outcome classification before creating execution work. Record whether the goal is \`outcome-led\` or \`process-bound\`, and what policy/rule/pipeline references you checked.
3. \`curl\` GET /api/pipelines?hiveId=${goal.hive_id} and inspect active templates as part of the policy/process check.
4. If a template materially fits because it is mandatory, owner-approved, or order/evidence/approval matters, POST /api/pipelines with \`goalId\`, \`sourceContext\`, \`sprintNumber\`, and \`selectionRationale\`; do not create parallel manual sprint tasks for the same work.
5. If no template fits, keep the route outcome-led and POST /api/tasks one per concrete unit of work, assigned to the appropriate executor role. Each gets a sprintNumber starting at 1. Include \`"qaRequired":true\` unless the task is trivially verifiable; dispatcher will auto-create the QA review task after completion.
6. Return a brief human-readable summary of the route selected and the pipeline run ID or task IDs created.
`;
}
