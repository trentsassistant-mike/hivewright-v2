-- Per-task runtime override. Used by the doctor self-healing path to retry a
-- failed doctor task on a different runtime without changing the role default.

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "adapter_override" varchar(100);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "model_override" varchar(255);
