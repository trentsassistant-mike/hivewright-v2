UPDATE model_catalog
SET cost_per_input_token = NULL,
    cost_per_output_token = NULL,
    benchmark_quality_score = NULL,
    routing_cost_score = NULL,
    metadata_source_name = NULL,
    metadata_source_url = NULL,
    metadata_last_checked_at = NOW(),
    updated_at = NOW()
WHERE metadata_source_name = 'Estimated metadata from discovered model family';

UPDATE model_catalog
SET cost_per_input_token = NULL,
    cost_per_output_token = NULL,
    benchmark_quality_score = NULL,
    routing_cost_score = NULL,
    metadata_last_checked_at = NOW(),
    updated_at = NOW()
WHERE metadata_source_name IN (
  'OpenAI public model docs',
  'Anthropic public model docs',
  'Google Gemini public model docs',
  'Gemini public model docs'
)
  AND (
    cost_per_input_token IS NOT NULL
    OR cost_per_output_token IS NOT NULL
    OR benchmark_quality_score IS NOT NULL
    OR routing_cost_score IS NOT NULL
  );

UPDATE model_catalog
SET benchmark_quality_score = NULL,
    metadata_last_checked_at = NOW(),
    updated_at = NOW()
WHERE (provider = 'local' OR adapter_type = 'ollama' OR model_id LIKE 'ollama/%')
  AND metadata_source_name IN (
    'Local Ollama runtime',
    'Ollama Tags API'
  )
  AND benchmark_quality_score IS NOT NULL;

UPDATE hive_models hm
SET cost_per_input_token = mc.cost_per_input_token,
    cost_per_output_token = mc.cost_per_output_token,
    benchmark_quality_score = mc.benchmark_quality_score,
    routing_cost_score = mc.routing_cost_score,
    updated_at = NOW()
FROM model_catalog mc
WHERE hm.model_catalog_id = mc.id
  AND (
    mc.metadata_source_name IS NULL
    OR mc.metadata_source_name IN (
      'OpenAI public model docs',
      'Anthropic public model docs',
      'Google Gemini public model docs',
      'Gemini public model docs',
      'Local Ollama runtime',
      'Ollama Tags API'
    )
  )
  AND (
    hm.cost_per_input_token IS DISTINCT FROM mc.cost_per_input_token
    OR hm.cost_per_output_token IS DISTINCT FROM mc.cost_per_output_token
    OR hm.benchmark_quality_score IS DISTINCT FROM mc.benchmark_quality_score
    OR hm.routing_cost_score IS DISTINCT FROM mc.routing_cost_score
  );
