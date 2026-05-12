ALTER TABLE connector_installs
  ADD COLUMN IF NOT EXISTS granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
