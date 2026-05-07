#!/usr/bin/env bash
set -u -o pipefail

MODE="${1:-daily}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
REPORT_DIR="${SECURITY_SCAN_REPORT_DIR:-$ROOT_DIR/artifacts/security/$STAMP}"
BASELINE_EXIT=0
OPTIONAL_FAILURES=0
OPTIONAL_WARNINGS=()

usage() {
  echo "Usage: npm run security:scan:daily | npm run security:scan:weekly"
}

write_manifest() {
  local status="$1"
  local warnings_json=""
  local warning
  for warning in "${OPTIONAL_WARNINGS[@]}"; do
    warning="${warning//\\/\\\\}"
    warning="${warning//\"/\\\"}"
    warnings_json="${warnings_json}\"$warning\","
  done
  warnings_json="${warnings_json%,}"
  mkdir -p "$REPORT_DIR"
  cat > "$REPORT_DIR/manifest.json" <<EOF
{
  "mode": "$MODE",
  "repo": "$ROOT_DIR",
  "createdAt": "$STAMP",
  "status": "$status",
  "baselineExit": $BASELINE_EXIT,
  "optionalFailures": $OPTIONAL_FAILURES,
  "optionalWarnings": [$warnings_json]
}
EOF
}

run_optional() {
  local name="$1"
  local command_name="$2"
  shift 2

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "[security-scan] optional $name skipped: $command_name not installed"
    OPTIONAL_WARNINGS+=("$name skipped: $command_name not installed")
    return 0
  fi

  echo "[security-scan] running optional $name"
  if "$@"; then
    echo "[security-scan] optional $name passed"
  else
    local status=$?
    echo "[security-scan] optional $name failed with exit $status"
    OPTIONAL_FAILURES=1
  fi
}

case "$MODE" in
  daily|weekly)
    ;;
  *)
    usage
    echo "Unknown mode: $MODE"
    exit 2
    ;;
esac

cd "$ROOT_DIR" || exit 2
mkdir -p "$REPORT_DIR"

echo "[security-scan] running baseline scanner ($MODE)"
SECURITY_SCAN_REPORT_DIR="$REPORT_DIR" npm run security:scan
BASELINE_EXIT=$?

if [ "$MODE" = "weekly" ]; then
  run_optional "trivy filesystem" "trivy" \
    trivy fs --scanners vuln,secret,misconfig --severity MEDIUM,HIGH,CRITICAL --exit-code 1 --format json --output "$REPORT_DIR/trivy-fs.json" "$ROOT_DIR"
  run_optional "semgrep TypeScript/OWASP" "semgrep" \
    semgrep scan --config p/owasp-top-ten --config p/typescript --json --output "$REPORT_DIR/semgrep.json" --error "$ROOT_DIR"
  REPORT_DIR="$REPORT_DIR" run_optional "shellcheck" "shellcheck" \
    bash -lc 'find scripts -name "*.sh" -print0 | xargs -0 shellcheck --format=json > "$REPORT_DIR/shellcheck.json"'
fi

if [ "$BASELINE_EXIT" -eq 0 ] && [ "$OPTIONAL_FAILURES" -eq 0 ]; then
  STATUS="pass"
elif [ "$BASELINE_EXIT" -eq 2 ]; then
  STATUS="error"
else
  STATUS="fail"
fi

write_manifest "$STATUS"
ln -sfn "$REPORT_DIR" "$ROOT_DIR/artifacts/security/latest"
echo "[security-scan] reports: $REPORT_DIR"

if [ "$BASELINE_EXIT" -ne 0 ]; then
  exit "$BASELINE_EXIT"
fi
exit "$OPTIONAL_FAILURES"
