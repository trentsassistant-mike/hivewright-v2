---
name: static-analysis-orchestrator
description: Coordinated static analysis sweep — ESLint, Ruff, mypy, tsc, Semgrep, shellcheck with unified JSON report
metadata:
  openclaw:
    requires:
      bins: [jq, git]
---

# Static Analysis Orchestrator

Runs available linters and type-checkers against a target path and emits a single, unified JSON findings report. Tools are auto-detected — missing tools are skipped and noted in `summary.skipped_tools`, not treated as errors.

---

## 1. Invocation

```bash
# Scan the current directory
scan.sh

# Scan a specific path
scan.sh /path/to/repo

# Diff-only mode: scan only files changed vs a base branch
scan.sh --diff main /path/to/repo
scan.sh --diff origin/main

# Pipe to jq for readable output
scan.sh /path/to/repo | jq .

# Filter to errors only
scan.sh /path/to/repo | jq '.findings[] | select(.severity == "error")'

# Count by tool
scan.sh /path/to/repo | jq '.summary.by_tool'
```

**Script location:** `skills/static-analysis-orchestrator/scripts/scan.sh`
Make it executable and add to PATH, or invoke with a full path.

---

## 2. Diff-Only Mode

`--diff <base-branch>` restricts the scan to files changed between the current state and `<base-branch>`.

```bash
# Only scan files changed vs main
scan.sh --diff main

# Only scan files changed vs origin/main in a specific directory
scan.sh --diff origin/main /path/to/repo
```

Uses `git diff --name-only <base-branch>` from within the target path's git repository root. Files outside the target path are excluded. Useful in CI to avoid re-scanning unchanged files.

---

## 3. Detected Tools

| Tool | File Types | Output Mode |
|---|---|---|
| `eslint` | `.js`, `.jsx`, `.ts`, `.tsx` | JSON |
| `ruff` | `.py` | JSON |
| `mypy` | `.py` | Text (parsed) |
| `tsc` | `.ts`, `.tsx` | Text (parsed) |
| `semgrep` | All files | JSON |
| `shellcheck` | `.sh` | JSON |
| `pylint` | `.py` | JSON |

A tool is run only when: (a) its binary is on PATH **and** (b) the target path contains relevant file types. Tools that fail either condition appear in `summary.skipped_tools`.

---

## 4. Output Schema

```json
{
  "findings": [
    {
      "file": "relative/path/to/file",
      "line": 42,
      "severity": "error | warning | info",
      "tool": "eslint | ruff | mypy | tsc | semgrep | shellcheck | pylint",
      "rule": "rule-id-or-code",
      "message": "Human-readable description"
    }
  ],
  "summary": {
    "total": 10,
    "errors": 3,
    "warnings": 7,
    "by_tool": {
      "eslint": {"total": 5, "errors": 2, "warnings": 3}
    },
    "by_file": {
      "src/index.ts": 3
    },
    "top_files": ["src/utils.py", "src/index.ts"],
    "skipped_tools": ["semgrep", "mypy"],
    "tool_errors": []
  }
}
```

All file paths in `findings` are relative to the scanned target path.

---

## 5. Severity Interpretation

| Severity | Meaning | Exit Code Impact |
|---|---|---|
| `error` | Definite problem — type errors, syntax errors, critical lint violations | Triggers exit 1 |
| `warning` | Likely problem — style violations, best-practice deviations | No impact on exit code |
| `info` | Advisory — notes, refactor suggestions, style hints | No impact on exit code |

**Severity mapping by tool:**

- **eslint:** `severity == 2` → `error`, `severity == 1` → `warning`
- **ruff:** rule prefix `E` or `F` → `error`, all others → `warning`
- **mypy:** `error` → `error`, `warning` → `warning`, `note` → `info`
- **tsc:** `error` → `error`, `warning` → `warning`
- **semgrep:** `ERROR` → `error`, `WARNING` → `warning`, others → `info`
- **shellcheck:** `error` → `error`, `warning` → `warning`, `info`/`style` → `info`
- **pylint:** `error`/`fatal` → `error`, `warning` → `warning`, `refactor`/`convention` → `info`

---

## 6. Exit Codes

| Code | Meaning |
|---|---|
| `0` | No error-severity findings (warnings are acceptable) |
| `1` | One or more `error`-severity findings found |
| `2` | Tool execution failure — crash or missing required binary (`jq` or `git`) |

---

## 7. Deduplication

When two tools report a finding for the same `file` + `line` + `message`, the second occurrence is dropped. The first tool's report is kept. This prevents double-counting when tools overlap (e.g., both ruff and pylint flagging the same Python issue).

---

## 8. Security Constraints

- No network calls
- No credential access
- Read-only — does not modify any analysed files
