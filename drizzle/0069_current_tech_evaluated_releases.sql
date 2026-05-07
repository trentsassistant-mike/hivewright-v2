CREATE TABLE IF NOT EXISTS "current_tech_evaluated_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "finding_key" varchar(255) NOT NULL,
  "source_url" text NOT NULL,
  "source_date" date NOT NULL,
  "first_seen_cycle_date" date NOT NULL,
  "last_seen_cycle_date" date NOT NULL,
  "disposition" varchar(64) NOT NULL,
  "confidence" numeric(4, 3) NOT NULL,
  "terminal_rationale" text,
  "next_trigger" text,
  "linked_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "linked_decision_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "material_signature" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_material_change_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "hive_id" uuid;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "finding_key" varchar(255);
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "source_url" text;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "source_date" date;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "first_seen_cycle_date" date;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "last_seen_cycle_date" date;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "disposition" varchar(64);
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "confidence" numeric(4, 3);
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "terminal_rationale" text;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "next_trigger" text;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "linked_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "linked_decision_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "material_signature" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "last_material_change_reason" text;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;

UPDATE "current_tech_evaluated_releases"
SET
  "linked_task_ids" = COALESCE("linked_task_ids", '{}'::uuid[]),
  "linked_decision_ids" = COALESCE("linked_decision_ids", '{}'::uuid[]),
  "material_signature" = COALESCE("material_signature", '{}'::jsonb);

ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "hive_id" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "finding_key" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "source_url" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "source_date" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "first_seen_cycle_date" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "last_seen_cycle_date" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "disposition" SET NOT NULL;
ALTER TABLE "current_tech_evaluated_releases"
  ALTER COLUMN "confidence" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'current_tech_evaluated_releases'
      AND constraint_name = 'current_tech_evaluated_releases_hive_id_hives_id_fk'
  ) THEN
    ALTER TABLE "current_tech_evaluated_releases"
      ADD CONSTRAINT "current_tech_evaluated_releases_hive_id_hives_id_fk"
      FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "current_tech_evaluated_releases_hive_key_idx"
  ON "current_tech_evaluated_releases" ("hive_id", "finding_key");

CREATE INDEX IF NOT EXISTS "current_tech_evaluated_releases_hive_last_seen_idx"
  ON "current_tech_evaluated_releases" ("hive_id", "last_seen_cycle_date" DESC);
