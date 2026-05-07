CREATE TABLE IF NOT EXISTS "hive_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "provider" varchar(100) NOT NULL,
  "model_id" varchar(255) NOT NULL,
  "adapter_type" varchar(100) NOT NULL,
  "credential_id" uuid REFERENCES "credentials"("id") ON DELETE SET NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cost_per_input_token" numeric(20, 12),
  "cost_per_output_token" numeric(20, 12),
  "fallback_priority" integer DEFAULT 100 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "hive_models_hive_provider_model_idx"
  ON "hive_models" ("hive_id", "provider", "model_id");

CREATE INDEX IF NOT EXISTS "hive_models_hive_enabled_priority_idx"
  ON "hive_models" ("hive_id", "enabled", "fallback_priority");

CREATE INDEX IF NOT EXISTS "hive_models_credential_idx"
  ON "hive_models" ("credential_id");

CREATE TABLE IF NOT EXISTS "model_health" (
  "fingerprint" varchar(64) NOT NULL,
  "model_id" varchar(255) NOT NULL,
  "status" varchar(32) DEFAULT 'unknown' NOT NULL,
  "last_probed_at" timestamp with time zone,
  "last_failed_at" timestamp with time zone,
  "last_failure_reason" text,
  "next_probe_at" timestamp with time zone,
  "latency_ms" integer,
  "sample_cost_usd" numeric(12, 6),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "model_health_pkey" PRIMARY KEY ("fingerprint", "model_id")
);

CREATE INDEX IF NOT EXISTS "model_health_next_probe_idx"
  ON "model_health" ("next_probe_at");

CREATE INDEX IF NOT EXISTS "model_health_status_idx"
  ON "model_health" ("status");
