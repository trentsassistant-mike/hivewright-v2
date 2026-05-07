CREATE TABLE IF NOT EXISTS "initiative_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "trigger_type" varchar(64) NOT NULL DEFAULT 'schedule',
  "trigger_ref" varchar(255),
  "status" varchar(32) DEFAULT 'running' NOT NULL,
  "started_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  "evaluated_candidates" integer DEFAULT 0 NOT NULL,
  "created_count" integer DEFAULT 0 NOT NULL,
  "created_goals" integer DEFAULT 0 NOT NULL,
  "created_tasks" integer DEFAULT 0 NOT NULL,
  "created_decisions" integer DEFAULT 0 NOT NULL,
  "suppressed_count" integer DEFAULT 0 NOT NULL,
  "noop_count" integer DEFAULT 0 NOT NULL,
  "suppression_reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "guardrail_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "run_failures" integer DEFAULT 0 NOT NULL,
  "failure_reason" text
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'initiative_runs'
      AND column_name = 'trigger'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'initiative_runs'
      AND column_name = 'trigger_type'
  ) THEN
    ALTER TABLE "initiative_runs" RENAME COLUMN "trigger" TO "trigger_type";
  END IF;
END $$;

ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "trigger_type" varchar(64) DEFAULT 'schedule' NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "trigger_ref" varchar(255);
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "status" varchar(32) DEFAULT 'running' NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "started_at" timestamp DEFAULT now() NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "evaluated_candidates" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "created_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "created_goals" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "created_tasks" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "created_decisions" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "suppressed_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "noop_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "suppression_reasons" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "guardrail_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "run_failures" integer DEFAULT 0 NOT NULL;
ALTER TABLE "initiative_runs"
  ADD COLUMN IF NOT EXISTS "failure_reason" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'initiative_runs'
      AND constraint_name = 'initiative_runs_hive_id_hives_id_fk'
  ) THEN
    ALTER TABLE "initiative_runs"
      ADD CONSTRAINT "initiative_runs_hive_id_hives_id_fk"
      FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "initiative_runs_hive_started_idx"
  ON "initiative_runs" ("hive_id", "started_at" DESC);

CREATE TABLE IF NOT EXISTS "initiative_run_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "hive_id" uuid NOT NULL,
  "trigger_type" varchar(64) NOT NULL,
  "candidate_key" varchar(255) NOT NULL,
  "candidate_ref" varchar(255),
  "action_taken" varchar(32) NOT NULL,
  "rationale" text NOT NULL,
  "suppression_reason" varchar(128),
  "dedupe_key" varchar(255),
  "cooldown_hours" integer,
  "per_run_cap" integer,
  "per_day_cap" integer,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "action_payload" jsonb,
  "created_goal_id" uuid,
  "created_task_id" uuid,
  "created_decision_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "run_id" uuid;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "hive_id" uuid;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "trigger_type" varchar(64);
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "candidate_key" varchar(255);
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "candidate_ref" varchar(255);
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "action_taken" varchar(32);
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "rationale" text;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "suppression_reason" varchar(128);
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "dedupe_key" varchar(255);
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "cooldown_hours" integer;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "per_run_cap" integer;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "per_day_cap" integer;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "action_payload" jsonb;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "created_goal_id" uuid;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "created_task_id" uuid;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "created_decision_id" uuid;
ALTER TABLE "initiative_run_decisions"
  ADD COLUMN IF NOT EXISTS "created_at" timestamp DEFAULT now() NOT NULL;

UPDATE "initiative_run_decisions"
SET "trigger_type" = 'schedule'
WHERE "trigger_type" IS NULL;

UPDATE "initiative_run_decisions"
SET "candidate_key" = COALESCE("candidate_key", "candidate_ref", 'legacy')
WHERE "candidate_key" IS NULL;

UPDATE "initiative_run_decisions"
SET "action_taken" = 'noop'
WHERE "action_taken" IS NULL;

UPDATE "initiative_run_decisions"
SET "rationale" = 'Legacy initiative record'
WHERE "rationale" IS NULL;

ALTER TABLE "initiative_run_decisions"
  ALTER COLUMN "run_id" SET NOT NULL;
ALTER TABLE "initiative_run_decisions"
  ALTER COLUMN "hive_id" SET NOT NULL;
ALTER TABLE "initiative_run_decisions"
  ALTER COLUMN "trigger_type" SET NOT NULL;
ALTER TABLE "initiative_run_decisions"
  ALTER COLUMN "candidate_key" SET NOT NULL;
ALTER TABLE "initiative_run_decisions"
  ALTER COLUMN "action_taken" SET NOT NULL;
ALTER TABLE "initiative_run_decisions"
  ALTER COLUMN "rationale" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'initiative_run_decisions'
      AND constraint_name = 'initiative_run_decisions_run_id_initiative_runs_id_fk'
  ) THEN
    ALTER TABLE "initiative_run_decisions"
      ADD CONSTRAINT "initiative_run_decisions_run_id_initiative_runs_id_fk"
      FOREIGN KEY ("run_id") REFERENCES "public"."initiative_runs"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'initiative_run_decisions'
      AND constraint_name = 'initiative_run_decisions_hive_id_hives_id_fk'
  ) THEN
    ALTER TABLE "initiative_run_decisions"
      ADD CONSTRAINT "initiative_run_decisions_hive_id_hives_id_fk"
      FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'initiative_run_decisions'
      AND constraint_name = 'initiative_run_decisions_created_goal_id_goals_id_fk'
  ) THEN
    ALTER TABLE "initiative_run_decisions"
      ADD CONSTRAINT "initiative_run_decisions_created_goal_id_goals_id_fk"
      FOREIGN KEY ("created_goal_id") REFERENCES "public"."goals"("id")
      ON DELETE set null
      ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'initiative_run_decisions'
      AND constraint_name = 'initiative_run_decisions_created_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE "initiative_run_decisions"
      ADD CONSTRAINT "initiative_run_decisions_created_task_id_tasks_id_fk"
      FOREIGN KEY ("created_task_id") REFERENCES "public"."tasks"("id")
      ON DELETE set null
      ON UPDATE no action;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'initiative_run_decisions'
      AND constraint_name = 'initiative_run_decisions_created_decision_id_decisions_id_fk'
  ) THEN
    ALTER TABLE "initiative_run_decisions"
      ADD CONSTRAINT "initiative_run_decisions_created_decision_id_decisions_id_fk"
      FOREIGN KEY ("created_decision_id") REFERENCES "public"."decisions"("id")
      ON DELETE set null
      ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "initiative_run_decisions_run_created_idx"
  ON "initiative_run_decisions" ("run_id", "created_at" ASC);

CREATE INDEX IF NOT EXISTS "initiative_run_decisions_hive_dedupe_created_idx"
  ON "initiative_run_decisions" ("hive_id", "dedupe_key", "created_at" DESC);
