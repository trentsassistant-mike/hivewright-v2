export function buildGoalSupervisorProcessEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  supervisorSession: string,
): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...baseEnv };

  delete env.HIVEWRIGHT_TASK_ID;
  delete env.HIVEWRIGHT_HIVE_ID;

  env.HIVEWRIGHT_SUPERVISOR_SESSION = supervisorSession;
  return env as NodeJS.ProcessEnv;
}
