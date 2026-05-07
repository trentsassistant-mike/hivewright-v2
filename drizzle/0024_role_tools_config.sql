-- Add per-role MCP/tool scope. NULL = inherit runtime defaults (no behaviour change).
ALTER TABLE role_templates ADD COLUMN IF NOT EXISTS tools_config JSONB DEFAULT NULL;
