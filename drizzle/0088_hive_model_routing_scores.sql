ALTER TABLE hive_models
  ADD COLUMN benchmark_quality_score numeric(5, 2),
  ADD COLUMN routing_cost_score numeric(5, 2);
