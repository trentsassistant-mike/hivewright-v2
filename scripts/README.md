# Scripts

Any proof or verification script that needs an isolated hive must use
`withDisposableHive(...)` from [scripts/_lib/disposable-hive.ts](./_lib/disposable-hive.ts).

Rules:

- The helper creates a uniquely named `[TEST] ...` hive.
- The proof logic runs inside the callback.
- Teardown runs in `finally` and hard-deletes the hive plus dependent rows.
- Reviewers should reject PRs that hand-roll `INSERT INTO hives` inside proof or verification scripts.

Current audited proof scripts:

- `scripts/run-initiative-schedule.ts` uses `withDisposableHive(...)` for `--demo`.
- `scripts/tmp-ideas-proof.ts` uses `withDisposableHive(...)` for both disposable proof lanes.
- `scripts/setup-dormant-goal-proof-fixture.ts` and `scripts/run-dormant-goal-verification.ts` do not need the helper because they create isolated disposable databases and drop those databases after the run.

Manual QA fixtures that must remain visible in the running app may use a
deterministic, cleanup-backed fixture instead:

- `npm run qa:operations-map:parked-fixture` creates the visible Operations Map
  parked-state hive/task for browser QA.
- `npm run qa:operations-map:parked-fixture -- --cleanup` removes that fixture.

## Migration journal guard

Run `npm run check:migrations` before committing Drizzle migrations. The check compares
`drizzle/*.sql` file stems against `drizzle/meta/_journal.json` entry tags and fails on
missing, extra, duplicate, or out-of-order journal entries. `npm test` also runs this
guard before Vitest.

## Security preflight route

Use the existing security scan entrypoint for the local/pre-commit-compatible
security preflight route:

- tracked-file secret scanning via `gitleaks`
- dependency vulnerability scanning via `npm audit`
- optional generated-path preflight for bounded generated fixtures

The route reads the local `baseline-security-scan.json` report produced by
`npm run security:scan`. It does not claim GitHub MCP integration or GitHub
Advanced Security prompt/runtime code-path scanning support.

### Optional generated-path preflight

Run the generated-path adjunct check like this:

```bash
SECURITY_SCAN_REPORT_DIR=tmp/security-preflight \
  npm run security:scan -- \
  --generated-path tests/fixtures/security-preflight \
  --generated-path-only
```

This pilot emits the normal `baseline-security-scan.json` and
`baseline-security-scan.md` reports under `SECURITY_SCAN_REPORT_DIR`, but adds a
`generated-path-preflight` check that:

- flags obvious secret or credential-like material without echoing the matched value
- flags unbounded autonomy/completeness claims in generated owner/customer-facing text
- flags generated operational artifacts that omit evidence/provenance markers already used in this repo
