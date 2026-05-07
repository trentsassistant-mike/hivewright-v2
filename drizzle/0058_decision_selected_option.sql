-- Persist the named decision option selected by the owner, when a decision
-- presents first-class options instead of a generic approve/reject choice.
-- Nullable columns keep legacy yes/no decisions and existing rows compatible.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS selected_option_key text,
  ADD COLUMN IF NOT EXISTS selected_option_label text;
