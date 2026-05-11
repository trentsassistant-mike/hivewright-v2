#!/usr/bin/env bash
set -eo pipefail

RUNTIME_ROOT="${HIVEWRIGHT_RUNTIME_ROOT:-$HOME/.hivewright}"
ENV_FILE="${HIVEWRIGHT_ENV_FILE:-$RUNTIME_ROOT/config/.env}"
SECRETS_FILE="${HIVEWRIGHT_SECRETS_FILE:-$RUNTIME_ROOT/secrets.env}"

set -a
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
fi
set +a

export PATH="$PWD/node_modules/.bin:$PATH"

exec "$@"
