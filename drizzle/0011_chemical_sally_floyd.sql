DROP INDEX "goal_completions_goal_id_idx";--> statement-breakpoint
CREATE INDEX "goal_completions_goal_id_created_at_idx" ON "goal_completions" USING btree ("goal_id","created_at" DESC NULLS LAST);