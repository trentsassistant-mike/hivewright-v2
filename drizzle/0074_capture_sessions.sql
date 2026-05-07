CREATE TABLE IF NOT EXISTS "capture_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "owner_user_id" varchar(255) NOT NULL,
  "owner_email" varchar(320) NOT NULL,
  "status" varchar(32) DEFAULT 'draft' NOT NULL,
  "consented_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "stopped_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "capture_scope" jsonb,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "evidence_summary" jsonb,
  "redacted_summary" text,
  "work_product_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "capture_sessions_status_check"
    CHECK ("status" IN (
      'draft',
      'recording',
      'stopped',
      'analysis_pending',
      'review_ready',
      'cancelled',
      'deleted'
    ))
);

CREATE INDEX IF NOT EXISTS "capture_sessions_hive_status_created_idx"
  ON "capture_sessions" ("hive_id", "status", "created_at");

CREATE INDEX IF NOT EXISTS "capture_sessions_owner_created_idx"
  ON "capture_sessions" ("owner_user_id", "created_at");
