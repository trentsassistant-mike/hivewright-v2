ALTER TABLE task_quality_signals
DROP CONSTRAINT IF EXISTS task_quality_signals_source_chk;

ALTER TABLE task_quality_signals
ADD CONSTRAINT task_quality_signals_source_chk
CHECK (source IN ('implicit_ea', 'explicit_owner_feedback', 'explicit_ai_peer_feedback'));
