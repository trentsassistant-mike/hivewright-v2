UPDATE role_templates
SET recommended_model = 'anthropic/claude-sonnet-4-6',
    updated_at = NOW()
WHERE recommended_model ILIKE '%haiku%';
--> statement-breakpoint
UPDATE role_templates
SET fallback_model = 'anthropic/claude-sonnet-4-6',
    updated_at = NOW()
WHERE fallback_model ILIKE '%haiku%';
--> statement-breakpoint
UPDATE tasks
SET model_override = 'anthropic/claude-sonnet-4-6',
    updated_at = NOW()
WHERE model_override ILIKE '%haiku%'
  AND status NOT IN ('completed', 'failed', 'cancelled', 'unresolvable');
