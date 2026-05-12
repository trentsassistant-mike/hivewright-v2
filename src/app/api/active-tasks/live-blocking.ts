// A failed/unresolvable/blocked task only blocks live work when the goal it
// belongs to is still active (or it is a direct task with no goal). Failures
// under achieved/cancelled/abandoned/completed goals are kept as historical
// audit context and excluded from the live-critical state.
export function isTaskLiveBlocking(taskStatus: string, goalStatus: string | null): boolean {
  if (!["blocked", "failed", "unresolvable"].includes(taskStatus)) return false;
  if (goalStatus === null) return true;
  return goalStatus === "active";
}

export function isDecisionLiveBlocking(goalStatus: string | null): boolean {
  if (goalStatus === null) return true;
  return goalStatus === "active";
}
