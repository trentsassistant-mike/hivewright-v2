import { NextResponse } from "next/server";
import { sql } from "@/app/api/_lib/db";
import { requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive } from "@/auth/users";
import { getGoalPlan, upsertGoalPlan } from "@/goals/goal-documents";

// Sanity cap on plan body size. The `body` column is text (unbounded), but
// supervisors shouldn't be PUTing megabyte-scale plans — if they need more,
// it's a sign the plan should be split into sub-documents. 1 MiB is 10x
// bigger than any reasonable plan.
const MAX_PLAN_BODY_BYTES = 1 * 1024 * 1024;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const { id } = await params;
  const [goal] = await sql<{ id: string; hive_id: string }[]>`
    SELECT id, hive_id FROM goals WHERE id = ${id}
  `;
  if (!goal) {
    return NextResponse.json({ error: "goal not found" }, { status: 404 });
  }
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, goal.hive_id);
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Forbidden: caller cannot access this goal" },
        { status: 403 },
      );
    }
  }

  const plan = await getGoalPlan(sql, id);
  if (!plan) {
    return NextResponse.json({ error: "no plan yet" }, { status: 404 });
  }
  return NextResponse.json(plan);
}

// Per-handler authorization (audit 2026-04-22 goal-adjacent pass).
// Plan upserts are the supervisor's durable planning surface for a goal. The
// previous handler only enforced session presence, letting any authenticated
// caller overwrite the plan of any goal and spoof `createdBy`. This mirrors
// the already-proven seam in `POST /api/goals/[id]/complete`:
//   1. `requireApiUser()` resolves the caller identity.
//   2. System owners pass directly (manual plan edits via the dashboard).
//   3. Non-owners must send `X-Supervisor-Session` equal to `goals.session_id`
//      — the dispatcher-assigned workspace path for this goal. A missing or
//      mismatched header is 403.
// Role-slug attribution for `createdBy` is honored when the supervisor-session
// matches; non-matching non-owners never reach the upsert.
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const { id } = await params;
  const body = (await request.json()) as {
    title?: string;
    body?: string;
    createdBy?: string;
  };
  if (!body.title || !body.body) {
    return NextResponse.json(
      { error: "title and body required" },
      { status: 400 },
    );
  }
  if (Buffer.byteLength(body.body, "utf8") > MAX_PLAN_BODY_BYTES) {
    return NextResponse.json(
      { error: `plan body exceeds ${MAX_PLAN_BODY_BYTES} bytes; split into sub-documents` },
      { status: 413 },
    );
  }

  // Verify the goal exists before attempting to upsert — otherwise the FK
  // constraint on goal_documents.goal_id surfaces as a 500 from Postgres.
  const [goal] = await sql<{ session_id: string | null }[]>`
    SELECT session_id FROM goals WHERE id = ${id} LIMIT 1
  `;
  if (!goal) {
    return NextResponse.json({ error: "goal not found" }, { status: 404 });
  }

  if (!user.isSystemOwner) {
    const callerSession = request.headers.get("x-supervisor-session")?.trim() ?? "";
    if (!callerSession || callerSession !== goal.session_id) {
      return NextResponse.json(
        { error: "Forbidden: caller is not the supervisor session for this goal" },
        { status: 403 },
      );
    }
  }

  const defaultCreatedBy = user.isSystemOwner ? "owner" : "goal-supervisor";
  const plan = await upsertGoalPlan(sql, id, {
    title: body.title,
    body: body.body,
    createdBy: body.createdBy ?? defaultCreatedBy,
  });
  return NextResponse.json(plan);
}
