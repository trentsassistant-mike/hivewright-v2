# HiveWright Operational Conventions

Read this skill at the start of your session. These conventions ensure consistency
across all roles. They supplement your System Rules — the System Rules are mandatory,
these are best practices.

## Naming Conventions

### Task IDs
- Format: {DEPT}-{NNN} (e.g., ENG-047, RSH-003)
- Department codes: COO, ENG, RSH, FIN, QAL, AUD, MKT, SAL, ADM, LEG, PSN, OWN
- Numbers are zero-padded to 3 digits, auto-increment per department
- When creating tasks via write tool: check existing task IDs in the target
  role's queue/ directories to determine the next number

### File Naming
- Task files: {task_id}.json (e.g., ENG-047.json)
- Critical priority prefix: 0-{task_id}.json (e.g., 0-ENG-047.json)
- Worklog files: YYYY-MM-DD.md (one per day, append-only)
- Session logs: YYYY-MM-DD.log (one per day, append-only)
- Reports: descriptive name with date (e.g., 2026-02-20-weekly-health.md)

### Git Branches (Engineering tasks)
- Format: hw/{task-id}-{short-description}
- Examples: hw/ENG-047-webhook-endpoint, hw/ENG-051-cost-report-script
- Commit prefix: [{TASK-ID}] (e.g., [ENG-047] Add Stripe webhook handler)

## Worklog Entry Format

Each worklog entry follows this structure. The worklog-append.sh tool generates
this format, but if writing manually:

```
### {task_id}: {title}
- **Role:** {role_slug}
- **Status:** completed | failed | escalated
- **Time:** HH:MM AEDT
- **Duration:** ~{minutes}min
- **Summary:** {one paragraph of what was done}
- **Deliverables:** {list of output file paths, if any}
```

## Report Formatting

### Standard Report Structure
Reports should open with a summary section (2-3 sentences covering the key
findings), followed by detailed sections. End with recommendations if applicable.

### Tables
Use markdown tables for comparison data. Keep columns to 5 or fewer for
readability.

### Status Indicators
- Pass / Complete / Healthy
- Warning / Needs attention
- Fail / Critical / Blocked
- Info / Observation

## Result Task Format

When creating a result task in the return_to role's queue/incoming/, include:

```json
{
  "task_id": "{DEPT}-{NNN}",
  "title": "Result: {original task title}",
  "priority": "{same as original}",
  "created_at": "{ISO 8601}",
  "created_by": "{your role slug}",
  "assigned_to": "{return_to role}",
  "return_to": "{return_to role's supervisor}",
  "escalate_to": "{same as original}",
  "project": "{same as original}",
  "parent_task_id": "{original task_id}",
  "hive_id": "{same hive_id as original task}",
  "core_task_id": "{same core_task_id as original task}",
  "brief": "Task {original task_id} is complete. Summary: {what was done}. Deliverables at: {paths}.",
  "acceptance_criteria": ["Review the deliverables", "Confirm requirements met"]
}
```

## Escalation Task Format

When creating an escalation task on failure:

```json
{
  "task_id": "{DEPT}-{NNN}",
  "title": "ESCALATION: {original task title}",
  "priority": "high",
  "created_at": "{ISO 8601}",
  "created_by": "{your role slug}",
  "assigned_to": "{escalate_to role}",
  "return_to": "{your role slug}",
  "escalate_to": "{escalate_to role's supervisor}",
  "project": "{same as original}",
  "parent_task_id": "{original task_id}",
  "hive_id": "{same hive_id as original task}",
  "core_task_id": "{same core_task_id as original task}",
  "brief": "Task {original task_id} failed. Reason: {what went wrong}. Attempted: {what you tried}. Recommendation: {suggested next step}.",
  "acceptance_criteria": ["Review failure", "Decide on retry, rework, or cancellation"]
}
```

## Priority Levels

| Priority | When to Use | Dispatcher Behavior |
|----------|------------|-------------------|
| critical | System down, data loss risk, Owner-flagged urgent | Filename prefixed with 0- for priority pickup |
| high | Time-sensitive, blocking other work | Normal FIFO but roles should prioritize |
| medium | Standard work, default | Normal FIFO |
| low | Background, nice-to-have, maintenance | Normal FIFO, may be deferred |

## Hive Directory Conventions

Hives live at $HOME/hivewright/hives/{hive-id}/

Each hive directory contains:
- HIVE.md — Hive identity, context, strategy (YAML frontmatter + markdown, maintained by COO)
- STATUS.md — Cross-department living status (maintained by COO Assistant)
- OWNERS.yaml — Write permission declarations
- _management/ — Governance artifacts (decisions/, strategy/, initiatives/)
- departments/{dept}/ — Department-owned workspaces with deliverables
- repos/ — Git repositories (digital-product and greenfield types only)

STATUS.md format:
```markdown
# {Hive Name} — Status

**Last updated:** {date} by {role}

## Active Work

### {Department}
- **{task_id}** {title} — {role} — In Progress

## Blocked
- **{task_id}** {title} — blocked on {what}

## Recent Completions (7 days)
- **{task_id}** {title} — Completed {date}
```

Department deliverables include frontmatter for chain tracking:
```markdown
---
core_task_id: {core_task_id}
hive_id: {hive_id}
department: {department}
task_id: {task_id}
---
```
