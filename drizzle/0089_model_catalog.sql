CREATE TABLE IF NOT EXISTS model_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(100) NOT NULL,
  adapter_type varchar(100) NOT NULL,
  model_id varchar(255) NOT NULL,
  display_name varchar(255) NOT NULL,
  family varchar(120),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  local boolean NOT NULL DEFAULT false,
  cost_per_input_token numeric(20, 12),
  cost_per_output_token numeric(20, 12),
  benchmark_quality_score numeric(5, 2),
  routing_cost_score numeric(5, 2),
  metadata_source_name varchar(255),
  metadata_source_url varchar(1000),
  metadata_last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS model_catalog_provider_adapter_model_idx
  ON model_catalog (provider, adapter_type, model_id);

CREATE INDEX IF NOT EXISTS model_catalog_adapter_idx
  ON model_catalog (adapter_type);

ALTER TABLE hive_models
  ADD COLUMN IF NOT EXISTS model_catalog_id uuid;

ALTER TABLE hive_models
  ADD COLUMN IF NOT EXISTS cost_per_input_token numeric(20, 12),
  ADD COLUMN IF NOT EXISTS cost_per_output_token numeric(20, 12),
  ADD COLUMN IF NOT EXISTS benchmark_quality_score numeric(5, 2),
  ADD COLUMN IF NOT EXISTS routing_cost_score numeric(5, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'hive_models_model_catalog_id_model_catalog_id_fk'
  ) THEN
    ALTER TABLE hive_models
      ADD CONSTRAINT hive_models_model_catalog_id_model_catalog_id_fk
      FOREIGN KEY (model_catalog_id)
      REFERENCES model_catalog(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hive_models_model_catalog_idx
  ON hive_models (model_catalog_id);

INSERT INTO model_catalog (
  provider,
  adapter_type,
  model_id,
  display_name,
  capabilities,
  local,
  cost_per_input_token,
  cost_per_output_token,
  benchmark_quality_score,
  routing_cost_score,
  metadata_source_name,
  metadata_source_url,
  metadata_last_checked_at,
  updated_at
)
SELECT DISTINCT
  hm.provider,
  hm.adapter_type,
  hm.model_id,
  hm.model_id,
  COALESCE(hm.capabilities, '[]'::jsonb),
  hm.provider = 'local' OR hm.adapter_type = 'ollama',
  hm.cost_per_input_token,
  hm.cost_per_output_token,
  hm.benchmark_quality_score,
  hm.routing_cost_score,
  CASE
    WHEN hm.benchmark_quality_score IS NOT NULL OR hm.cost_per_input_token IS NOT NULL THEN 'Existing HiveWright model rows'
    ELSE NULL
  END,
  NULL,
  CASE
    WHEN hm.benchmark_quality_score IS NOT NULL OR hm.cost_per_input_token IS NOT NULL THEN now()
    ELSE NULL
  END,
  now()
FROM hive_models hm
ON CONFLICT (provider, adapter_type, model_id) DO UPDATE
SET
  capabilities = CASE
    WHEN model_catalog.capabilities = '[]'::jsonb THEN EXCLUDED.capabilities
    ELSE model_catalog.capabilities
  END,
  local = model_catalog.local OR EXCLUDED.local,
  cost_per_input_token = COALESCE(model_catalog.cost_per_input_token, EXCLUDED.cost_per_input_token),
  cost_per_output_token = COALESCE(model_catalog.cost_per_output_token, EXCLUDED.cost_per_output_token),
  benchmark_quality_score = COALESCE(model_catalog.benchmark_quality_score, EXCLUDED.benchmark_quality_score),
  routing_cost_score = COALESCE(model_catalog.routing_cost_score, EXCLUDED.routing_cost_score),
  updated_at = now();

UPDATE hive_models hm
SET model_catalog_id = mc.id
FROM model_catalog mc
WHERE hm.model_catalog_id IS NULL
  AND mc.provider = hm.provider
  AND mc.adapter_type = hm.adapter_type
  AND mc.model_id = hm.model_id;
