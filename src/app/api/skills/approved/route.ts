import { canAccessHive } from "@/auth/users";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { loadApprovedSkillCandidates } from "@/skills/self-creation";

/**
 * GET /api/skills/approved?hiveId=...&roleSlug=...
 *
 * Internal discovery endpoint for reviewed skill candidates. It returns only
 * approved or published candidates and never installs or executes remote code.
 */
export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const roleSlug = params.get("roleSlug");

    if (!hiveId || !roleSlug) {
      return jsonError("hiveId and roleSlug are required", 400);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const candidates = await loadApprovedSkillCandidates(sql, hiveId, roleSlug);
    return jsonOk(candidates);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load approved skills";
    return jsonError(message, 500);
  }
}
