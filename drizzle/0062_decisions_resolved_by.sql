ALTER TABLE decisions
ADD COLUMN IF NOT EXISTS resolved_by text;
