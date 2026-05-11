ALTER TABLE "pipeline_templates"
  ADD COLUMN IF NOT EXISTS "mode" varchar(50) DEFAULT 'production' NOT NULL,
  ADD COLUMN IF NOT EXISTS "default_sla_seconds" integer DEFAULT 900 NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_total_cost_cents" integer,
  ADD COLUMN IF NOT EXISTS "final_output_contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "dashboard_visibility_policy" varchar(50) DEFAULT 'summary_artifacts_only' NOT NULL;

ALTER TABLE "pipeline_steps"
  ADD COLUMN IF NOT EXISTS "max_runtime_seconds" integer DEFAULT 300 NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_retries" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "max_cost_cents" integer,
  ADD COLUMN IF NOT EXISTS "output_contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "acceptance_criteria" text,
  ADD COLUMN IF NOT EXISTS "failure_policy" varchar(50) DEFAULT 'retry_then_fail' NOT NULL,
  ADD COLUMN IF NOT EXISTS "drift_check" jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE "pipeline_templates"
SET
  "final_output_contract" = CASE
    WHEN "slug" = 'content-publishing' THEN '{"artifactKind":"publish_package","requiredFields":["title","body","channelNotes","verification"]}'::jsonb
    WHEN "slug" = 'product-build' THEN '{"artifactKind":"product_increment","requiredFields":["summary","changedFiles","verification","handoff"]}'::jsonb
    WHEN "slug" = 'ops-investigation' THEN '{"artifactKind":"ops_report","requiredFields":["rootCause","action","verification","nextAction"]}'::jsonb
    ELSE '{"artifactKind":"pipeline_handoff","requiredFields":["summary","verification","nextAction"]}'::jsonb
  END,
  "dashboard_visibility_policy" = 'summary_artifacts_only',
  "default_sla_seconds" = CASE
    WHEN "slug" = 'content-publishing' THEN 600
    WHEN "slug" = 'product-build' THEN 1800
    WHEN "slug" = 'ops-investigation' THEN 1200
    ELSE "default_sla_seconds"
  END,
  "mode" = CASE
    WHEN "slug" = 'product-build' THEN 'implementation'
    WHEN "slug" = 'ops-investigation' THEN 'research'
    ELSE "mode"
  END
WHERE "final_output_contract" = '{}'::jsonb
   OR "dashboard_visibility_policy" IS NULL;

UPDATE "pipeline_steps"
SET
  "output_contract" = jsonb_build_object(
    'artifactKind', COALESCE(NULLIF("slug", ''), 'step_result'),
    'requiredFields', jsonb_build_array('summary', 'verification')
  ),
  "acceptance_criteria" = COALESCE("acceptance_criteria", 'Deliver the step output contract, stay anchored to the original source task, and report blockers honestly.'),
  "drift_check" = CASE
    WHEN "drift_check" = '{}'::jsonb THEN '{"mode":"source_similarity","threshold":0.3}'::jsonb
    ELSE "drift_check"
  END
WHERE "output_contract" = '{}'::jsonb
   OR "acceptance_criteria" IS NULL
   OR "drift_check" = '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_templates_mode_check') THEN
    ALTER TABLE "pipeline_templates" ADD CONSTRAINT "pipeline_templates_mode_check" CHECK ("mode" IN ('production', 'research', 'implementation', 'qa', 'monitoring', 'support'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_templates_default_sla_seconds_check') THEN
    ALTER TABLE "pipeline_templates" ADD CONSTRAINT "pipeline_templates_default_sla_seconds_check" CHECK ("default_sla_seconds" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_templates_max_total_cost_cents_check') THEN
    ALTER TABLE "pipeline_templates" ADD CONSTRAINT "pipeline_templates_max_total_cost_cents_check" CHECK ("max_total_cost_cents" IS NULL OR "max_total_cost_cents" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_templates_dashboard_visibility_policy_check') THEN
    ALTER TABLE "pipeline_templates" ADD CONSTRAINT "pipeline_templates_dashboard_visibility_policy_check" CHECK ("dashboard_visibility_policy" IN ('summary_artifacts_only', 'artifact_only', 'debug_full_transcript'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_steps_max_runtime_seconds_check') THEN
    ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_max_runtime_seconds_check" CHECK ("max_runtime_seconds" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_steps_max_retries_check') THEN
    ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_max_retries_check" CHECK ("max_retries" >= 0 AND "max_retries" <= 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_steps_max_cost_cents_check') THEN
    ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_max_cost_cents_check" CHECK ("max_cost_cents" IS NULL OR "max_cost_cents" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_steps_failure_policy_check') THEN
    ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_failure_policy_check" CHECK ("failure_policy" IN ('retry_then_fail', 'fail_fast', 'ask_owner', 'continue_with_warning', 'skip_optional'));
  END IF;
END $$;
