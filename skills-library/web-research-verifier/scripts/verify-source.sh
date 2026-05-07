#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# verify-source.sh — Quick source credibility assessment
#
# Usage:
#   verify-source.sh <URL>
#
# Checks HTTPS, known content-farm domains, and domain registration age via whois.
# Optionally fetches HTTP headers via curl (max 5s timeout).
#
# Exit codes:
#   0 = PROCEED-WITH-VERIFICATION (no flags)
#   1 = CAUTION-REQUIRED (one or more flags triggered) or usage error
# ---------------------------------------------------------------------------

usage() {
    cat >&2 <<'EOF'
Usage: verify-source.sh <URL>

Performs a quick credibility check on a URL:
  - Verifies HTTPS
  - Checks against known content-farm domain list
  - Looks up domain registration age via whois (if available)

Exit codes: 0=PROCEED-WITH-VERIFICATION  1=CAUTION-REQUIRED or error
EOF
}

if [[ $# -lt 1 ]]; then
    usage
    exit 1
fi

URL="$1"

# ---------------------------------------------------------------------------
# HTTPS check
# ---------------------------------------------------------------------------
if [[ "$URL" == https://* ]]; then
    HTTPS_STATUS="YES"
else
    HTTPS_STATUS="NO"
fi

# ---------------------------------------------------------------------------
# Domain extraction
# Strip scheme, then strip path/query/fragment
# ---------------------------------------------------------------------------
DOMAIN="${URL#*://}"      # remove scheme
DOMAIN="${DOMAIN%%/*}"    # remove path
DOMAIN="${DOMAIN%%\?*}"   # remove query string
DOMAIN="${DOMAIN%%#*}"    # remove fragment
DOMAIN="${DOMAIN%%:*}"    # remove port if present
DOMAIN="${DOMAIN,,}"

# ---------------------------------------------------------------------------
# Content-farm domain list
# ---------------------------------------------------------------------------
FARM_DOMAINS=(
    buzzfeed.com
    listverse.com
    answers.com
    ehow.com
    livestrong.com
    about.com
    thoughtcatalog.com
    ranker.com
)

IS_FARM=false
for farm in "${FARM_DOMAINS[@]}"; do
    if [[ "$DOMAIN" == "$farm" ]] || [[ "$DOMAIN" == *."$farm" ]]; then
        IS_FARM=true
        break
    fi
done

# ---------------------------------------------------------------------------
# WHOIS age check
# ---------------------------------------------------------------------------
if command -v whois >/dev/null 2>&1; then
    WHOIS_OUTPUT=$(whois "$DOMAIN" 2>/dev/null || true)
    # Try common creation date field names (case-insensitive grep)
    WHOIS_AGE=$(printf '%s' "$WHOIS_OUTPUT" | grep -i "creation date\|created\|registered on\|domain registered" | head -1 || true)
    if [[ -z "$WHOIS_AGE" ]]; then
        WHOIS_AGE="creation date not found in whois output"
    fi
else
    WHOIS_AGE="whois not available"
fi

# ---------------------------------------------------------------------------
# Flag assembly
# ---------------------------------------------------------------------------
FLAGS=""

if [[ "$HTTPS_STATUS" == "NO" ]]; then
    FLAGS="NO_HTTPS"
fi

if [[ "$IS_FARM" == "true" ]]; then
    if [[ -n "$FLAGS" ]]; then
        FLAGS="${FLAGS},KNOWN_CONTENT_FARM"
    else
        FLAGS="KNOWN_CONTENT_FARM"
    fi
fi

if [[ -z "$FLAGS" ]]; then
    FLAGS="none"
fi

# ---------------------------------------------------------------------------
# Assessment
# ---------------------------------------------------------------------------
if [[ "$FLAGS" == "none" ]]; then
    ASSESSMENT="PROCEED-WITH-VERIFICATION"
    EXIT_CODE=0
else
    ASSESSMENT="CAUTION-REQUIRED"
    EXIT_CODE=1
fi

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
printf "=== Source Credibility Assessment ===\n"
printf "URL:        %s\n" "$URL"
printf "Domain:     %s\n" "$DOMAIN"
printf "HTTPS:      %s\n" "$HTTPS_STATUS"
printf "WHOIS Age:  %s\n" "$WHOIS_AGE"
printf "Flags:      %s\n" "$FLAGS"
printf "Assessment: %s\n" "$ASSESSMENT"

exit "$EXIT_CODE"
