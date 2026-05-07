import type { Sql } from "postgres";
import { canAccessHive } from "@/auth/users";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_HOURS,
  MAX_LIMIT,
  MAX_WINDOW_HOURS,
  appSql,
  fetchInitiativeRuns,
  fetchInitiativeRunSummary,
  summarizeInitiativeRun,
} from "./queries";

const HIVE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getInitiativeRuns(request: Request, db: Sql) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const url = new URL(request.url);
    const hiveId = url.searchParams.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!HIVE_ID_RE.test(hiveId)) {
      return jsonError("hiveId must be a valid UUID", 400);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(db, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam !== null ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const windowParam = url.searchParams.get("windowHours");
    const parsedWindow =
      windowParam !== null ? parseInt(windowParam, 10) : DEFAULT_WINDOW_HOURS;
    const windowHours =
      Number.isFinite(parsedWindow) && parsedWindow > 0
        ? Math.min(parsedWindow, MAX_WINDOW_HOURS)
        : DEFAULT_WINDOW_HOURS;

    const [summary, runs] = await Promise.all([
      fetchInitiativeRunSummary(db, hiveId, windowHours),
      fetchInitiativeRuns(db, hiveId, limit),
    ]);

    return jsonOk({
      summary,
      runs: runs
        .map((run) => summarizeInitiativeRun(run))
        .filter((run): run is NonNullable<typeof run> => run !== null),
    });
  } catch (error) {
    console.error("[api/initiative-runs] failed:", error);
    return jsonError("Failed to fetch initiative runs", 500);
  }
}

export function createGetInitiativeRunsHandler(db: Sql = appSql) {
  return async function GET(request: Request) {
    return getInitiativeRuns(request, db);
  };
}

export const GET = createGetInitiativeRunsHandler();
