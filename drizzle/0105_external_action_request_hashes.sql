ALTER TABLE external_action_requests
  ADD COLUMN IF NOT EXISTS request_payload_hash varchar(128),
  ADD COLUMN IF NOT EXISTS operation_risk_tier varchar(32);
