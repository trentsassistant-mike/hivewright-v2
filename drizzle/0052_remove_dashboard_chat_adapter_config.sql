-- Dashboard EA chat now uses the native runEa pipeline instead of a
-- separate constrained chat-provider config.

DELETE FROM adapter_config
WHERE adapter_type = 'dashboard-chat'
  AND hive_id IS NULL;
