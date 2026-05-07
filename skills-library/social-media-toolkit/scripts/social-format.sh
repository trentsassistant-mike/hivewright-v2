#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# social-format.sh — Social media character count and hashtag checker
#
# Usage:
#   social-format.sh --platform PLATFORM --text 'TEXT' [--hashtags 'TAG1 TAG2'] [--check-only]
#
# Platforms (case-insensitive):
#   twitter, linkedin, instagram, facebook, tiktok, threads, bluesky
#
# Exit codes:
#   0 = PASS (text within platform limit)
#   1 = FAIL (text exceeds limit or invalid arguments)
# ---------------------------------------------------------------------------

PLATFORM=""
TEXT=""
HASHTAGS=""
CHECK_ONLY=false

usage() {
    cat >&2 <<'EOF'
Usage: social-format.sh --platform PLATFORM --text 'TEXT' [--hashtags 'TAG1 TAG2'] [--check-only]

Platforms: twitter, linkedin, instagram, facebook, tiktok, threads, bluesky

Options:
  --platform   Platform name (case-insensitive)
  --text       Post text to validate
  --hashtags   Space-separated hashtags (optional, for count warning)
  --check-only Silent mode — exit code only, no output

Exit codes: 0=PASS  1=FAIL
EOF
}

if [[ $# -lt 1 ]]; then
    usage
    exit 1
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --platform)
            [[ $# -lt 2 ]] && { echo "Error: --platform requires a value" >&2; exit 1; }
            PLATFORM="$2"; shift 2 ;;
        --text)
            [[ $# -lt 2 ]] && { echo "Error: --text requires a value" >&2; exit 1; }
            TEXT="$2"; shift 2 ;;
        --hashtags)
            [[ $# -lt 2 ]] && { echo "Error: --hashtags requires a value" >&2; exit 1; }
            HASHTAGS="$2"; shift 2 ;;
        --check-only)
            CHECK_ONLY=true; shift ;;
        --help|-h)
            usage; exit 0 ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            usage
            exit 1 ;;
    esac
done

if [[ -z "$PLATFORM" ]]; then
    echo "Error: --platform is required" >&2
    exit 1
fi

if [[ -z "$TEXT" ]]; then
    echo "Error: --text is required" >&2
    exit 1
fi

# Normalize platform to lowercase (POSIX-compatible)
PLATFORM_LOWER=$(printf '%s' "$PLATFORM" | tr '[:upper:]' '[:lower:]')

# Platform character limits and hashtag recommended ranges
case "$PLATFORM_LOWER" in
    twitter|x)
        LIMIT=280
        HT_REC="2-3"
        HT_MAX=3
        PLATFORM_DISPLAY="twitter"
        LINK_NOTE="Note:       Twitter t.co links count as 23 chars regardless of actual URL length"
        ;;
    linkedin)
        LIMIT=3000
        HT_REC="3-5"
        HT_MAX=5
        PLATFORM_DISPLAY="linkedin"
        LINK_NOTE=""
        ;;
    instagram)
        LIMIT=2200
        HT_REC="5 in caption + 25 in first comment (30 max)"
        HT_MAX=30
        PLATFORM_DISPLAY="instagram"
        LINK_NOTE="Note:       No clickable links in captions — use bio link only"
        ;;
    facebook)
        LIMIT=63206
        HT_REC="3-5"
        HT_MAX=5
        PLATFORM_DISPLAY="facebook"
        LINK_NOTE=""
        ;;
    tiktok)
        LIMIT=2200
        HT_REC="3-5"
        HT_MAX=5
        PLATFORM_DISPLAY="tiktok"
        LINK_NOTE="Note:       Links in bio only — captions do not support clickable URLs"
        ;;
    threads)
        LIMIT=500
        HT_REC="1-2 inline (5 max)"
        HT_MAX=5
        PLATFORM_DISPLAY="threads"
        LINK_NOTE=""
        ;;
    bluesky)
        LIMIT=300
        HT_REC="1-2"
        HT_MAX=2
        PLATFORM_DISPLAY="bluesky"
        LINK_NOTE="Note:       Links generate auto-card previews — no need to repeat title in text"
        ;;
    *)
        echo "Error: Unknown platform: ${PLATFORM}" >&2
        echo "Supported platforms: twitter, linkedin, instagram, facebook, tiktok, threads, bluesky" >&2
        exit 1
        ;;
esac

# Character count (bash string length counts bytes in some locales; use printf for portability)
LENGTH=${#TEXT}
REMAINING=$((LIMIT - LENGTH))

# Hashtag count from space-separated input
HT_COUNT=0
HT_WARN=""
if [[ -n "$HASHTAGS" ]]; then
    for _tag in $HASHTAGS; do
        HT_COUNT=$((HT_COUNT + 1))
    done
    if [[ $HT_COUNT -gt $HT_MAX ]]; then
        HT_WARN=" ⚠ exceeds recommended max of ${HT_MAX}"
    fi
fi

# Check-only mode: no output, just exit code
if [[ "$CHECK_ONLY" == "true" ]]; then
    if [[ $REMAINING -ge 0 ]]; then
        exit 0
    else
        exit 1
    fi
fi

# Output report
printf "Platform:   %s\n" "$PLATFORM_DISPLAY"
printf "Limit:      %d\n" "$LIMIT"
printf "Length:     %d\n" "$LENGTH"
printf "Remaining:  %d\n" "$REMAINING"

if [[ -n "$HASHTAGS" ]]; then
    if [[ -z "$HT_WARN" ]]; then
        printf "Hashtags:   %d (recommended: %s) ✓\n" "$HT_COUNT" "$HT_REC"
    else
        printf "Hashtags:   %d (recommended: %s)%s\n" "$HT_COUNT" "$HT_REC" "$HT_WARN"
    fi
fi

if [[ -n "$LINK_NOTE" ]]; then
    printf "%s\n" "$LINK_NOTE"
fi

if [[ $REMAINING -ge 0 ]]; then
    printf "Status:     PASS\n"
    exit 0
else
    OVER=$((-REMAINING))
    printf "Status:     FAIL — text exceeds limit by %d characters\n" "$OVER"
    exit 1
fi
