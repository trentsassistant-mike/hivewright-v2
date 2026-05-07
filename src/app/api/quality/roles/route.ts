import { canAccessHive } from "@/auth/users";
import { sql } from "../../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { applicableQualityFloor, loadQualityControlsConfig } from "@/quality/quality-config";
import { listRoleQualityScores } from "@/quality/score";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const [config, scores] = await Promise.all([
      loadQualityControlsConfig(sql, hiveId),
      listRoleQualityScores(sql, hiveId),
    ]);
    const roles = await sql<{
      slug: string;
      owner_pinned: boolean;
    }[]>`
      SELECT slug, COALESCE(owner_pinned, false) AS owner_pinned
      FROM role_templates
      WHERE active = true
    `;
    const pinnedByRole = new Map(roles.map((role) => [role.slug, role.owner_pinned]));

    return jsonOk({
      defaultQualityFloor: config.defaultQualityFloor,
      roleQualityFloors: config.roleQualityFloors,
      roles: scores.map((score) => ({
        ...score,
        qualityFloor: applicableQualityFloor(config, score.roleSlug),
        ownerPinned: pinnedByRole.get(score.roleSlug) ?? false,
      })),
    });
  } catch (err) {
    console.error("[quality roles GET] failed:", err);
    return jsonError("Failed to fetch role quality scores", 500);
  }
}
