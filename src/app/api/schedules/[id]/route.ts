import { canAccessHive } from "@/auth/users";
import { loadScheduleDetail } from "@/schedules/detail";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!id) return jsonError("id is required", 400);

  try {
    const detail = await loadScheduleDetail(sql, id);
    if (!detail) return jsonError("schedule not found", 404);

    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, detail.schedule.hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    return jsonOk(detail);
  } catch {
    return jsonError("Failed to fetch schedule", 500);
  }
}
