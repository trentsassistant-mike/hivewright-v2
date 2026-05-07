CREATE TABLE IF NOT EXISTS model_discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid REFERENCES hives(id) ON DELETE CASCADE,
  adapter_type varchar(100) NOT NULL,
  provider varchar(100) NOT NULL,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  source varchar(100) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'running',
  models_seen integer NOT NULL DEFAULT 0,
  models_imported integer NOT NULL DEFAULT 0,
  models_auto_enabled integer NOT NULL DEFAULT 0,
  models_marked_stale integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS model_discovery_runs_hive_adapter_idx
  ON model_discovery_runs (hive_id, adapter_type, started_at DESC);

ALTER TABLE model_catalog
  ADD COLUMN IF NOT EXISTS discovery_source varchar(100),
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_discovery_run_id uuid REFERENCES model_discovery_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stale_since timestamptz,
  ADD COLUMN IF NOT EXISTS deprecated_at timestamptz;

CREATE INDEX IF NOT EXISTS model_catalog_stale_since_idx
  ON model_catalog (stale_since);

ALTER TABLE hive_models
  ADD COLUMN IF NOT EXISTS auto_discovered boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS owner_disabled_reason text,
  ADD COLUMN IF NOT EXISTS last_discovery_run_id uuid REFERENCES model_discovery_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS hive_models_owner_disabled_idx
  ON hive_models (hive_id, owner_disabled_at)
  WHERE owner_disabled_at IS NOT NULL;
