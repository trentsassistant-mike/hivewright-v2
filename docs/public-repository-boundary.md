# Public Repository Boundary

HiveWright's public repository is for reusable software. It should be possible to clone it on a new machine without receiving another operator's hives, decisions, memories, credentials, logs, or local service state.

## Belongs In Git

- Application source under `src/`.
- Database migrations under `drizzle/` and schema code under `src/db/`.
- Reusable role templates under `role-library/`.
- Reusable skills under `skills-library/`.
- Static product assets under `public/`.
- Package metadata, build scripts, and public documentation.
- Example configuration files with placeholders only.
- Service templates that use portable paths or clear placeholders.

## Does Not Belong In Git

- `.env`, real service tokens, API keys, OAuth secrets, encryption keys, cookies, or session files.
- Owner-created hives, goals, tasks, decisions, memories, attachments, work products, or database dumps.
- Agent runtime state such as `.claude/`, `.openclaw/`, `.codex/`, `.worktrees/`, `.playwright-mcp/`, `.next/`, `node_modules/`, and dispatcher bundles.
- Internal QA/proof artifacts, screenshots, browser traces, logs, local command transcripts, and live-system evidence.
- Maintainer-specific hostnames, usernames, absolute home paths, private service paths, or local database URLs.

## Configuration Rule

Public code should read install-specific values from environment variables, database settings, connector configuration, or operator-managed runtime directories. If required configuration is missing, HiveWright should fail with a setup-focused error instead of silently falling back to a maintainer's local machine.
