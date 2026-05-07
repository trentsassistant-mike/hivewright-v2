#!/usr/bin/env bash
set -eo pipefail

APP_DIR="${HIVEWRIGHT_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$APP_DIR"

set -a
[ -f .env ] && source .env
if [ -n "${HIVEWRIGHT_EXTRA_ENV_FILE:-}" ] && [ -f "$HIVEWRIGHT_EXTRA_ENV_FILE" ]; then
  source "$HIVEWRIGHT_EXTRA_ENV_FILE"
fi
set +a

echo "[start-dispatcher] applying database migrations"
if ! npm run db:migrate:app; then
  echo "[start-dispatcher] migration gate failed; refusing to start dispatcher" >&2
  exit 1
fi
echo "[start-dispatcher] migrations complete; starting dispatcher bundle"

exec node dispatcher-bundle.js "$@"
