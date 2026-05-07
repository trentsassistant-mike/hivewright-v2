ALTER TABLE credentials
  ADD COLUMN IF NOT EXISTS fingerprint varchar(64);

-- Existing credential values are encrypted with the application ENCRYPTION_KEY,
-- so this migration cannot safely compute or enforce NOT NULL inside SQL for
-- already-deployed databases. Backfill with backfillCredentialFingerprints()
-- from src/credentials/manager.ts; it decrypts in application code, updates
-- only NULL fingerprints, and does not log plaintext secret material.
