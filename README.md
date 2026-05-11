# HiveWright

HiveWright is an owner-facing outcome engine for running a hive autonomously: a business, a project, or a personal operation. You set the mission and the goals, HiveWright infers or applies the right professional process, keeps work moving, and only pulls you in when your judgement is needed.

This root README is the operator entry point. It focuses on first run, day-one setup, health checks, backup, update, and support. Deeper technical material lives under `docs/`.

## What HiveWright Is

HiveWright gives you:

- A dashboard for hives, goals, tasks, decisions, memory, and live activity.
- Outcome-led goal supervision: owners state desired results, while supervisors check policies and procedures, plan execution, gather evidence, and use pipelines only when an approved process-bound procedure fits.
- A guided new-hive flow at `Hives -> New Hive`.
- Setup pages for models, connectors, embeddings, work intake, and setup health.
- A built-in docs page at `/docs` that lists live roles, skills, and connectors from the running install.

Today, HiveWright runs from this repository and a local Postgres database. There is not a separate packaged installer in this repo yet, so first run still includes a few terminal commands.

## First Run

If someone else is handling the machine for you, ask them to complete the command-line steps below, then start at `/login`.

1. Install dependencies:

```bash
npm install
```

2. Create and fill in your `.env` file with the database and secret values this install needs.

3. Apply database migrations:

```bash
npm run db:migrate:app
```

4. Start the dashboard:

```bash
npm run dev
```

5. Open the dashboard in your browser and go to `/login`.

6. If this is a brand-new install, HiveWright will show `Create owner account`. Create the first owner, then sign in.

7. In a second terminal, start the dispatcher so HiveWright can actually run work:

```bash
npm run build:dispatcher
./start-dispatcher.sh
```

If you run HiveWright as user services instead of ad-hoc terminals, this repo includes `hivewrightv2-dashboard.service` and `hivewrightv2-dispatcher.service` as reference units.

## Setup Walkthrough

After you sign in, use this order:

1. Open `Hives -> New Hive`.
2. Enter the hive name, what kind of hive it is, what it does, and the mission you want it to operate toward.
3. Pick the runtime starting point that best matches your install. The default recommended option is the safest starting point for most hives.
4. Connect the services HiveWright should use first. For most owners, that means at least one communication channel so the system can reach you.
5. Add your first goal so the hive has real work to do.
6. Open `Setup`.

Then review:

- `Models` for model availability and health.
- `Connectors` for service installs, test results, and activation.
- `Embeddings` for memory search.
- `Work Intake` for how incoming requests are sorted.
- `Setup Health` for the final readiness checklist.

If you are unsure where to start, create one hive, connect one outbound service, add one real goal, and then use `Setup Health` to see what still needs attention.

## Setup Health

Open `Setup -> Setup Health` any time you want a plain-English readiness check.

The page tells you, row by row, whether the current hive is:

- ready
- pending
- not set up
- needs attention

Each row includes a short summary and a direct link to the page where you fix it. This is the best place to check after first run, after changing credentials, or after restoring from backup.

## Backup

HiveWright does not provide a one-click backup flow in the dashboard yet. For now, back up the install directly:

1. Back up the Postgres database.

```bash
pg_dump "$DATABASE_URL" > hivewright-$(date +%F).sql
```

2. Back up `.env`.

3. Back up this repository checkout and any local project folders you keep alongside the install.

Before relying on a backup, test that you can restore it on another machine or a throwaway database.

## Update

When you update HiveWright from `main`, use this order:

```bash
git pull
npm install
npm run db:migrate:app
systemctl --user restart hivewrightv2-dashboard
./scripts/deferred-restart-dispatcher.sh 10
```

Notes:

- If you do not use the included user-service pattern, restart the dashboard and dispatcher using your normal process manager instead.
- The deferred dispatcher restart is the safer restart path when HiveWright may still be posting an owner-facing reply.
- After every update, open `Setup -> Setup Health` and confirm the active hive still shows the expected state.

## Troubleshooting

### I cannot sign in

- Open `/login`.
- If this is the first boot and no owner exists yet, create the first owner there.
- If setup is already complete, use the existing owner email and password instead.

### The hive was created, but setup still feels incomplete

Open `Setup -> Setup Health`. That page is the intended checklist for incomplete models, connectors, memory setup, or other missing readiness pieces.

### A connector was installed but does not work

Open `Setup -> Connectors`, run the connector test again, and read the latest result. If the page says the dispatcher must be restarted or activated, do that before testing again.

### The dashboard is not loading

If you run the included user services, check:

```bash
systemctl --user status hivewrightv2-dashboard
journalctl --user -u hivewrightv2-dashboard -n 200 --no-pager
```

### HiveWright is signed in, but work is not moving

Check the dispatcher:

```bash
systemctl --user status hivewrightv2-dispatcher
journalctl --user -u hivewrightv2-dispatcher -n 200 --no-pager
```

If the dispatcher was stopped for a while, start it again and then re-check `Setup Health`.

### Voice EA help

Voice setup is documented separately in [docs/voice-ea/README.md](docs/voice-ea/README.md).

## Where Deeper Docs Live

- In-app live catalogue: `/docs`
- Outcome engine architecture: [docs/architecture/outcome-engine.md](docs/architecture/outcome-engine.md)
- Technical and operational docs: [docs/](docs/)
- Voice EA runbook: [docs/voice-ea/README.md](docs/voice-ea/README.md)

If you are operating the system day to day, start with this README and the dashboard's `Setup Health` page. If you are changing infrastructure, credentials, services, or runtime behavior, move into `docs/`.
