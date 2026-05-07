-- Voice EA Phase A follow-up (2026-05-07): rename the existing
-- `twilio-voice` connector install slug to `voice-ea` (the new clean slug
-- that ships with no Twilio cruft) and strip the orphaned Twilio-specific
-- config fields. The `voiceServicesUrl` and `maxMonthlyLlmCents` values
-- are preserved verbatim — they're the only fields the new connector
-- definition reads.
--
-- Encrypted Twilio secrets in the `credentials` table are NOT touched
-- here; they're still referenced by `connector_installs.credential_id`
-- but the new connector definition declares no `secretFields`, so the
-- decrypt code path never runs against them. The owner can purge them
-- via the dashboard if they want a clean slate.
UPDATE connector_installs
SET
  connector_slug = 'voice-ea',
  config = jsonb_strip_nulls(jsonb_build_object(
    'voiceServicesUrl', config -> 'voiceServicesUrl',
    'maxMonthlyLlmCents', config -> 'maxMonthlyLlmCents'
  )),
  updated_at = NOW()
WHERE connector_slug = 'twilio-voice';
