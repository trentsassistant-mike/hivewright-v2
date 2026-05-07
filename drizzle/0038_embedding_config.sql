CREATE TABLE IF NOT EXISTS "embedding_config" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" varchar(32) NOT NULL,
  "model_name" varchar(255) NOT NULL,
  "dimension" integer NOT NULL,
  "api_credential_key" varchar(255),
  "endpoint_override" varchar(500),
  "status" varchar(32) DEFAULT 'ready' NOT NULL,
  "last_reembedded_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "updated_by" varchar(255)
);

CREATE INDEX IF NOT EXISTS "embedding_config_updated_at_idx"
  ON "embedding_config" ("updated_at" DESC);
