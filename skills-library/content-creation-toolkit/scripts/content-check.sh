#!/usr/bin/env bash
set -euo pipefail

# content-check.sh — Analyse content quality metrics from a text file.
# Usage: content-check.sh <file-path>
# No external network calls.

if [[ $# -lt 1 ]] || [[ ! -f "$1" ]]; then
  echo "Usage: content-check.sh <file-path>"
  echo "Error: Please provide a valid file path."
  exit 1
fi

FILE="$1"
CONTENT=$(cat "$FILE")

# --- Word count ---
WORD_COUNT=$(wc -w < "$FILE" | tr -d ' ')
echo "=== Content Quality Report ==="
echo "File: $FILE"
echo ""
echo "--- Basic Metrics ---"
echo "Word count: $WORD_COUNT"

# --- Paragraph count ---
PARA_COUNT=$(awk 'BEGIN{p=0; in_para=0} {
  if (NF > 0) {
    if (!in_para) { p++; in_para=1 }
  } else {
    in_para=0
  }
} END{print p}' "$FILE")
echo "Paragraph count: $PARA_COUNT"

# --- Sentence count and average length ---
# Count sentences by splitting on . ! ?
SENTENCE_COUNT=$(echo "$CONTENT" | grep -oE '[^.!?]+[.!?]' | wc -l | tr -d ' ')
if [[ "$SENTENCE_COUNT" -eq 0 ]]; then
  SENTENCE_COUNT=1
fi
AVG_SENTENCE_LEN=$((WORD_COUNT / SENTENCE_COUNT))
echo "Sentence count: $SENTENCE_COUNT"
echo "Average sentence length: $AVG_SENTENCE_LEN words"

# --- Passive voice detection ---
# Pattern: was/were/been/being + word ending in -ed (approximate past participle)
PASSIVE_COUNT=$(echo "$CONTENT" | grep -oiE '\b(was|were|been|being)\s+\w+ed\b' | wc -l | tr -d ' ')
if [[ "$SENTENCE_COUNT" -gt 0 ]]; then
  PASSIVE_PCT=$((PASSIVE_COUNT * 100 / SENTENCE_COUNT))
else
  PASSIVE_PCT=0
fi
echo "Passive voice instances: $PASSIVE_COUNT"
echo "Passive voice percentage: ${PASSIVE_PCT}%"

# --- Quality Flags ---
echo ""
echo "--- Quality Flags ---"
FLAGS=0

# Flag: average sentence too long
if [[ "$AVG_SENTENCE_LEN" -gt 25 ]]; then
  echo "⚠  LONG SENTENCES: Average sentence length ($AVG_SENTENCE_LEN words) exceeds 25 words."
  FLAGS=$((FLAGS + 1))
fi

# Flag: too much passive voice
if [[ "$PASSIVE_PCT" -gt 15 ]]; then
  echo "⚠  HIGH PASSIVE VOICE: ${PASSIVE_PCT}% of sentences contain passive constructions (threshold: 15%)."
  FLAGS=$((FLAGS + 1))
fi

# Flag: very short content
if [[ "$WORD_COUNT" -lt 100 ]]; then
  echo "⚠  SHORT CONTENT: Only $WORD_COUNT words. Consider expanding."
  FLAGS=$((FLAGS + 1))
fi

# Flag: very long content
if [[ "$WORD_COUNT" -gt 5000 ]]; then
  echo "⚠  LONG CONTENT: $WORD_COUNT words. Consider splitting into multiple pieces."
  FLAGS=$((FLAGS + 1))
fi

# Flag: individual long sentences (>40 words)
LONG_SENTENCES=$(echo "$CONTENT" | grep -oE '[^.!?]+[.!?]' | awk '{if (NF > 40) count++} END{print count+0}')
if [[ "$LONG_SENTENCES" -gt 0 ]]; then
  echo "⚠  VERY LONG SENTENCES: $LONG_SENTENCES sentence(s) exceed 40 words."
  FLAGS=$((FLAGS + 1))
fi

if [[ "$FLAGS" -eq 0 ]]; then
  echo "✅ No quality flags. Content looks good."
fi

echo ""
echo "=== End Report ==="
