ALTER TABLE decision_messages
  ADD COLUMN IF NOT EXISTS supervisor_woken_at timestamp;

CREATE INDEX IF NOT EXISTS decision_messages_owner_wake_idx
  ON decision_messages (created_at)
  WHERE sender = 'owner' AND supervisor_woken_at IS NULL;

CREATE OR REPLACE FUNCTION notify_new_decision_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('new_decision_message', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_message_insert_notify ON decision_messages;
CREATE TRIGGER decision_message_insert_notify
AFTER INSERT ON decision_messages
FOR EACH ROW
EXECUTE FUNCTION notify_new_decision_message();
