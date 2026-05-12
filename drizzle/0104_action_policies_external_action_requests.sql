CREATE TABLE IF NOT EXISTS action_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL DEFAULT 'Action policy',
  enabled boolean NOT NULL DEFAULT true,
  connector varchar(128),
  operation varchar(128),
  effect_type varchar(32),
  effect varchar(32) NOT NULL,
  role_slug varchar(100) REFERENCES role_templates(slug) ON DELETE SET NULL,
  priority integer NOT NULL DEFAULT 0,
  conditions jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  description text,
  created_by varchar(255),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT action_policies_effect_check CHECK (effect IN ('allow', 'require_approval', 'block')),
  CONSTRAINT action_policies_effect_type_check CHECK (effect_type IS NULL OR effect_type IN ('read', 'notify', 'write', 'financial', 'destructive', 'system')),
  CONSTRAINT action_policies_conditions_object_check CHECK (jsonb_typeof(conditions) = 'object')
);

CREATE INDEX IF NOT EXISTS action_policies_hive_connector_operation_idx
  ON action_policies (hive_id, connector, operation);

CREATE INDEX IF NOT EXISTS action_policies_hive_role_idx
  ON action_policies (hive_id, role_slug);

CREATE TABLE IF NOT EXISTS external_action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  goal_id uuid REFERENCES goals(id) ON DELETE SET NULL,
  decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  policy_id uuid REFERENCES action_policies(id) ON DELETE SET NULL,
  connector varchar(128) NOT NULL,
  operation varchar(128) NOT NULL,
  role_slug varchar(100) REFERENCES role_templates(slug) ON DELETE SET NULL,
  state varchar(32) NOT NULL DEFAULT 'proposed',
  idempotency_key varchar(255),
  external_reference text,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  execution_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_execution_payload text,
  error_message text,
  requested_by varchar(255),
  reviewed_by varchar(255),
  reviewed_at timestamp,
  executed_at timestamp,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT external_action_requests_state_check CHECK (
    state IN (
      'proposed',
      'blocked',
      'awaiting_approval',
      'approved',
      'rejected',
      'executing',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  CONSTRAINT external_action_requests_request_payload_object_check CHECK (jsonb_typeof(request_payload) = 'object'),
  CONSTRAINT external_action_requests_response_payload_object_check CHECK (jsonb_typeof(response_payload) = 'object'),
  CONSTRAINT external_action_requests_policy_snapshot_object_check CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  CONSTRAINT external_action_requests_execution_metadata_object_check CHECK (jsonb_typeof(execution_metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS external_action_requests_hive_state_created_idx
  ON external_action_requests (hive_id, state, created_at);

CREATE INDEX IF NOT EXISTS external_action_requests_task_idx
  ON external_action_requests (task_id);

CREATE INDEX IF NOT EXISTS external_action_requests_goal_idx
  ON external_action_requests (goal_id);

CREATE INDEX IF NOT EXISTS external_action_requests_decision_idx
  ON external_action_requests (decision_id);

CREATE UNIQUE INDEX IF NOT EXISTS external_action_requests_hive_idempotency_key_unique
  ON external_action_requests (hive_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
