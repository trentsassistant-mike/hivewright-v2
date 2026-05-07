---
name: queue-health-dashboard
description: Queue health dashboard — scans all role queue directories for a hive and produces a unified JSON health report with per-role metrics, dispatcher heartbeat, failure categorization, and stuck task detection
metadata:
  openclaw:
    requires:
      bins: [jq, find, stat]
---

# Queue Health Dashboard

Scans all roles under a HiveWright hive and emits a unified JSON health report. Read-only — no queue files are modified.

---

## 1. Invocation

```bash
# Full health report (default)
queue-health.sh --hive hivewright

# Failure categorization only
queue-health.sh --hive hivewright --failures

# Stuck active tasks (default threshold: 60 minutes)
queue-health.sh --hive hivewright --stuck

# Stuck tasks with custom threshold
queue-health.sh --hive hivewright --stuck --threshold 30

# Pipe to jq for readable output
queue-health.sh --hive hivewright | jq .

# Summary only
queue-health.sh --hive hivewright | jq '.summary'

# RED roles only
queue-health.sh --hive hivewright | jq '.roles[] | select(.status == "RED")'
```

**Script location:** `skills/queue-health-dashboard/scripts/queue-health.sh`  
Make it executable and add to PATH, or invoke with a full path.

---

## 2. Default Mode Output

```json
{
  "generated_at": "2026-04-02T18:00:00+11:00",
  "hive": "hivewright",
  "dispatcher_heartbeat": {
    "last_log_entry": "2026-04-02T18:00:01+11:00",
    "age_minutes": 2,
    "status": "GREEN"
  },
  "summary": {
    "total_roles": 40,
    "green": 35,
    "yellow": 4,
    "red": 1
  },
  "roles": [
    {
      "slug": "dev-agent",
      "incoming_count": 0,
      "active_count": 1,
      "done_24h": 5,
      "done_7d": 22,
      "failed_24h": 0,
      "failed_7d": 1,
      "completion_rate": 0.957,
      "failure_rate": 0.043,
      "stuck_tasks": [],
      "directory_integrity": { "ok": true, "missing": [] },
      "status": "GREEN"
    }
  ]
}
```

---

## 3. Failure Categorization Mode (`--failures`)

Scans all `queue/failed/*.json` files across every role. Classifies each failed task by keyword-matching the `result_summary` / `error` / `failure_reason` field.

```json
{
  "failure_analysis": {
    "total_failed": 12,
    "categories": {
      "model_error": 3,
      "timeout": 2,
      "unclear_brief": 4,
      "tool_failure": 1,
      "dependency_failure": 0,
      "unknown": 2
    },
    "patterns": [
      { "type": "same_role_repeated", "role": "qa-lead", "failed_7d": 4 }
    ],
    "failed_tasks": [
      { "task_id": "QAL-123", "role": "qa-lead", "category": "unclear_brief", "mtime": 1743600000 }
    ]
  }
}
```

**Category keywords:**

| Category | Keywords matched (case-insensitive) |
|---|---|
| `model_error` | model, token, context window, rate limit |
| `timeout` | timeout, timed out, aborted |
| `unclear_brief` | unclear, ambiguous, insufficient context, missing |
| `tool_failure` | tool, exec, command, script, failed to run |
| `dependency_failure` | depends, dependency, blocked |
| `unknown` | no match |

**Patterns:** A `same_role_repeated` pattern is flagged when the same role has 3 or more failures within the last 7 days (by file mtime).

---

## 4. Stuck Tasks Mode (`--stuck`)

Lists all tasks in `queue/active/` with file mtime older than the threshold.

```json
{
  "threshold_minutes": 60,
  "stuck_tasks": [
    { "task_id": "ENG-1234567890", "role": "dev-agent", "age_minutes": 95 }
  ],
  "total_stuck": 1
}
```

Default threshold is 60 minutes. Override with `--threshold N`.

---

## 5. Status Rules

Per-role status in default mode:

| Status | Condition |
|---|---|
| `RED` | Any active task older than 60 min, OR `directory_integrity.ok == false`, OR `failed_7d >= 5` |
| `YELLOW` | `incoming_count > 10`, OR `failed_7d >= 2`, OR `active_count > 3` |
| `GREEN` | None of the above |

---

## 6. Dispatcher Heartbeat

Reads the latest log file from `hives/{hive}/logs/dispatcher/YYYY-MM-DD.log` and reports the age of the last entry.

| Status | Condition |
|---|---|
| `GREEN` | Last entry < 10 minutes ago |
| `YELLOW` | Last entry 10–60 minutes ago |
| `RED` | Last entry > 60 minutes ago, or log missing |

---

## 7. Directory Integrity

For each role, checks:
- `queue/incoming`, `queue/active`, `queue/done`, `queue/failed` directories exist
- `ROLE.md` file exists
- Role slug appears in `config/registry.json` under `.roles`

Missing items are listed in `directory_integrity.missing`.

---

## 8. Metrics Reference

| Field | Source |
|---|---|
| `incoming_count` | `*.json` count in `queue/incoming/` |
| `active_count` | `*.json` count in `queue/active/` |
| `done_24h` | `*.json` in `queue/done/` with mtime within 1 day |
| `done_7d` | `*.json` in `queue/done/` with mtime within 7 days |
| `failed_24h` | `*.json` in `queue/failed/` with mtime within 1 day |
| `failed_7d` | `*.json` in `queue/failed/` with mtime within 7 days |
| `completion_rate` | `done_7d / (done_7d + failed_7d)` — 1.0 if both zero |
| `failure_rate` | `failed_7d / (done_7d + failed_7d)` — 0.0 if both zero |

---

## 9. Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — valid JSON produced |
| `1` | Usage error (missing `--hive`, unknown flag, invalid path) |
| `2` | Required binary not found (`jq`, `find`, `stat`, `date`, `awk`) |

---

## 10. Security Constraints

- No network calls
- No credential access
- Read-only — does not modify any queue files or role state
