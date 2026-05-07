#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
START_DISPATCHER="$ROOT_DIR/start-dispatcher.sh"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

write_fixture_app() {
  local app_dir="$1"
  local migrate_exit="$2"

  mkdir -p "$app_dir"
  touch "$app_dir/.env"

  cat > "$app_dir/package.json" <<JSON
{"scripts":{"db:migrate:app":"node migrate.js"}}
JSON

  cat > "$app_dir/migrate.js" <<JS
const fs = require("fs");
fs.appendFileSync("order.log", "migrate\\n");
process.exit($migrate_exit);
JS

  cat > "$app_dir/dispatcher-bundle.js" <<'JS'
const fs = require("fs");
fs.appendFileSync("order.log", "start\n");
JS
}

success_app="$TMP_DIR/success-app"
write_fixture_app "$success_app" 0
HIVEWRIGHT_APP_DIR="$success_app" bash "$START_DISPATCHER" > "$TMP_DIR/success.out" 2>&1

success_order="$(cat "$success_app/order.log")"
if [[ "$success_order" != $'migrate\nstart' ]]; then
  echo "expected migration before dispatcher start, got:" >&2
  printf '%s\n' "$success_order" >&2
  exit 1
fi

failure_app="$TMP_DIR/failure-app"
write_fixture_app "$failure_app" 42
set +e
HIVEWRIGHT_APP_DIR="$failure_app" bash "$START_DISPATCHER" > "$TMP_DIR/failure.out" 2>&1
failure_status=$?
set -e

if [[ "$failure_status" -eq 0 ]]; then
  echo "expected migration failure to abort dispatcher startup" >&2
  exit 1
fi

failure_order="$(cat "$failure_app/order.log")"
if [[ "$failure_order" != "migrate" ]]; then
  echo "expected dispatcher not to start after migration failure, got:" >&2
  printf '%s\n' "$failure_order" >&2
  exit 1
fi

if ! grep -q "migration gate failed; refusing to start dispatcher" "$TMP_DIR/failure.out"; then
  echo "expected fail-closed migration error message" >&2
  cat "$TMP_DIR/failure.out" >&2
  exit 1
fi

echo "start-dispatcher migration gate: success ordering and failure abort verified"
