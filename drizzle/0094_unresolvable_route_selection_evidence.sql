ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS route_selection_evidence jsonb;

ALTER TABLE decisions
ADD COLUMN IF NOT EXISTS route_metadata jsonb;

CREATE INDEX IF NOT EXISTS tasks_route_selection_evidence_outcome_idx
ON tasks ((route_selection_evidence ->> 'outcome'))
WHERE route_selection_evidence IS NOT NULL;

CREATE INDEX IF NOT EXISTS decisions_route_metadata_outcome_idx
ON decisions ((route_metadata ->> 'outcome'))
WHERE route_metadata IS NOT NULL;
