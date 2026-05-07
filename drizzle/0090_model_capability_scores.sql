CREATE TABLE model_capability_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_catalog_id uuid REFERENCES model_catalog(id) ON DELETE SET NULL,
  provider varchar(100) NOT NULL,
  adapter_type varchar(100) NOT NULL,
  model_id varchar(255) NOT NULL,
  canonical_model_id varchar(255) NOT NULL,
  axis varchar(50) NOT NULL,
  score numeric(5, 2) NOT NULL,
  raw_score varchar(255),
  source varchar(255) NOT NULL,
  source_url varchar(1000) NOT NULL,
  benchmark_name varchar(255) NOT NULL,
  model_version_matched varchar(255) NOT NULL,
  confidence varchar(20) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX model_capability_scores_model_axis_source_idx
  ON model_capability_scores(provider, adapter_type, canonical_model_id, axis, source, benchmark_name);

CREATE INDEX model_capability_scores_catalog_idx
  ON model_capability_scores(model_catalog_id);

CREATE INDEX model_capability_scores_axis_idx
  ON model_capability_scores(axis);
