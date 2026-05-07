-- Goal comments: durable feedback thread per goal.
-- Owners post comments to request rework or note dissatisfaction.
-- Cascade-on-delete matches all other goal-child tables.

CREATE TABLE IF NOT EXISTS "goal_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "goal_id" uuid NOT NULL,
  "body" text NOT NULL,
  "created_by" varchar(255) NOT NULL DEFAULT 'owner',
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "goal_comments_goal_id_goals_id_fk"
    FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "goal_comments_goal_id_created_at_idx"
  ON "goal_comments" ("goal_id", "created_at" DESC NULLS FIRST);
