-- Connector framework: the platform's extensibility layer. A Hive "installs"
-- a connector (Gmail, Xero, Discord, Stripe, …) by picking it from the
-- catalog, filling in the setup fields, and the runtime stores its secrets
-- in the existing `credentials` table (AES-256 at rest).
--
-- Tables are idempotent because this migration is applied out-of-journal
-- from scripts/setup-test-db.ts.

-- `connector_installs` — per-hive bindings of a catalog connector.
CREATE TABLE IF NOT EXISTS "connector_installs" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hive_id"        uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "connector_slug" varchar(100) NOT NULL,
  "display_name"   varchar(255) NOT NULL,
  "config"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "credential_id"  uuid REFERENCES "credentials"("id") ON DELETE SET NULL,
  "status"         varchar(32) NOT NULL DEFAULT 'active',
  "last_tested_at" timestamp,
  "last_error"     text,
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "updated_at"     timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_connector_installs_hive"
  ON "connector_installs" ("hive_id", "connector_slug");

-- `connector_events` — audit log of every invocation. Keeps operation,
-- result, duration, and any error text so the dashboard can show which
-- connectors are healthy and which keep failing.
CREATE TABLE IF NOT EXISTS "connector_events" (
  "id"          bigserial PRIMARY KEY,
  "install_id"  uuid NOT NULL REFERENCES "connector_installs"("id") ON DELETE CASCADE,
  "operation"   varchar(100) NOT NULL,
  "status"      varchar(32) NOT NULL,  -- success | error | skipped
  "duration_ms" integer,
  "error_text"  text,
  "actor"       varchar(100),          -- role slug or 'system'
  "created_at"  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_connector_events_install"
  ON "connector_events" ("install_id", "created_at" DESC);
