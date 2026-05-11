# Public Repository Boundary

HiveWright keeps the application repository source-only. The repo is safe to publish because operational state is not meant to live here.

## What belongs in this repo

- Application source code under `src/`
- Database schema and migrations under `drizzle/`
- Reusable role and skill templates that are safe for publication
- Install/config examples such as `.env.example`
- Public-safe documentation
- Tests and test fixtures that do not contain maintainer-specific paths or secrets

## What must stay outside this repo

- Hive data, goals, tasks, decisions, memories, and runtime records
- Credentials, tokens, OAuth sessions, cookies, API keys, and private env files
- Attachments, generated work products, screenshots, QA evidence, proof packs, browser traces, logs, and run outputs
- Local agent identity/runtime files such as `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.openclaw/`, `.superpowers/`, and `.hivewright-ctx/`
- Internal planning, audit, security, QA, design evidence, research, handoffs, and work-product docs

## Runtime storage model

- Postgres stores system state: hives, goals, tasks, decisions, memories, run records, and durable application data.
- Encrypted credential storage holds service credentials; only secret names/placeholders belong in source.
- `HIVEWRIGHT_RUNTIME_ROOT` is the root for install-specific runtime files. If unset, HiveWright defaults to `$HOME/.hivewright`.
- `HIVEWRIGHT_ENV_FILE` can point to an external env file. If unset, HiveWright writes setup config to `$HIVEWRIGHT_RUNTIME_ROOT/config/.env`.
- `HIVES_WORKSPACE_ROOT` points to external hive workspaces. If unset, HiveWright defaults to `$HIVEWRIGHT_RUNTIME_ROOT/hives`.
- Runtime roots are rejected if they resolve inside the software repository.

## Enforcement

Run this before committing or promoting code:

```bash
npm run repo:boundary
```

The scanner checks tracked files with `git ls-files`, so it catches files that `.gitignore` cannot protect after they have already been tracked.

## Public mirror promotion

The public GitHub mirror must be updated from an allowlisted source tree only. Do not push the private operational checkout directly. The mirror should run its own public-readiness scanner before any push.
