ALTER TABLE "role_templates" ADD COLUMN "fallback_model" varchar(255);--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;