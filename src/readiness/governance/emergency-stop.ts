export const EMERGENCY_STOP_STEPS = [
  "Pause the hive so no new goals/tasks/decisions can be created.",
  "Disable schedules for the hive.",
  "Stop or restart the dispatcher only after confirming no approved action is mid-flight.",
  "Inspect pending external action requests before approving anything else.",
  "Disable risky connector installs or revoke connector tokens if compromise is suspected.",
  "Set AI budget cap to zero or keep the hive paused until repaired.",
  "Capture a short incident note with trigger, affected systems, and recovery task.",
] as const;

export const EMERGENCY_STOP_MARKDOWN = `# HiveWright Emergency Stop

## Target execution time
Under 2 minutes.

## Steps
${EMERGENCY_STOP_STEPS.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## Verification
- Hive pause state is active.
- Enabled schedules for the hive are zero or intentionally disabled.
- Pending external action requests are reviewed.
- Risky connectors are disabled/revoked when relevant.
- Owner sees the pause reason in the status brief.
`;

export function renderEmergencyStop(): string {
  return EMERGENCY_STOP_MARKDOWN;
}
