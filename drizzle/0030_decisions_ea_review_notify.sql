-- Fire NOTIFY new_ea_review_decision whenever a decision is inserted with
-- status='ea_review' so the dispatcher's EA-resolver loop picks it up
-- without waiting for the 60s polling fallback.

CREATE OR REPLACE FUNCTION notify_new_ea_review_decision() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'ea_review' THEN
    PERFORM pg_notify('new_ea_review_decision', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_ea_review_notify ON decisions;
CREATE TRIGGER decision_ea_review_notify
AFTER INSERT ON decisions
FOR EACH ROW
EXECUTE FUNCTION notify_new_ea_review_decision();
