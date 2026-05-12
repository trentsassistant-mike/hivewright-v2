import { requireApiUser } from "@/app/api/_lib/auth";
import { sql } from "@/app/api/_lib/db";
import { canAccessHive } from "@/auth/users";
import { loadScheduleDetail, type ScheduleDetail } from "@/schedules/detail";

export async function loadScheduleDetailForPage(id: string): Promise<ScheduleDetail | null> {
  const authz = await requireApiUser();
  if ("response" in authz) return null;

  const detail = await loadScheduleDetail(sql, id);
  if (!detail) return null;

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, detail.schedule.hiveId);
    if (!hasAccess) return null;
  }

  return detail;
}
