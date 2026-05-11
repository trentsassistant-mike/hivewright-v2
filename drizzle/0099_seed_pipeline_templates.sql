-- Seed first-class global pipeline templates so the dashboard has visible workflow paths.

INSERT INTO role_templates (slug, name, type, adapter_type)
VALUES
  ('research-analyst', 'Research Analyst', 'executor', 'claude-code'),
  ('operations-coordinator', 'Operations Coordinator', 'executor', 'claude-code'),
  ('dev-agent', 'Developer Agent', 'executor', 'claude-code'),
  ('quality-reviewer', 'Quality Reviewer', 'executor', 'claude-code'),
  ('hive-supervisor', 'Hive Supervisor', 'system', 'internal'),
  ('content-writer', 'Content Writer', 'executor', 'claude-code'),
  ('content-review-agent', 'Content Review Agent', 'executor', 'claude-code'),
  ('marketing-designer', 'Marketing Designer', 'executor', 'claude-code'),
  ('social-media-manager', 'Social Media Manager', 'executor', 'claude-code'),
  ('intelligence-analyst', 'Intelligence Analyst', 'executor', 'claude-code')
ON CONFLICT (slug) DO NOTHING;

WITH product_template AS (
  INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, description, mode, default_sla_seconds, max_total_cost_cents, final_output_contract, dashboard_visibility_policy, version, active)
  VALUES (
    'global', NULL, 'product-build', 'Product Build Pipeline', 'product',
    'Turns an idea or goal into a scoped, built, reviewed, and shipped product increment.',
    'implementation', 1800, 500,
    '{"artifactKind":"product_increment","requiredFields":["summary","changedFiles","verification","handoff"]}'::jsonb,
    'summary_artifacts_only', 1, true
  )
  ON CONFLICT ("scope", COALESCE("hive_id", '00000000-0000-0000-0000-000000000000'::uuid), "slug", "version") DO UPDATE SET
    name = EXCLUDED.name, department = EXCLUDED.department, description = EXCLUDED.description,
    mode = EXCLUDED.mode, default_sla_seconds = EXCLUDED.default_sla_seconds,
    max_total_cost_cents = EXCLUDED.max_total_cost_cents, final_output_contract = EXCLUDED.final_output_contract,
    dashboard_visibility_policy = EXCLUDED.dashboard_visibility_policy, active = EXCLUDED.active, updated_at = NOW()
  RETURNING id
)
INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract, acceptance_criteria, failure_policy, drift_check)
SELECT id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract::jsonb, acceptance_criteria, failure_policy, drift_check::jsonb
FROM product_template
CROSS JOIN (VALUES
  (1, 'intake', 'Intake', 'research-analyst', 'Clarify the source idea, goal, constraints, and success criteria.', false, 240, 1, 75, '{"artifactKind":"intake_brief","requiredFields":["goal","constraints","successCriteria"]}', 'Must preserve original owner intent and identify success criteria.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.35}'),
  (2, 'scope', 'Scope', 'operations-coordinator', 'Break the work into a bounded implementation packet with risks and acceptance criteria.', false, 300, 1, 100, '{"artifactKind":"implementation_packet","requiredFields":["tasks","risks","acceptanceCriteria"]}', 'Must produce a bounded implementation packet, not open-ended research.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.35}'),
  (3, 'build', 'Build', 'dev-agent', 'Implement the scoped product change and preserve existing behavior.', true, 900, 1, 250, '{"artifactKind":"code_change","requiredFields":["changedFiles","tests","verification"]}', 'Must implement only scoped changes and report verification.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.3}'),
  (4, 'review', 'Review', 'quality-reviewer', 'Review the implementation, tests, safety, and product fit before release.', true, 300, 1, 75, '{"artifactKind":"qa_verdict","requiredFields":["verdict","findings","verification"]}', 'Must produce PASS/FAIL with evidence.', 'fail_fast', '{"mode":"source_similarity","threshold":0.3}'),
  (5, 'ship-handoff', 'Ship / Handoff', 'hive-supervisor', 'Summarize what shipped, what is blocked, and what the owner should review next.', false, 180, 0, 50, '{"artifactKind":"handoff","requiredFields":["summary","artifacts","verification","nextAction"]}', 'Must create concise owner-facing handoff.', 'fail_fast', '{"mode":"source_similarity","threshold":0.3}')
) AS step_data(step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract, acceptance_criteria, failure_policy, drift_check)
ON CONFLICT (template_id, step_order) DO UPDATE SET
  slug = EXCLUDED.slug, name = EXCLUDED.name, role_slug = EXCLUDED.role_slug, duty = EXCLUDED.duty,
  qa_required = EXCLUDED.qa_required, max_runtime_seconds = EXCLUDED.max_runtime_seconds,
  max_retries = EXCLUDED.max_retries, max_cost_cents = EXCLUDED.max_cost_cents,
  output_contract = EXCLUDED.output_contract, acceptance_criteria = EXCLUDED.acceptance_criteria,
  failure_policy = EXCLUDED.failure_policy, drift_check = EXCLUDED.drift_check, updated_at = NOW();

WITH content_template AS (
  INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, description, mode, default_sla_seconds, max_total_cost_cents, final_output_contract, dashboard_visibility_policy, version, active)
  VALUES (
    'global', NULL, 'content-publishing', 'Fast Content Publishing Pipeline', 'content',
    'Moves content from brief through draft, edit, approval, and publishing handoff with production-grade time and output bounds.',
    'production', 600, 250,
    '{"artifactKind":"publish_package","requiredFields":["title","body","channelNotes","verification"]}'::jsonb,
    'summary_artifacts_only', 1, true
  )
  ON CONFLICT ("scope", COALESCE("hive_id", '00000000-0000-0000-0000-000000000000'::uuid), "slug", "version") DO UPDATE SET
    name = EXCLUDED.name, department = EXCLUDED.department, description = EXCLUDED.description,
    mode = EXCLUDED.mode, default_sla_seconds = EXCLUDED.default_sla_seconds,
    max_total_cost_cents = EXCLUDED.max_total_cost_cents, final_output_contract = EXCLUDED.final_output_contract,
    dashboard_visibility_policy = EXCLUDED.dashboard_visibility_policy, active = EXCLUDED.active, updated_at = NOW()
  RETURNING id
)
INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract, acceptance_criteria, failure_policy, drift_check)
SELECT id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract::jsonb, acceptance_criteria, failure_policy, drift_check::jsonb
FROM content_template
CROSS JOIN (VALUES
  (1, 'brief', 'Brief', 'content-writer', 'Define audience, angle, promise, source material, and publishing constraints.', false, 90, 1, 40, '{"artifactKind":"content_brief","requiredFields":["audience","angle","promise","outline"]}', 'Must produce a concise brief only; no long research dump.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.45}'),
  (2, 'draft', 'Draft', 'content-writer', 'Create the first complete draft in the requested format and voice.', false, 180, 1, 100, '{"artifactKind":"blog_draft","requiredFields":["title","body","cta"]}', 'Must output the actual draft, not a plan to draft.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.45}'),
  (3, 'edit', 'Edit', 'content-review-agent', 'Tighten clarity, accuracy, structure, and owner-facing quality.', true, 90, 1, 50, '{"artifactKind":"edited_draft","requiredFields":["title","body","changeNotes"]}', 'Must preserve source intent while improving clarity.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.45}'),
  (4, 'design', 'Design Asset', 'marketing-designer', 'Prepare supporting visual or distribution assets only when needed.', false, 120, 0, 40, '{"artifactKind":"distribution_asset","requiredFields":["assetDecision","assetNotes"]}', 'May explicitly skip if no visual asset is needed.', 'skip_optional', '{"mode":"source_similarity","threshold":0.35}'),
  (5, 'publish-handoff', 'Publish / Handoff', 'social-media-manager', 'Prepare the final publish package, channel notes, and follow-up metrics.', false, 120, 0, 40, '{"artifactKind":"publish_handoff","requiredFields":["artifactLinks","channelNotes","verification","nextAction"]}', 'Must produce a concise publish package and mark blockers honestly.', 'fail_fast', '{"mode":"source_similarity","threshold":0.4}')
) AS step_data(step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract, acceptance_criteria, failure_policy, drift_check)
ON CONFLICT (template_id, step_order) DO UPDATE SET
  slug = EXCLUDED.slug, name = EXCLUDED.name, role_slug = EXCLUDED.role_slug, duty = EXCLUDED.duty,
  qa_required = EXCLUDED.qa_required, max_runtime_seconds = EXCLUDED.max_runtime_seconds,
  max_retries = EXCLUDED.max_retries, max_cost_cents = EXCLUDED.max_cost_cents,
  output_contract = EXCLUDED.output_contract, acceptance_criteria = EXCLUDED.acceptance_criteria,
  failure_policy = EXCLUDED.failure_policy, drift_check = EXCLUDED.drift_check, updated_at = NOW();

WITH ops_template AS (
  INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, description, mode, default_sla_seconds, max_total_cost_cents, final_output_contract, dashboard_visibility_policy, version, active)
  VALUES (
    'global', NULL, 'ops-investigation', 'Ops Investigation Pipeline', 'operations',
    'Handles operational issues from intake through investigation, execution, QA, and owner report.',
    'research', 1200, 300,
    '{"artifactKind":"ops_report","requiredFields":["rootCause","action","verification","nextAction"]}'::jsonb,
    'summary_artifacts_only', 1, true
  )
  ON CONFLICT ("scope", COALESCE("hive_id", '00000000-0000-0000-0000-000000000000'::uuid), "slug", "version") DO UPDATE SET
    name = EXCLUDED.name, department = EXCLUDED.department, description = EXCLUDED.description,
    mode = EXCLUDED.mode, default_sla_seconds = EXCLUDED.default_sla_seconds,
    max_total_cost_cents = EXCLUDED.max_total_cost_cents, final_output_contract = EXCLUDED.final_output_contract,
    dashboard_visibility_policy = EXCLUDED.dashboard_visibility_policy, active = EXCLUDED.active, updated_at = NOW()
  RETURNING id
)
INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract, acceptance_criteria, failure_policy, drift_check)
SELECT id, step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract::jsonb, acceptance_criteria, failure_policy, drift_check::jsonb
FROM ops_template
CROSS JOIN (VALUES
  (1, 'intake', 'Intake', 'operations-coordinator', 'Capture the operational issue, impact, constraints, and owner expectations.', false, 180, 1, 50, '{"artifactKind":"ops_intake","requiredFields":["issue","impact","constraints"]}', 'Must define issue and owner-visible impact.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.35}'),
  (2, 'investigate', 'Investigate', 'intelligence-analyst', 'Find the root cause, required evidence, and recommended action.', false, 420, 1, 125, '{"artifactKind":"investigation_report","requiredFields":["rootCause","evidence","recommendation"]}', 'Must cite evidence and avoid unbounded exploration.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.35}'),
  (3, 'execute', 'Execute', 'operations-coordinator', 'Carry out the approved operational fix or coordination task.', true, 420, 1, 100, '{"artifactKind":"ops_execution","requiredFields":["action","result","verification"]}', 'Must report what changed and verification.', 'retry_then_fail', '{"mode":"source_similarity","threshold":0.3}'),
  (4, 'verify', 'Verify', 'quality-reviewer', 'Confirm the result, check for regressions, and document evidence.', true, 240, 1, 50, '{"artifactKind":"qa_verdict","requiredFields":["verdict","evidence","risks"]}', 'Must produce PASS/FAIL with evidence.', 'fail_fast', '{"mode":"source_similarity","threshold":0.3}'),
  (5, 'report', 'Report', 'hive-supervisor', 'Report outcome, residual risk, and next action to the owner.', false, 180, 0, 40, '{"artifactKind":"owner_report","requiredFields":["outcome","risk","nextAction"]}', 'Must be owner-facing and concise.', 'fail_fast', '{"mode":"source_similarity","threshold":0.3}')
) AS step_data(step_order, slug, name, role_slug, duty, qa_required, max_runtime_seconds, max_retries, max_cost_cents, output_contract, acceptance_criteria, failure_policy, drift_check)
ON CONFLICT (template_id, step_order) DO UPDATE SET
  slug = EXCLUDED.slug, name = EXCLUDED.name, role_slug = EXCLUDED.role_slug, duty = EXCLUDED.duty,
  qa_required = EXCLUDED.qa_required, max_runtime_seconds = EXCLUDED.max_runtime_seconds,
  max_retries = EXCLUDED.max_retries, max_cost_cents = EXCLUDED.max_cost_cents,
  output_contract = EXCLUDED.output_contract, acceptance_criteria = EXCLUDED.acceptance_criteria,
  failure_policy = EXCLUDED.failure_policy, drift_check = EXCLUDED.drift_check, updated_at = NOW();
