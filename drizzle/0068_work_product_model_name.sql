ALTER TABLE work_products
  ADD COLUMN IF NOT EXISTS model_name varchar(100);
