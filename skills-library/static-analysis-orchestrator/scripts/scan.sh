#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# scan.sh — Static analysis orchestrator
# Auto-detects available linters and type-checkers, runs them against a
# target path, and emits a unified JSON findings report to stdout.
#
# Usage:
#   scan.sh [--diff <base-branch>] [<path>]
#
# Exit codes:
#   0 — No error-severity findings (warnings are acceptable)
#   1 — One or more error-severity findings found
#   2 — Tool execution failure (crash or missing required binary: jq, git)
# ---------------------------------------------------------------------------

TARGET_PATH="."
DIFF_BASE=""

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --diff)
            [[ $# -lt 2 ]] && { printf '{"error":"--diff requires a branch name"}\n' >&2; exit 2; }
            DIFF_BASE="$2"; shift 2 ;;
        --help|-h)
            printf 'Usage: scan.sh [--diff <base-branch>] [<path>]\n' >&2
            exit 0 ;;
        -*)
            printf 'Unknown flag: %s\n' "$1" >&2; exit 2 ;;
        *)
            TARGET_PATH="$1"; shift ;;
    esac
done

# ---------------------------------------------------------------------------
# Required binaries
# ---------------------------------------------------------------------------
for _bin in jq git; do
    if ! command -v "$_bin" >/dev/null 2>&1; then
        printf '{"error":"required binary not found: %s"}\n' "$_bin" >&2
        exit 2
    fi
done

# Resolve to absolute path
TARGET_PATH="$(cd "$TARGET_PATH" && pwd)"

# ---------------------------------------------------------------------------
# Temp dir with cleanup
# ---------------------------------------------------------------------------
_TMPDIR=$(mktemp -d)
trap 'rm -rf "$_TMPDIR"' EXIT

# ---------------------------------------------------------------------------
# Build file list
# ---------------------------------------------------------------------------
ALL_FILES="${_TMPDIR}/all_files.txt"

if [[ -n "$DIFF_BASE" ]]; then
    GIT_ROOT=$(git -C "$TARGET_PATH" rev-parse --show-toplevel 2>/dev/null || echo "$TARGET_PATH")
    git -C "$GIT_ROOT" diff --name-only "$DIFF_BASE" 2>/dev/null \
        | sed "s|^|${GIT_ROOT}/|" \
        | grep "^${TARGET_PATH}/" \
        | grep -E '\.(js|jsx|ts|tsx|py|sh)$' \
        > "$ALL_FILES" || true
else
    find "$TARGET_PATH" -type f \
        \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" \
           -o -name "*.py" -o -name "*.sh" \) \
        ! -path "*/node_modules/*" \
        ! -path "*/.git/*" \
        ! -path "*/__pycache__/*" \
        ! -path "*/dist/*" \
        ! -path "*/build/*" \
        2>/dev/null \
        > "$ALL_FILES" || true
fi

# Per-type file lists
JS_FILES="${_TMPDIR}/js_files.txt"
TS_FILES="${_TMPDIR}/ts_files.txt"
PY_FILES="${_TMPDIR}/py_files.txt"
SH_FILES="${_TMPDIR}/sh_files.txt"

grep -E '\.(js|jsx|ts|tsx)$' "$ALL_FILES" > "$JS_FILES" 2>/dev/null || true
grep -E '\.(ts|tsx)$'         "$ALL_FILES" > "$TS_FILES" 2>/dev/null || true
grep -E '\.py$'               "$ALL_FILES" > "$PY_FILES" 2>/dev/null || true
grep -E '\.sh$'               "$ALL_FILES" > "$SH_FILES" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Tool availability
# ---------------------------------------------------------------------------
_tool_ok() { command -v "$1" >/dev/null 2>&1 && echo true || echo false; }

ESLINT_OK=$(_tool_ok eslint)
RUFF_OK=$(_tool_ok ruff)
MYPY_OK=$(_tool_ok mypy)
TSC_OK=$(_tool_ok tsc)
SEMGREP_OK=$(_tool_ok semgrep)
SHELLCHECK_OK=$(_tool_ok shellcheck)
PYLINT_OK=$(_tool_ok pylint)

# ---------------------------------------------------------------------------
# Accumulators
# ---------------------------------------------------------------------------
FINDINGS_FILES=()
SKIPPED_TOOLS=()
TOOL_ERRORS=()

# ---------------------------------------------------------------------------
# ESLint — JS/TS
# ---------------------------------------------------------------------------
run_eslint() {
    local f="${_TMPDIR}/eslint_findings.json"
    if [[ "$ESLINT_OK" == false ]] || [[ ! -s "$JS_FILES" ]]; then
        SKIPPED_TOOLS+=(eslint); return
    fi
    local raw="${_TMPDIR}/eslint_raw.json"
    mapfile -t _files < "$JS_FILES"
    eslint --format json "${_files[@]}" > "$raw" 2>/dev/null || true
    jq --arg base "${TARGET_PATH}/" '
      [ .[] | .filePath as $fp | .messages[] | {
          file: ($fp | ltrimstr($base)),
          line: (.line // 0),
          severity: (if .severity == 2 then "error" else "warning" end),
          tool: "eslint",
          rule: (.ruleId // "unknown"),
          message: .message
      }]
    ' "$raw" > "$f" 2>/dev/null || { TOOL_ERRORS+=("eslint:parse_failed"); printf '[]' > "$f"; }
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# Ruff — Python
# ---------------------------------------------------------------------------
run_ruff() {
    local f="${_TMPDIR}/ruff_findings.json"
    if [[ "$RUFF_OK" == false ]] || [[ ! -s "$PY_FILES" ]]; then
        SKIPPED_TOOLS+=(ruff); return
    fi
    local raw="${_TMPDIR}/ruff_raw.json"
    ruff check --output-format json "$TARGET_PATH" > "$raw" 2>/dev/null || true
    jq --arg base "${TARGET_PATH}/" '
      [ .[] | {
          file: (.filename | ltrimstr($base)),
          line: (.location.row // 0),
          severity: (if (.code // "") | test("^[EF]") then "error" else "warning" end),
          tool: "ruff",
          rule: (.code // "unknown"),
          message: .message
      }]
    ' "$raw" > "$f" 2>/dev/null || { TOOL_ERRORS+=("ruff:parse_failed"); printf '[]' > "$f"; }
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# mypy — Python (text output, parsed via gawk)
# ---------------------------------------------------------------------------
run_mypy() {
    local f="${_TMPDIR}/mypy_findings.json"
    if [[ "$MYPY_OK" == false ]] || [[ ! -s "$PY_FILES" ]]; then
        SKIPPED_TOOLS+=(mypy); return
    fi
    local raw="${_TMPDIR}/mypy_raw.txt"
    mypy --show-column-numbers --no-error-summary "$TARGET_PATH" > "$raw" 2>&1 || true
    local jlines="${_TMPDIR}/mypy_lines.ndjson"
    # Format: path:line:col: severity: message [rule]
    gawk -v base="${TARGET_PATH}/" '
        match($0, /^(.+):([0-9]+):[0-9]+: (error|warning|note): (.+)$/, a) {
            file = a[1]; sub("^" base, "", file)
            line = a[2]
            sev = (a[3] == "note" ? "info" : a[3])
            msg = a[4]
            rule = "unknown"
            if (match(msg, /\[([^]]+)\]$/, r)) {
                rule = r[1]
                msg = substr(msg, 1, RSTART - 1)
                gsub(/ +$/, "", msg)
            }
            gsub(/\\/, "\\\\", msg);  gsub(/"/, "\\\"", msg)
            gsub(/\t/, "\\t",  msg);  gsub(/\r/, "",    msg)
            gsub(/\\/, "\\\\", file); gsub(/"/, "\\\"", file)
            printf "{\"file\":\"%s\",\"line\":%s,\"severity\":\"%s\",\"tool\":\"mypy\",\"rule\":\"%s\",\"message\":\"%s\"}\n", \
                file, line, sev, rule, msg
        }
    ' "$raw" > "$jlines" 2>/dev/null || true
    jq -s '.' "$jlines" > "$f" 2>/dev/null || printf '[]' > "$f"
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# tsc — TypeScript (text output, parsed via gawk)
# ---------------------------------------------------------------------------
run_tsc() {
    local f="${_TMPDIR}/tsc_findings.json"
    if [[ "$TSC_OK" == false ]] || [[ ! -s "$TS_FILES" ]]; then
        SKIPPED_TOOLS+=(tsc); return
    fi
    local raw="${_TMPDIR}/tsc_raw.txt"
    (cd "$TARGET_PATH" && tsc --noEmit --pretty false 2>&1) > "$raw" || true
    local jlines="${_TMPDIR}/tsc_lines.ndjson"
    # Format: path(line,col): error TScode: message
    gawk -v base="${TARGET_PATH}/" '
        match($0, /^(.+)\(([0-9]+),[0-9]+\): (error|warning) (TS[0-9]+): (.+)$/, a) {
            file = a[1]; sub("^" base, "", file)
            line = a[2]; sev = a[3]; rule = a[4]; msg = a[5]
            gsub(/\\/, "\\\\", msg);  gsub(/"/, "\\\"", msg)
            gsub(/\t/, "\\t",  msg);  gsub(/\r/, "",    msg)
            gsub(/\\/, "\\\\", file); gsub(/"/, "\\\"", file)
            printf "{\"file\":\"%s\",\"line\":%s,\"severity\":\"%s\",\"tool\":\"tsc\",\"rule\":\"%s\",\"message\":\"%s\"}\n", \
                file, line, sev, rule, msg
        }
    ' "$raw" > "$jlines" 2>/dev/null || true
    jq -s '.' "$jlines" > "$f" 2>/dev/null || printf '[]' > "$f"
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# semgrep — all files
# ---------------------------------------------------------------------------
run_semgrep() {
    local f="${_TMPDIR}/semgrep_findings.json"
    if [[ "$SEMGREP_OK" == false ]]; then
        SKIPPED_TOOLS+=(semgrep); return
    fi
    local raw="${_TMPDIR}/semgrep_raw.json"
    semgrep scan --json "$TARGET_PATH" > "$raw" 2>/dev/null || true
    jq --arg base "${TARGET_PATH}/" '
      [ .results[] | {
          file: (.path | ltrimstr($base)),
          line: (.start.line // 0),
          severity: (
            (.extra.severity // "WARNING") | ascii_downcase |
            if . == "error" then "error"
            elif . == "warning" then "warning"
            else "info" end
          ),
          tool: "semgrep",
          rule: (.check_id // "unknown"),
          message: (.extra.message // "")
      }]
    ' "$raw" > "$f" 2>/dev/null || { TOOL_ERRORS+=("semgrep:parse_failed"); printf '[]' > "$f"; }
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# ShellCheck — Shell scripts
# ---------------------------------------------------------------------------
run_shellcheck() {
    local f="${_TMPDIR}/shellcheck_findings.json"
    if [[ "$SHELLCHECK_OK" == false ]] || [[ ! -s "$SH_FILES" ]]; then
        SKIPPED_TOOLS+=(shellcheck); return
    fi
    local raw="${_TMPDIR}/shellcheck_raw.json"
    mapfile -t _files < "$SH_FILES"
    shellcheck --format=json "${_files[@]}" > "$raw" 2>/dev/null || true
    jq --arg base "${TARGET_PATH}/" '
      [ .[] | {
          file: (.file | ltrimstr($base)),
          line: (.line // 0),
          severity: (if .level == "error" then "error"
                     elif .level == "warning" then "warning"
                     else "info" end),
          tool: "shellcheck",
          rule: ("SC" + (.code | tostring)),
          message: .message
      }]
    ' "$raw" > "$f" 2>/dev/null || { TOOL_ERRORS+=("shellcheck:parse_failed"); printf '[]' > "$f"; }
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# pylint — Python
# ---------------------------------------------------------------------------
run_pylint() {
    local f="${_TMPDIR}/pylint_findings.json"
    if [[ "$PYLINT_OK" == false ]] || [[ ! -s "$PY_FILES" ]]; then
        SKIPPED_TOOLS+=(pylint); return
    fi
    local raw="${_TMPDIR}/pylint_raw.json"
    mapfile -t _files < "$PY_FILES"
    pylint --output-format json "${_files[@]}" > "$raw" 2>/dev/null || true
    jq --arg base "${TARGET_PATH}/" '
      [ .[] | {
          file: (.path | ltrimstr($base)),
          line: (.line // 0),
          severity: (if .type == "error" or .type == "fatal" then "error"
                     elif .type == "warning" then "warning"
                     else "info" end),
          tool: "pylint",
          rule: (.["message-id"] // .symbol // "unknown"),
          message: .message
      }]
    ' "$raw" > "$f" 2>/dev/null || { TOOL_ERRORS+=("pylint:parse_failed"); printf '[]' > "$f"; }
    FINDINGS_FILES+=("$f")
}

# ---------------------------------------------------------------------------
# Run all tools
# ---------------------------------------------------------------------------
run_eslint
run_ruff
run_mypy
run_tsc
run_semgrep
run_shellcheck
run_pylint

# ---------------------------------------------------------------------------
# Merge findings
# ---------------------------------------------------------------------------
MERGED="${_TMPDIR}/merged.json"
if [[ ${#FINDINGS_FILES[@]} -eq 0 ]]; then
    printf '[]' > "$MERGED"
else
    jq -s 'add // []' "${FINDINGS_FILES[@]}" > "$MERGED"
fi

# ---------------------------------------------------------------------------
# Deduplicate: file + line + message (exact), keep first occurrence
# ---------------------------------------------------------------------------
DEDUPED="${_TMPDIR}/deduped.json"
jq '
    reduce .[] as $f (
        {"seen": {}, "out": []};
        ($f.file + ":" + ($f.line | tostring) + ":" + $f.message) as $key |
        if .seen[$key] then .
        else . + {"seen": (.seen + {($key): true}), "out": (.out + [$f])}
        end
    ) | .out
' "$MERGED" > "$DEDUPED"

# ---------------------------------------------------------------------------
# Build JSON arrays from bash arrays (safe empty-array handling)
# ---------------------------------------------------------------------------
if [[ ${#SKIPPED_TOOLS[@]} -eq 0 ]]; then
    SKIPPED_JSON='[]'
else
    SKIPPED_JSON=$(printf '%s\n' "${SKIPPED_TOOLS[@]}" | jq -R . | jq -s .)
fi

if [[ ${#TOOL_ERRORS[@]} -eq 0 ]]; then
    ERRORS_JSON='[]'
else
    ERRORS_JSON=$(printf '%s\n' "${TOOL_ERRORS[@]}" | jq -R . | jq -s .)
fi

# ---------------------------------------------------------------------------
# Assemble final output
# ---------------------------------------------------------------------------
FINAL="${_TMPDIR}/final.json"
jq -n \
    --argjson findings "$(cat "$DEDUPED")" \
    --argjson skipped "$SKIPPED_JSON" \
    --argjson tool_errors "$ERRORS_JSON" \
    '{
        findings: $findings,
        summary: {
            total:    ($findings | length),
            errors:   ($findings | map(select(.severity == "error"))   | length),
            warnings: ($findings | map(select(.severity == "warning")) | length),
            by_tool: (
                $findings | group_by(.tool) |
                map({key: .[0].tool, value: {
                    total:    length,
                    errors:   (map(select(.severity == "error"))   | length),
                    warnings: (map(select(.severity == "warning")) | length)
                }}) | from_entries
            ),
            by_file: (
                $findings | group_by(.file) |
                map({key: .[0].file, value: length}) | from_entries
            ),
            top_files: (
                $findings | group_by(.file) |
                map({file: .[0].file, count: length}) |
                sort_by(-.count) | .[0:5] | map(.file)
            ),
            skipped_tools: $skipped,
            tool_errors:   $tool_errors
        }
    }' > "$FINAL"

cat "$FINAL"

# ---------------------------------------------------------------------------
# Exit code
# ---------------------------------------------------------------------------
ERROR_COUNT=$(jq '.summary.errors' "$FINAL")
if [[ "$ERROR_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
