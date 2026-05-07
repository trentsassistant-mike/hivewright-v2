CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"goal_id" uuid,
	"type" varchar(10) NOT NULL,
	"assigned_role" varchar(100),
	"confidence" numeric(3, 2) NOT NULL,
	"reasoning" text NOT NULL,
	"provider" varchar(50) NOT NULL,
	"model" varchar(100),
	"was_fallback" boolean DEFAULT false NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifications_target_xor" CHECK (("classifications"."task_id" IS NOT NULL AND "classifications"."goal_id" IS NULL) OR ("classifications"."task_id" IS NULL AND "classifications"."goal_id" IS NOT NULL)),
	CONSTRAINT "classifications_type_values" CHECK ("classifications"."type" IN ('task', 'goal')),
	CONSTRAINT "classifications_role_only_for_task" CHECK ("classifications"."type" = 'task' OR "classifications"."assigned_role" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "classifier_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"classification_id" uuid,
	"provider" varchar(50) NOT NULL,
	"model" varchar(100) NOT NULL,
	"request_input" text NOT NULL,
	"request_prompt" text NOT NULL,
	"response_raw" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"cost_cents" integer,
	"latency_ms" integer NOT NULL,
	"success" boolean NOT NULL,
	"error_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_assigned_role_role_templates_slug_fk" FOREIGN KEY ("assigned_role") REFERENCES "public"."role_templates"("slug") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_superseded_by_classifications_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."classifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifier_logs" ADD CONSTRAINT "classifier_logs_classification_id_classifications_id_fk" FOREIGN KEY ("classification_id") REFERENCES "public"."classifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_classifications_task_current" ON "classifications" USING btree ("task_id","created_at" DESC NULLS LAST) WHERE "classifications"."superseded_by" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_classifications_goal_current" ON "classifications" USING btree ("goal_id","created_at" DESC NULLS LAST) WHERE "classifications"."superseded_by" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_classifier_logs_created" ON "classifier_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_classifier_logs_provider_success" ON "classifier_logs" USING btree ("provider","success","created_at" DESC NULLS LAST);
--> statement-breakpoint
INSERT INTO "adapter_config" ("business_id", "adapter_type", "config")
VALUES (
  NULL,
  'work-intake',
  '{
    "primaryProvider": "ollama",
    "primaryModel": "qwen3:32b",
    "fallbackProvider": "openrouter",
    "fallbackModel": "google/gemini-2.0-flash-exp:free",
    "confidenceThreshold": 0.60,
    "timeoutMs": 15000,
    "temperature": 0.1,
    "maxTokens": 512
  }'::jsonb
)
ON CONFLICT DO NOTHING;