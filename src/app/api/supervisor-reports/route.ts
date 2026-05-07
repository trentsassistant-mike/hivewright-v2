import { canAccessHive } from "@/auth/users";
import { runSupervisorDigest } from "@/supervisor";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  appSql,
  fetchSupervisorReports,
} from "./queries";

/**
 * GET /api/supervisor-reports?hiveId=<uuid>&limit=<n>
 *
 * Returns the most recent supervisor heartbeat audit rows for the given
 * hive, ordered by ran_at DESC. Intended for the dashboard's "Supervisor
 * findings" panel — read-only observability, no write paths here.
 *
 * Each row carries the full HiveHealthReport (for the findings list +
 * metrics), the SupervisorActions JSON the agent emitted (or null when
 * the apply flow hasn't run yet or the output was malformed), and the
 * per-action AppliedOutcome results. The row-shape and snake_case ->
 * camelCase mapping live in ./queries so `/api/brief` can reuse the same
 * plumbing for its supervisor summary.
 */

const HIVE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authorizeHiveRequest(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) {
    return jsonError("hiveId is required", 400);
  }
  if (!HIVE_ID_RE.test(hiveId)) {
    return jsonError("hiveId must be a valid UUID", 400);
  }
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(appSql, user.id, hiveId);
    if (!hasAccess) {
      return jsonError("Forbidden: caller cannot access this hive", 403);
    }
  }
  return { hiveId, url };
}

export async function GET(request: Request) {
  try {
    const authorized = await authorizeHiveRequest(request);
    if (authorized instanceof Response) return authorized;
    const { hiveId, url } = authorized;
    const limitParam = url.searchParams.get("limit");
    const parsed = limitParam !== null ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const data = await fetchSupervisorReports(appSql, hiveId, limit);
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch supervisor reports", 500);
  }
}

export async function POST(request: Request) {
  try {
    const authorized = await authorizeHiveRequest(request);
    if (authorized instanceof Response) return authorized;
    const result = await runSupervisorDigest(appSql, authorized.hiveId);
    return jsonOk(result);
  } catch {
    return jsonError("Failed to run supervisor digest", 500);
  }
}
