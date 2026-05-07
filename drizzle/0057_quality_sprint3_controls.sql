ALTER TABLE "role_templates"
  ADD COLUMN IF NOT EXISTS "owner_pinned" boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "role_model_swap_watches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "role_slug" varchar(100) NOT NULL,
  "from_model" varchar(255),
  "to_model" varchar(255) NOT NULL,
  "tasks_to_watch" integer NOT NULL DEFAULT 5,
  "tasks_seen" integer NOT NULL DEFAULT 0,
  "quality_floor" real NOT NULL DEFAULT 0.7,
  "status" varchar(20) NOT NULL DEFAULT 'watching',
  "decision_id" uuid,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "role_model_swap_watches_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE,
  CONSTRAINT "role_model_swap_watches_role_slug_fkey"
    FOREIGN KEY ("role_slug") REFERENCES "role_templates"("slug") ON DELETE CASCADE,
  CONSTRAINT "role_model_swap_watches_decision_id_fkey"
    FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE SET NULL,
  CONSTRAINT "role_model_swap_watches_status_chk"
    CHECK ("status" IN ('watching', 'reverted', 'passed'))
);

CREATE INDEX IF NOT EXISTS "role_model_swap_watches_active_idx"
  ON "role_model_swap_watches" ("hive_id", "role_slug", "status", "created_at");
