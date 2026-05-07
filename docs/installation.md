# Installation

HiveWright is self-hosted software. A normal install uses this repository for source code and templates, a local Postgres database for application state, and a local `.env` file for install-specific configuration.

## Requirements

- Node.js 20 or newer.
- npm.
- PostgreSQL with the extensions required by the migrations.
- A writable directory outside this repository for hive workspaces.

## First Install

```bash
git clone https://github.com/<owner>/<repo>.git hivewright
cd hivewright
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```dotenv
DATABASE_URL=postgres://hivewright:change-me@localhost:5432/hivewright
ENCRYPTION_KEY=generate-a-random-32-byte-base64-value
INTERNAL_SERVICE_TOKEN=generate-a-random-32-byte-hex-token
HIVES_WORKSPACE_ROOT=/absolute/path/outside/this/repo/hives
```

Then apply migrations and start the dashboard:

```bash
npm run db:migrate:app
npm run dev
```

Open `/login` in your browser. On a fresh database, HiveWright will prompt you to create the first owner account.

Start the dispatcher in a second terminal:

```bash
npm run build:dispatcher
./start-dispatcher.sh
```

## User Services

Editable systemd user service examples live in `packaging/systemd/`. They assume the checkout is at `~/hivewright`.

```bash
mkdir -p ~/.config/systemd/user
cp packaging/systemd/hivewright-dashboard.service.example ~/.config/systemd/user/hivewright-dashboard.service
cp packaging/systemd/hivewright-dispatcher.service.example ~/.config/systemd/user/hivewright-dispatcher.service
systemctl --user daemon-reload
systemctl --user enable --now hivewright-dashboard
systemctl --user enable --now hivewright-dispatcher
```

If your checkout is somewhere else, edit `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` before enabling the units.

## Runtime Data

Do not put owner data in this repository. Runtime state belongs in:

- Postgres for hives, goals, tasks, decisions, memory, credentials, schedules, voice sessions, and audit records.
- The configured `HIVES_WORKSPACE_ROOT` for hive/project files and attachments.
- Ignored local directories for logs, browser traces, screenshots, and agent runtime workspaces.

Back up the database, `.env`, and configured workspace roots. Do not rely on Git as a runtime backup.
