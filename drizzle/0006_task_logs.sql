CREATE TABLE "task_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"chunk" text NOT NULL,
	"type" varchar(20) NOT NULL,
	"timestamp" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_task_logs_task_id" ON "task_logs" ("task_id", "id");
