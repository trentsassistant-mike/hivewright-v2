ALTER TABLE "task_attachments" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_task_attachments_goal" ON "task_attachments" USING btree ("goal_id");--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_parent_check" CHECK (("task_attachments"."task_id" IS NOT NULL) OR ("task_attachments"."goal_id" IS NOT NULL));