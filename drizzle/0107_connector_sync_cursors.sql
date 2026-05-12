CREATE TABLE IF NOT EXISTS connector_sync_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id uuid NOT NULL REFERENCES connector_installs(id) ON DELETE CASCADE,
  stream varchar(128) NOT NULL,
  cursor text,
  last_synced_at timestamp,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS connector_sync_cursors_install_stream_idx
  ON connector_sync_cursors (install_id, stream);
