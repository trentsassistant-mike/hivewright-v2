#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# queue-health.sh — HiveWright queue health dashboard
#
# Scans all roles under a hive and produces a unified JSON health report.
# Read-only diagnostic tool for system-health-auditor and internal-audit-lead.
#
# Usage:
#   queue-health.sh --hive HIVE
#   queue-health.sh --hive HIVE --failures
#   queue-health.sh --hive HIVE --stuck [--threshold N]
#
# Exit codes:
#   0 — success
#   1 — usage error
#   2 — required binary not found
# ---------------------------------------------------------------------------

HIVEWRIGHT_ROOT="${HIVEWRIGHT_ROOT:-$HOME/hivewright}"
REGISTRY="$HIVEWRIGHT_ROOT/config/registry.json"

MODE="default"
HIVE=""
THRESHOLD=60

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --hive)
            [[ $# -ge 2 ]] || { printf '{"error":"--hive requires a value"}\n' >&2; exit 1; }
            HIVE="$2"; shift 2 ;;
        --failures)
            MODE="failures"; shift ;;
        --stuck)
            MODE="stuck"; shift ;;
        --threshold)
            [[ $# -ge 2 ]] || { printf '{"error":"--threshold requires a value"}\n' >&2; exit 1; }
            THRESHOLD="$2"; shift 2 ;;
        --help|-h)
            cat >&2 <<'HELP'
Usage: queue-health.sh --hive HIVE [OPTIONS]

Options:
  --failures           Failure categorization report
  --stuck              List stuck active tasks (age > threshold)
  --threshold N        Stuck threshold in minutes (default: 60, requires --stuck)

Examples:
  queue-health.sh --hive hivewright
  queue-health.sh --hive hivewright --failures
  queue-health.sh --hive hivewright --stuck --threshold 30
HELP
            exit 0 ;;
        -*)
            printf '{"error":"unknown flag: %s"}\n' "$1" >&2; exit 1 ;;
        *)
            printf '{"error":"unexpected argument: %s"}\n' "$1" >&2; exit 1 ;;
    esac
done

[[ -n "$HIVE" ]] || { printf '{"error":"--hive is required"}\n' >&2; exit 1; }

# ---------------------------------------------------------------------------
# Required binaries
# ---------------------------------------------------------------------------
for _bin in jq find stat date awk; do
    command -v "$_bin" >/dev/null 2>&1 || {
        printf '{"error":"required binary not found: %s"}\n' "$_bin" >&2
        exit 2
    }
done

ROLES_DIR="$HIVEWRIGHT_ROOT/businesses/$HIVE/roles"
LOGS_DIR="$HIVEWRIGHT_ROOT/businesses/$HIVE/logs"

[[ -d "$ROLES_DIR" ]] || {
    printf '{"error":"roles directory not found: %s"}\n' "$ROLES_DIR" >&2
    exit 1
}

NOW_EPOCH="$(date +%s)"

# ---------------------------------------------------------------------------
# count_all DIR — count JSON files in DIR (non-recursive)
# ---------------------------------------------------------------------------
count_all() {
    local dir="$1"
    [[ -d "$dir" ]] || { echo "0"; return; }
    find "$dir" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
# count_recent DIR DAYS — count JSON files modified within DAYS days
# ---------------------------------------------------------------------------
count_recent() {
    local dir="$1" days="$2"
    [[ -d "$dir" ]] || { echo "0"; return; }
    find "$dir" -maxdepth 1 -name "*.json" -mtime "-${days}" 2>/dev/null | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
# float_div NUMERATOR DENOMINATOR DEFAULT — safe floating-point division
# ---------------------------------------------------------------------------
float_div() {
    local num="$1" denom="$2" default="$3"
    [[ "$denom" -eq 0 ]] && { echo "$default"; return; }
    LC_ALL=C awk "BEGIN { printf \"%.3f\", $num / $denom }"
}

# ---------------------------------------------------------------------------
# get_dispatcher_heartbeat — check dispatcher log freshness
# ---------------------------------------------------------------------------
get_dispatcher_heartbeat() {
    local log_dir="$LOGS_DIR/dispatcher"

    if [[ ! -d "$log_dir" ]]; then
        printf '{"last_log_entry":null,"age_minutes":-1,"status":"RED","detail":"log directory missing"}'
        return
    fi

    local latest_log
    latest_log="$(find "$log_dir" -maxdepth 1 -name "*.log" -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2- || true)"

    if [[ -z "${latest_log:-}" ]]; then
        printf '{"last_log_entry":null,"age_minutes":-1,"status":"RED","detail":"no log files found"}'
        return
    fi

    local last_ts
    last_ts="$(tail -1 "$latest_log" 2>/dev/null | awk '{print $1}' || true)"

    if [[ -z "${last_ts:-}" ]]; then
        printf '{"last_log_entry":null,"age_minutes":-1,"status":"RED","detail":"empty log"}'
        return
    fi

    local ts_epoch
    ts_epoch="$(date -d "$last_ts" +%s 2>/dev/null || true)"

    if [[ -z "${ts_epoch:-}" ]]; then
        jq -n --arg ts "$last_ts" \
            '{"last_log_entry":$ts,"age_minutes":-1,"status":"RED","detail":"timestamp parse error"}'
        return
    fi

    local age_minutes status
    age_minutes=$(( (NOW_EPOCH - ts_epoch) / 60 ))

    if   [[ $age_minutes -lt 10  ]]; then status="GREEN"
    elif [[ $age_minutes -le 60  ]]; then status="YELLOW"
    else                                   status="RED"
    fi

    jq -n --arg ts "$last_ts" --argjson age "$age_minutes" --arg status "$status" \
        '{"last_log_entry":$ts,"age_minutes":$age,"status":$status}'
}

# ---------------------------------------------------------------------------
# get_registry_roles — newline-separated list of registered role slugs
# ---------------------------------------------------------------------------
get_registry_roles() {
    [[ -f "$REGISTRY" ]] || { echo ""; return; }
    jq -r '.roles | keys[] | select(startswith("_") | not)' "$REGISTRY" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# check_integrity ROLE_DIR SLUG IN_REGISTRY — output integrity JSON object
# ---------------------------------------------------------------------------
check_integrity() {
    local role_dir="$1" slug="$2" in_registry="$3"
    local ok=true
    local missing=()

    if [[ "$in_registry" != "true" ]]; then
        missing+=("not_in_registry")
        ok=false
    fi

    for subdir in "queue/incoming" "queue/active" "queue/done" "queue/failed"; do
        if [[ ! -d "$role_dir/$subdir" ]]; then
            missing+=("$subdir")
            ok=false
        fi
    done

    # ROLE.md lives in the system roles directory, not the per-hive directory
    if [[ ! -f "$HIVEWRIGHT_ROOT/roles/$slug/ROLE.md" ]]; then
        missing+=("ROLE.md")
        ok=false
    fi

    local ok_json missing_json
    [[ "$ok" == "true" ]] && ok_json="true" || ok_json="false"

    if [[ ${#missing[@]} -eq 0 ]]; then
        missing_json="[]"
    else
        missing_json="$(printf '%s\n' "${missing[@]}" | jq -R . | jq -sc .)"
    fi

    printf '{"ok":%s,"missing":%s}' "$ok_json" "$missing_json"
}

# ---------------------------------------------------------------------------
# get_stuck_tasks ROLE_DIR SLUG THRESHOLD_MINUTES — output compact JSON array
# ---------------------------------------------------------------------------
get_stuck_tasks() {
    local role_dir="$1" slug="$2" threshold="$3"
    local active_dir="$role_dir/queue/active"

    if [[ ! -d "$active_dir" ]]; then
        echo "[]"; return
    fi

    local items=()
    while IFS= read -r f; do
        [[ -f "$f" ]] || continue
        local fname task_id mtime_epoch age_min
        fname="$(basename "$f")"
        task_id="${fname%.json}"
        mtime_epoch="$(stat -c %Y "$f" 2>/dev/null || echo "$NOW_EPOCH")"
        age_min=$(( (NOW_EPOCH - mtime_epoch) / 60 ))
        items+=("$(jq -nc --arg t "$task_id" --arg r "$slug" --argjson a "$age_min" \
            '{"task_id":$t,"role":$r,"age_minutes":$a}')")
    done < <(find "$active_dir" -maxdepth 1 -name "*.json" -mmin "+${threshold}" 2>/dev/null)

    if [[ ${#items[@]} -eq 0 ]]; then
        echo "[]"; return
    fi

    printf '%s\n' "${items[@]}" | jq -sc '.'
}

# ---------------------------------------------------------------------------
# collect_role_metrics ROLE_DIR SLUG REGISTRY_ROLES — output role JSON object
# ---------------------------------------------------------------------------
collect_role_metrics() {
    local role_dir="$1" slug="$2" registry_roles="$3"

    local incoming active done_1d done_7d failed_1d failed_7d
    incoming="$(count_all  "$role_dir/queue/incoming")"
    active="$(count_all    "$role_dir/queue/active")"
    done_1d="$(count_recent  "$role_dir/queue/done"   1)"
    done_7d="$(count_recent  "$role_dir/queue/done"   7)"
    failed_1d="$(count_recent "$role_dir/queue/failed" 1)"
    failed_7d="$(count_recent "$role_dir/queue/failed" 7)"

    local total_7d completion_rate failure_rate
    total_7d=$(( done_7d + failed_7d ))
    completion_rate="$(float_div "$done_7d"  "$total_7d" "1.0")"
    failure_rate="$(float_div    "$failed_7d" "$total_7d" "0.0")"

    local in_registry="false"
    if echo "$registry_roles" | grep -qx "$slug" 2>/dev/null; then
        in_registry="true"
    fi

    local integrity stuck_tasks dir_ok has_stuck status
    integrity="$(check_integrity "$role_dir" "$slug" "$in_registry")"
    stuck_tasks="$(get_stuck_tasks "$role_dir" "$slug" 60)"

    dir_ok="$(printf '%s' "$integrity" | jq -r '.ok')"
    if [[ "$stuck_tasks" == "[]" ]]; then has_stuck="false"; else has_stuck="true"; fi

    status="GREEN"
    if   [[ "$has_stuck" == "true" ]] || [[ "$dir_ok" == "false" ]] || [[ $failed_7d -ge 5 ]]; then
        status="RED"
    elif [[ $incoming -gt 10 ]] || [[ $failed_7d -ge 2 ]] || [[ $active -gt 3 ]]; then
        status="YELLOW"
    fi

    jq -n \
        --arg     slug         "$slug"            \
        --argjson incoming     "$incoming"        \
        --argjson active       "$active"          \
        --argjson done_24h     "$done_1d"         \
        --argjson done_7d      "$done_7d"         \
        --argjson failed_24h   "$failed_1d"       \
        --argjson failed_7d    "$failed_7d"       \
        --argjson cr           "$completion_rate" \
        --argjson fr           "$failure_rate"    \
        --argjson stuck        "$stuck_tasks"     \
        --argjson integrity    "$integrity"       \
        --arg     status       "$status"          \
        '{
            slug:              $slug,
            incoming_count:    $incoming,
            active_count:      $active,
            done_24h:          $done_24h,
            done_7d:           $done_7d,
            failed_24h:        $failed_24h,
            failed_7d:         $failed_7d,
            completion_rate:   $cr,
            failure_rate:      $fr,
            stuck_tasks:       $stuck,
            directory_integrity: $integrity,
            status:            $status
        }'
}

# ---------------------------------------------------------------------------
# categorize_failure TEXT — classify failure text into a category string
# ---------------------------------------------------------------------------
categorize_failure() {
    local lower
    lower="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"

    if   printf '%s' "$lower" | grep -qE "model|token|context window|rate limit"; then
        echo "model_error"
    elif printf '%s' "$lower" | grep -qE "timeout|timed out|aborted"; then
        echo "timeout"
    elif printf '%s' "$lower" | grep -qE "unclear|ambiguous|insufficient context|missing"; then
        echo "unclear_brief"
    elif printf '%s' "$lower" | grep -qE "tool|exec|command|script|failed to run"; then
        echo "tool_failure"
    elif printf '%s' "$lower" | grep -qE "depends|dependency|blocked"; then
        echo "dependency_failure"
    else
        echo "unknown"
    fi
}

# ---------------------------------------------------------------------------
# mode_default — full health report
# ---------------------------------------------------------------------------
mode_default() {
    local registry_roles
    registry_roles="$(get_registry_roles)"

    local tmp
    tmp="$(mktemp)"
    # shellcheck disable=SC2064
    trap "rm -f '$tmp'" EXIT

    for role_dir in "$ROLES_DIR"/*/; do
        [[ -d "$role_dir" ]] || continue
        collect_role_metrics "$role_dir" "$(basename "$role_dir")" "$registry_roles" >> "$tmp"
    done

    local heartbeat generated_at
    heartbeat="$(get_dispatcher_heartbeat)"
    generated_at="$(date -Iseconds)"

    jq -s \
        --arg  generated_at "$generated_at" \
        --arg  hive        "$HIVE"     \
        --argjson heartbeat "$heartbeat"    \
        '{
            generated_at:          $generated_at,
            hive:              $hive,
            dispatcher_heartbeat:  $heartbeat,
            summary: {
                total_roles: length,
                green:  ([.[] | select(.status == "GREEN")]  | length),
                yellow: ([.[] | select(.status == "YELLOW")] | length),
                red:    ([.[] | select(.status == "RED")]    | length)
            },
            roles: .
        }' "$tmp"

    rm -f "$tmp"
    trap - EXIT
}

# ---------------------------------------------------------------------------
# mode_failures — failed task categorization report
# ---------------------------------------------------------------------------
mode_failures() {
    local tmp
    tmp="$(mktemp)"
    # shellcheck disable=SC2064
    trap "rm -f '$tmp'" EXIT

    for role_dir in "$ROLES_DIR"/*/; do
        [[ -d "$role_dir" ]] || continue
        local slug failed_dir
        slug="$(basename "$role_dir")"
        failed_dir="$role_dir/queue/failed"
        [[ -d "$failed_dir" ]] || continue

        for task_file in "$failed_dir"/*.json; do
            [[ -f "$task_file" ]] || continue

            local task_id result_text category mtime_epoch
            task_id="$(jq -r 'if .task_id then .task_id else "" end' "$task_file" 2>/dev/null || true)"
            [[ -n "${task_id:-}" ]] || task_id="$(basename "${task_file%.json}")"

            result_text="$(jq -r \
                '(.result_summary // .error // .failure_reason // "") | if type == "string" then . else tostring end' \
                "$task_file" 2>/dev/null || echo "")"

            category="$(categorize_failure "${result_text:-}")"
            mtime_epoch="$(stat -c %Y "$task_file" 2>/dev/null || echo "0")"

            jq -nc \
                --arg     task_id  "$task_id"       \
                --arg     role     "$slug"          \
                --arg     category "$category"      \
                --argjson mtime    "$mtime_epoch"   \
                '{"task_id":$task_id,"role":$role,"category":$category,"mtime":$mtime}' >> "$tmp"
        done
    done

    local cutoff_7d
    cutoff_7d=$(( NOW_EPOCH - 7 * 24 * 3600 ))

    jq -s --argjson cutoff "$cutoff_7d" '
        {
            failure_analysis: {
                total_failed: length,
                categories: {
                    model_error:        ([.[] | select(.category == "model_error")]        | length),
                    timeout:            ([.[] | select(.category == "timeout")]            | length),
                    unclear_brief:      ([.[] | select(.category == "unclear_brief")]      | length),
                    tool_failure:       ([.[] | select(.category == "tool_failure")]       | length),
                    dependency_failure: ([.[] | select(.category == "dependency_failure")] | length),
                    unknown:            ([.[] | select(.category == "unknown")]            | length)
                },
                patterns: (
                    [.[] | select(.mtime >= $cutoff)] |
                    group_by(.role) |
                    map(select(length >= 3) | {
                        type:      "same_role_repeated",
                        role:      .[0].role,
                        failed_7d: length
                    })
                ),
                failed_tasks: .
            }
        }
    ' "$tmp"

    rm -f "$tmp"
    trap - EXIT
}

# ---------------------------------------------------------------------------
# mode_stuck — list stuck active tasks
# ---------------------------------------------------------------------------
mode_stuck() {
    local tmp
    tmp="$(mktemp)"
    # shellcheck disable=SC2064
    trap "rm -f '$tmp'" EXIT

    for role_dir in "$ROLES_DIR"/*/; do
        [[ -d "$role_dir" ]] || continue
        get_stuck_tasks "$role_dir" "$(basename "$role_dir")" "$THRESHOLD" >> "$tmp"
    done

    jq -s --argjson threshold "$THRESHOLD" '
        (add // []) as $all |
        {
            threshold_minutes: $threshold,
            stuck_tasks:       $all,
            total_stuck:       ($all | length)
        }
    ' "$tmp"

    rm -f "$tmp"
    trap - EXIT
}

# ---------------------------------------------------------------------------
# Route to mode
# ---------------------------------------------------------------------------
case "$MODE" in
    default)  mode_default  ;;
    failures) mode_failures ;;
    stuck)    mode_stuck    ;;
esac
