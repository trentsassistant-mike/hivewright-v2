import { NextResponse } from "next/server";
import { sql } from "@/app/api/_lib/db";
import { requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive } from "@/auth/users";
import { listGoalDocuments } from "@/goals/goal-documents";

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

  const docs = await listGoalDocuments(sql, id);
  return NextResponse.json({ documents: docs });
}
