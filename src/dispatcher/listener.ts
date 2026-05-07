import type { Sql } from "postgres";

export interface TaskListener {
  unlisten: () => Promise<void>;
}

export async function createTaskListener(
  sql: Sql,
  onNewTask: (taskId: string) => void,
): Promise<TaskListener> {
  const subscription = await sql.listen("new_task", (payload) => {
    onNewTask(payload);
  });

  return {
    unlisten: async () => {
      await subscription.unlisten();
    },
  };
}
