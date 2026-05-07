-- OAuth state holder. Bridges the redirect round-trip between /start and
-- /callback for OAuth 2.0 authorization code grants. TTL ~10 minutes —
-- older rows are pruned lazily by the dispatcher.

CREATE TABLE IF NOT EXISTS "oauth_states" (
  "state"          varchar(128) PRIMARY KEY,
  "hive_id"        uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "connector_slug" varchar(100) NOT NULL,
  "display_name"   varchar(255) NOT NULL,
  "redirect_to"    text,                         -- where to send the user after success
  "created_at"     timestamp NOT NULL DEFAULT now(),
  "expires_at"     timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_oauth_states_expires"
  ON "oauth_states" ("expires_at");
