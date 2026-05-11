-- Tune content-publishing pipeline runtime bounds for real Codex worker latency.
-- The initial content template used 90-180s step limits, which caused the watchdog to retry/fail
-- long-running but healthy step-1 content tasks before their agent output was ready.

WITH content_template AS (
  SELECT id
  FROM pipeline_templates
  WHERE slug = 'content-publishing'
)
UPDATE pipeline_steps ps
SET
  max_runtime_seconds = CASE ps.slug
    WHEN 'brief' THEN 900
    WHEN 'draft' THEN 1200
    WHEN 'edit' THEN 900
    WHEN 'design' THEN 600
    WHEN 'publish-handoff' THEN 600
    ELSE ps.max_runtime_seconds
  END,
  updated_at = NOW()
FROM content_template ct
WHERE ps.template_id = ct.id
  AND ps.slug IN ('brief', 'draft', 'edit', 'design', 'publish-handoff');
