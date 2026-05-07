#!/usr/bin/env bash
# Schedule a dispatcher restart to run AFTER the current EA turn has finished
# posting its reply. The EA runs inside the dispatcher process, so an inline
# `systemctl restart hivewright-dispatcher` kills the EA mid-reply and the
# pending Discord message is lost. Using systemd-run with a short timer
# detaches the restart from this process, so it survives the SIGTERM the
# dispatcher will receive and fires once the timer elapses.
#
# Usage: ./scripts/deferred-restart-dispatcher.sh [delay_seconds]
# Default delay: 10s (comfortable margin for a long-ish reply to post).

set -euo pipefail
DELAY="${1:-10}"
SERVICE="${HIVEWRIGHT_DISPATCHER_SERVICE:-hivewright-dispatcher}"

exec systemd-run \
  --user \
  --on-active="${DELAY}s" \
  --unit="${SERVICE}-deferred-restart-$(date +%s)" \
  --description="Deferred dispatcher restart (EA-safe)" \
  systemctl --user restart "$SERVICE"
