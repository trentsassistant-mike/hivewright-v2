export interface SupervisorSession {
  goalId: string;
  hiveId: string;
  sessionId: string;
  model: string;
  status: "active" | "compacting" | "terminated";
  createdAt: Date;
}

export interface SprintSummary {
  goalId: string;
  sprintNumber: number;
  tasksCompleted: { id: string; title: string; resultSummary: string | null; assignedTo: string }[];
  tasksFailed: { id: string; title: string; failureReason: string | null; assignedTo: string }[];
  tasksCancelled: { id: string; title: string; assignedTo: string }[];
}

export interface GoalStatus {
  goalId: string;
  title: string;
  description: string | null;
  status: string;
  budgetCents: number | null;
  spentCents: number;
  currentSprint: number;
  totalSprints: number;
  subGoals: { id: string; title: string; status: string }[];
}

export interface SupervisorTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}
