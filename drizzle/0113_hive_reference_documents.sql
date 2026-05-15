CREATE TABLE IF NOT EXISTS hive_reference_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  filename text NOT NULL,
  relative_path text NOT NULL,
  mime_type text,
  size_bytes integer NOT NULL DEFAULT 0,
  uploaded_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  UNIQUE (hive_id, relative_path)
);

CREATE INDEX IF NOT EXISTS hive_reference_documents_hive_idx
  ON hive_reference_documents(hive_id, uploaded_at DESC);
