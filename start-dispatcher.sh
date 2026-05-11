#!/usr/bin/env bash
set -eo pipefail

APP_DIR="${HIVEWRIGHT_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$APP_DIR"

set -a
ENV_FILE="${HIVEWRIGHT_ENV_FILE:-${HIVEWRIGHT_RUNTIME_ROOT:-$HOME/.hivewright}/config/.env}"
[ -f "$ENV_FILE" ] && source "$ENV_FILE"
# Load OpenClaw secrets so subprocess agents inherit GITHUB_TOKEN, XAI_API_KEY,
# GEMINI_API_KEY, OPENAI_API_KEY — without these, openclaw config-load fails on
# missing env-var substitution and every agent crashes at boot.
SECRETS_FILE="${HIVEWRIGHT_SECRETS_FILE:-${HIVEWRIGHT_RUNTIME_ROOT:-$HOME/.hivewright}/secrets.env}"
[ -f "$SECRETS_FILE" ] && source "$SECRETS_FILE"
set +a

echo "[start-dispatcher] applying database migrations"
if ! npm run db:migrate:app; then
  echo "[start-dispatcher] migration gate failed; refusing to start dispatcher" >&2
  exit 1
fi
echo "[start-dispatcher] migrations complete; starting dispatcher bundle"

exec node dispatcher-bundle.js "$@"
