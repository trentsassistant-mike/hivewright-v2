-- Cleanup existing contradictory task rows before enforcing the completion
-- semantics in code. Audited stale rows:
--   48a73a4a-c090-4a31-b5b3-009d68bbe7ca
--   32a6a131-5e39-450f-88e6-b198937a34a9
--   7e0a6c6a-2a0e-49ab-924d-fb1aa67f8de2
--   194aa681-cf92-41de-9970-ee98aa251237
--   6de38eb2-689f-4e3b-b16c-dc5ff6005d44
-- The predicate stays generic so any other stale completed rows are repaired
-- too before the follow-up CHECK constraint is added.
UPDATE tasks
SET failure_reason = NULL,
    updated_at = NOW()
WHERE status = 'completed'
  AND failure_reason IS NOT NULL;
