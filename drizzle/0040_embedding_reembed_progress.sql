ALTER TABLE "embedding_config"
  ADD COLUMN IF NOT EXISTS "reembed_total" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "reembed_processed" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "reembed_started_at" timestamp,
  ADD COLUMN IF NOT EXISTS "reembed_finished_at" timestamp,
  ADD COLUMN IF NOT EXISTS "last_error" text;

CREATE TABLE IF NOT EXISTS "embedding_reembed_errors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "config_id" uuid NOT NULL REFERENCES "public"."embedding_config"("id") ON DELETE cascade,
  "memory_embedding_id" uuid NOT NULL REFERENCES "public"."memory_embeddings"("id") ON DELETE cascade,
  "source_type" varchar(50) NOT NULL,
  "source_id" uuid NOT NULL,
  "chunk_text" text NOT NULL,
  "error_message" text NOT NULL,
  "attempt_count" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "embedding_reembed_errors_config_memory_idx"
  ON "embedding_reembed_errors" ("config_id", "memory_embedding_id");

CREATE INDEX IF NOT EXISTS "embedding_reembed_errors_updated_at_idx"
  ON "embedding_reembed_errors" ("updated_at" DESC);
