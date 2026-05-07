ALTER TABLE voice_sessions
  ADD COLUMN IF NOT EXISTS post_call_summary_posted_at TIMESTAMPTZ;
