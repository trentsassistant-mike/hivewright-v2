# Role Tools

## Required Credentials

None. All data sources are internal to the hive and reach you in the task brief (the `HiveHealthReport`). You do not query external services.

## Available Tools

- Read-only HTTP access to the local dashboard API at `http://localhost:3002/api/*` for dereferencing task/goal/decision IDs referenced by findings when extra context is needed. Internal callers must send `Authorization: Bearer $INTERNAL_SERVICE_TOKEN` on those requests.
- Shell read access (`ls`, `cat`, `git log`, `git show`) within the hive's workspace for inspecting commit history or work products.
- Write access is deliberately withheld — all state changes happen through the structured `SupervisorActions` output, which the dispatcher applies deterministically. This keeps every change auditable and bounded by the safety caps (≤5 spawns per run, 24h duplicate suppression).
