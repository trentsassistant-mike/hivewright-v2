#!/usr/bin/env bash
# Idempotent case-aware rename: business → hive across an allowlist of paths.
# Order matters: longest/uppercase variants first so substring shadowing doesn't
# leak (e.g. BUSINESSES must run before BUSINESS).

set -euo pipefail

SCOPES=(
  "src"
  "tests"
  "role-library"
  "skills-library"
  "ea-templates"
)

FILES_GLOB='\.(ts|tsx|js|jsx|md|yaml|yml|json|sql)$'

# Word-boundary-aware replacements ordered longest-first.
# Each pair: search → replace.
REPLACEMENTS=(
  "BUSINESSES|HIVES"
  "Businesses|Hives"
  "businesses|hives"
  "BUSINESS|HIVE"
  "Business|Hive"
  "business|hive"
)

for scope in "${SCOPES[@]}"; do
  if [ ! -d "$scope" ]; then
    echo "Skipping missing scope: $scope" >&2
    continue
  fi
  echo "Renaming in $scope/"
  files=$(find "$scope" -type f | grep -E "$FILES_GLOB" || true)
  if [ -z "$files" ]; then continue; fi
  for pair in "${REPLACEMENTS[@]}"; do
    search="${pair%|*}"
    replace="${pair#*|}"
    echo "  $search → $replace"
    # shellcheck disable=SC2086
    echo "$files" | xargs sed -i "s/${search}/${replace}/g"
  done
done

echo "Rename pass complete. Review changes with: git diff --stat"
