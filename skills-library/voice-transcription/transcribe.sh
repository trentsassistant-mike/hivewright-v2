#!/usr/bin/env bash
set -euo pipefail

HIVEWRIGHT_DATA_HOME="${HIVEWRIGHT_DATA_HOME:-${HOME}/.local/share/hivewright}"
COST_LOG="${HIVEWRIGHT_VOICE_TRANSCRIPTION_COST_LOG:-${HIVEWRIGHT_DATA_HOME}/logs/voice-transcription-cost.log}"
SUPPORTED_EXTS="flac mp3 mp4 mpeg mpga m4a ogg opus wav webm"

# 1. Validate argument present
if [[ $# -lt 1 ]]; then
    echo "Usage: transcribe.sh <audio-file-path>" >&2
    echo "Supported formats: ${SUPPORTED_EXTS}" >&2
    exit 1
fi

AUDIO_FILE="$1"

# 2. Validate file exists
if [[ ! -f "$AUDIO_FILE" ]]; then
    echo "File not found: ${AUDIO_FILE}" >&2
    exit 1
fi

# 3. Validate extension (case-insensitive)
filename="$(basename "$AUDIO_FILE")"
ext="${filename##*.}"
ext_lower="$(echo "$ext" | tr '[:upper:]' '[:lower:]')"

supported=0
for valid_ext in $SUPPORTED_EXTS; do
    if [[ "$ext_lower" == "$valid_ext" ]]; then
        supported=1
        break
    fi
done

if [[ "$supported" -eq 0 ]]; then
    echo "Unsupported file format: .${ext_lower}" >&2
    echo "Supported formats: ${SUPPORTED_EXTS}" >&2
    exit 1
fi

# 4. Check dependencies
if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl is not installed" >&2
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq is not installed" >&2
    exit 1
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
    echo "Error: OPENAI_API_KEY environment variable is not set" >&2
    exit 1
fi

# 5. Call Whisper API
response="$(curl -s -w "\n%{http_code}" \
    https://api.openai.com/v1/audio/transcriptions \
    -H "Authorization: Bearer ${OPENAI_API_KEY}" \
    -F "model=whisper-1" \
    -F "file=@${AUDIO_FILE}")"

http_code="$(echo "$response" | tail -n1)"
body="$(echo "$response" | head -n -1)"

if [[ "$http_code" != "200" ]]; then
    error_msg="$(echo "$body" | jq -r '.error.message // "Unknown API error"' 2>/dev/null || echo "Unknown API error")"
    echo "Whisper API error (HTTP ${http_code}): ${error_msg}" >&2
    exit 1
fi

# 6. Extract transcription text
transcription="$(echo "$body" | jq -r '.text // empty')"

if [[ -z "$transcription" ]]; then
    echo "Error: Empty or null transcription returned from API" >&2
    exit 1
fi

# 7. Append to cost log
file_size="$(wc -c <"$AUDIO_FILE")"
timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
mkdir -p "$(dirname "$COST_LOG")"
echo "${timestamp} | file=${filename} | size=${file_size}B | model=whisper-1 | cost=~\$0.001-0.006" >> "$COST_LOG" || true

# 8. Print transcription to stdout
echo "$transcription"
