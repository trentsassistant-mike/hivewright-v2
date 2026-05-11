import { canAccessHive } from "@/auth/users";
import { loadAgentObservability } from "@/agents/observability";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";

function observabilityDisabled() {
  return process.env.AGENT_OBSERVABILITY_PANEL === "false";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  if (observabilityDisabled()) {
    return jsonError("Agent observability is disabled", 404);
  }

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { slug } = await params;
  if (!slug) return jsonError("slug is required", 400);

  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");

  if (!hiveId && !authz.user.isSystemOwner) {
    return jsonError("hiveId is required for non-owner observability requests", 400);
  }

  if (hiveId && !authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) {
      return jsonError("Forbidden: caller cannot access this hive", 403);
    }
  }

  try {
    const data = await loadAgentObservability(sql, slug, { hiveId });
    if (!data) return jsonError("role not found", 404);
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch agent observability", 500);
  }
}
