import fs from "fs";
import os from "os";
import path from "path";
import { sql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";

/**
 * GET /api/active-supervisors?hiveId=...
 *
 * Returns goals that have a live supervisor session attached so the
 * dashboard can show "what supervisors are alive right now". A supervisor
 * is considered alive if its goal is `active` and `session_id` (the codex
 * workspace path) exists on disk.
 *
 * `state` derives from the rollout file mtime:
 *   - "running"  — codex process probably writing right now (mtime < 30 s)
 *   - "waking"   — recent activity (< 5 min) but no longer writing
 *   - "idle"     — last write > 5 min ago; supervisor is parked between sprints
 */

type GoalRow = {
  id: string;
  title: string;
  status: string;
  session_id: string | null;
  created_at: Date;
};

const SESSIONS_DIR = path.join(process.env.HOME ?? os.homedir(), ".codex", "sessions");

function readThreadId(workspacePath: string): string | null {
  try {
    return fs
      .readFileSync(path.join(workspacePath, ".codex-thread-id"), "utf-8")
      .trim() || null;
  } catch {
    return null;
  }
}

function findRolloutMtime(threadId: string): number | null {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  let bestMtime = 0;

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(`-${threadId}.jsonl`)) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > bestMtime) bestMtime = st.mtimeMs;
        } catch { /* skip */ }
      }
    }
  }

  walk(SESSIONS_DIR, 0);
  return bestMtime > 0 ? bestMtime : null;
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hiveId)) {
    return jsonError("hiveId must be a valid UUID", 400);
  }
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, hiveId);
    if (!hasAccess) {
      return jsonError("Forbidden: caller cannot access this hive", 403);
    }
  }

  const rows = await sql<GoalRow[]>`
    SELECT id, title, status, session_id, created_at
    FROM goals
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'active'
      AND session_id IS NOT NULL
    ORDER BY created_at DESC
  `;

  const supervisors = rows.map((r) => {
    const threadId = r.session_id ? readThreadId(r.session_id) : null;
    const mtimeMs = threadId ? findRolloutMtime(threadId) : null;
    const ageMs = mtimeMs ? Date.now() - mtimeMs : null;

    let state: "running" | "waking" | "idle" | "unknown";
    if (ageMs === null) state = "unknown";
    else if (ageMs < 30_000) state = "running";
    else if (ageMs < 5 * 60_000) state = "waking";
    else state = "idle";

    return {
      goalId: r.id,
      goalShortId: r.id.slice(0, 8),
      title: r.title,
      threadId: threadId ? threadId.slice(0, 13) : null,
      lastActivityAt: mtimeMs ? new Date(mtimeMs).toISOString() : null,
      state,
    };
  });

  return jsonOk(supervisors);
}
