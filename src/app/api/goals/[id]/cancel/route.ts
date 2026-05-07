import { changeGoalLifecycleStatus } from "../_lifecycle";

// Auth invariant: changeGoalLifecycleStatus calls requireApiUser and enforces
// goal hive mutation access before changing state.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return changeGoalLifecycleStatus(request, ctx, "cancelled");
}
