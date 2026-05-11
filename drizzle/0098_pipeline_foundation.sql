CREATE TABLE IF NOT EXISTS "pipeline_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" varchar(20) NOT NULL,
  "hive_id" uuid,
  "slug" varchar(100) NOT NULL,
  "name" varchar(255) NOT NULL,
  "department" varchar(100) NOT NULL,
  "description" text,
  "mode" varchar(50) DEFAULT 'production' NOT NULL,
  "default_sla_seconds" integer DEFAULT 900 NOT NULL,
  "max_total_cost_cents" integer,
  "final_output_contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dashboard_visibility_policy" varchar(50) DEFAULT 'summary_artifacts_only' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_templates_scope_check" CHECK ("scope" IN ('global', 'hive')),
  CONSTRAINT "pipeline_templates_hive_scope_check" CHECK (("scope" = 'global' AND "hive_id" IS NULL) OR ("scope" = 'hive' AND "hive_id" IS NOT NULL)),
  CONSTRAINT "pipeline_templates_version_check" CHECK ("version" >= 1),
  CONSTRAINT "pipeline_templates_mode_check" CHECK ("mode" IN ('production', 'research', 'implementation', 'qa', 'monitoring', 'support')),
  CONSTRAINT "pipeline_templates_default_sla_seconds_check" CHECK ("default_sla_seconds" > 0),
  CONSTRAINT "pipeline_templates_max_total_cost_cents_check" CHECK ("max_total_cost_cents" IS NULL OR "max_total_cost_cents" >= 0),
  CONSTRAINT "pipeline_templates_dashboard_visibility_policy_check" CHECK ("dashboard_visibility_policy" IN ('summary_artifacts_only', 'artifact_only', 'debug_full_transcript'))
);

CREATE TABLE IF NOT EXISTS "pipeline_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid NOT NULL,
  "step_order" integer NOT NULL,
  "slug" varchar(100) NOT NULL,
  "name" varchar(255) NOT NULL,
  "role_slug" varchar(100) NOT NULL,
  "duty" text NOT NULL,
  "skill_slugs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "connector_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "qa_required" boolean DEFAULT false NOT NULL,
  "max_runtime_seconds" integer DEFAULT 300 NOT NULL,
  "max_retries" integer DEFAULT 1 NOT NULL,
  "max_cost_cents" integer,
  "output_contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "acceptance_criteria" text,
  "failure_policy" varchar(50) DEFAULT 'retry_then_fail' NOT NULL,
  "drift_check" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pipeline_steps_order_check" CHECK ("step_order" >= 1),
  CONSTRAINT "pipeline_steps_max_runtime_seconds_check" CHECK ("max_runtime_seconds" > 0),
  CONSTRAINT "pipeline_steps_max_retries_check" CHECK ("max_retries" >= 0 AND "max_retries" <= 3),
  CONSTRAINT "pipeline_steps_max_cost_cents_check" CHECK ("max_cost_cents" IS NULL OR "max_cost_cents" >= 0),
  CONSTRAINT "pipeline_steps_failure_policy_check" CHECK ("failure_policy" IN ('retry_then_fail', 'fail_fast', 'ask_owner', 'continue_with_warning', 'skip_optional'))
);

CREATE TABLE IF NOT EXISTS "pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "template_id" uuid NOT NULL,
  "template_version" integer NOT NULL,
  "status" varchar(50) DEFAULT 'active' NOT NULL,
  "current_step_id" uuid,
  "source_task_id" uuid,
  "goal_id" uuid,
  "project_id" uuid,
  "supervisor_handoff" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "pipeline_runs_status_check" CHECK ("status" IN ('active', 'complete', 'failed', 'cancelled')),
  CONSTRAINT "pipeline_runs_template_version_check" CHECK ("template_version" >= 1)
);

CREATE TABLE IF NOT EXISTS "pipeline_step_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "step_id" uuid NOT NULL,
  "task_id" uuid,
  "status" varchar(50) DEFAULT 'pending' NOT NULL,
  "result_summary" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "pipeline_step_runs_status_check" CHECK ("status" IN ('pending', 'running', 'complete', 'failed', 'skipped'))
);

ALTER TABLE "pipeline_templates" ADD CONSTRAINT "pipeline_templates_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_template_id_pipeline_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."pipeline_templates"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pipeline_steps" ADD CONSTRAINT "pipeline_steps_role_slug_role_templates_slug_fk" FOREIGN KEY ("role_slug") REFERENCES "public"."role_templates"("slug") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_hive_id_hives_id_fk" FOREIGN KEY ("hive_id") REFERENCES "public"."hives"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_template_id_pipeline_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."pipeline_templates"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_current_step_id_pipeline_steps_id_fk" FOREIGN KEY ("current_step_id") REFERENCES "public"."pipeline_steps"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_step_id_pipeline_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."pipeline_steps"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "pipeline_step_runs" ADD CONSTRAINT "pipeline_step_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_templates_scope_hive_slug_version_idx" ON "pipeline_templates" USING btree ("scope", COALESCE("hive_id", '00000000-0000-0000-0000-000000000000'::uuid), "slug", "version");
CREATE INDEX IF NOT EXISTS "pipeline_templates_active_department_idx" ON "pipeline_templates" USING btree ("active", "department");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_steps_template_order_idx" ON "pipeline_steps" USING btree ("template_id", "step_order");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_steps_template_slug_idx" ON "pipeline_steps" USING btree ("template_id", "slug");
CREATE INDEX IF NOT EXISTS "pipeline_runs_hive_status_idx" ON "pipeline_runs" USING btree ("hive_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_step_runs_run_step_idx" ON "pipeline_step_runs" USING btree ("run_id", "step_id");
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_step_runs_task_idx" ON "pipeline_step_runs" USING btree ("task_id");
CREATE INDEX IF NOT EXISTS "pipeline_step_runs_run_status_idx" ON "pipeline_step_runs" USING btree ("run_id", "status");
