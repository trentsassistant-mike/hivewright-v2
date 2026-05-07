ALTER TABLE "goals" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_goals_archived_at_null" ON "goals" ("archived_at") WHERE "archived_at" IS NULL;--> statement-breakpoint
UPDATE "goals" SET "archived_at" = "updated_at" WHERE "status" IN ('cancelled', 'achieved', 'failed') AND "archived_at" IS NULL;