-- Add fallback_adapter_type so a role can declare a different adapter for
-- its fallback model than its primary. Lets e.g. "OpenClaw gpt-5.4 primary,
-- Claude-code sonnet fallback" survive a GPU or provider outage. NULL means
-- "use same adapter as primary" (legacy behaviour).

ALTER TABLE "role_templates" ADD COLUMN IF NOT EXISTS "fallback_adapter_type" varchar(100);
