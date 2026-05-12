CREATE TABLE IF NOT EXISTS business_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  connector_install_id uuid REFERENCES connector_installs(id) ON DELETE SET NULL,
  source_connector varchar(128) NOT NULL,
  external_id text NOT NULL,
  record_type varchar(128) NOT NULL,
  status varchar(128),
  title text,
  occurred_at timestamp,
  amount_cents integer,
  currency varchar(16),
  counterparty text,
  normalized jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS business_records_source_key_idx
  ON business_records (hive_id, source_connector, external_id, record_type);
