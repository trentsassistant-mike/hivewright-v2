import fs from "fs";
import path from "path";
import type { Sql } from "postgres";
import { agentDir, openclawDir, readConfig, workspaceDir, writeConfig } from "./config-io";

const GS_ID_PATTERN = /^hw-gs-([a-z0-9-]+)-([0-9a-f]{8})$/;

interface SweepResult {
  pruned: number;
  kept: number;
  /** Orphan hw-gs-* directories under agents/ or workspaces/ whose id has no
   *  corresponding entry in agents.list (pre-existing cruft from earlier runs
   *  that the original sweep loop couldn't see). Cleaned in a second pass. */
  orphansRemoved: number;
  errors: string[];
}

export async function pruneStaleGoalSupervisors(sql: Sql): Promise<SweepResult> {
  const errors: string[] = [];
  const { cfg, error } = readConfig();
  if (!cfg) {
    if (error) errors.push(`read openclaw.json: ${error}`);
    return { pruned: 0, kept: 0, orphansRemoved: 0, errors };
  }

  const list = cfg.agents?.list ?? [];
  const gsEntries = list
    .map((entry) => ({ entry, match: GS_ID_PATTERN.exec(entry.id) }))
    .filter((x): x is { entry: { id: string }; match: RegExpExecArray } => x.match !== null);

  const nonGsEntries = list.filter((entry) => !GS_ID_PATTERN.test(entry.id));

  let pruned = 0;
  let kept = 0;
  const keptGsEntries: typeof list = [];

  for (const { entry, match } of gsEntries) {
    const hiveSlug = match[1];
    const goalIdPrefix = match[2];

    const [alive] = await sql`
      SELECT 1 FROM goals g
      JOIN hives b ON b.id = g.hive_id
      WHERE b.slug = ${hiveSlug}
        AND g.id::text LIKE ${goalIdPrefix + "%"}
        AND g.status IN ('active', 'paused')
      LIMIT 1
    `;

    if (alive) {
      kept++;
      keptGsEntries.push(entry);
    } else {
      pruned++;
      try { fs.rmSync(agentDir(entry.id), { recursive: true, force: true }); }
      catch (e) { errors.push(`rm agents/${entry.id}: ${(e as Error).message}`); }
      try { fs.rmSync(workspaceDir(entry.id), { recursive: true, force: true }); }
      catch (e) { errors.push(`rm workspaces/${entry.id}: ${(e as Error).message}`); }
    }
  }

  cfg.agents = cfg.agents ?? {};
  cfg.agents.list = [...nonGsEntries, ...keptGsEntries];
  try {
    writeConfig(cfg);
  } catch (e) {
    errors.push(`write openclaw.json: ${(e as Error).message}`);
  }

  // Pass 2: orphan-dir cleanup. After the JSON is authoritative, scan the two
  // on-disk directories for any hw-gs-* subdir whose id isn't in agents.list
  // and remove it. Catches cruft from pre-Plan-6.1 runs and any future drift
  // where the JSON was hand-edited without touching the filesystem.
  const keepIds = new Set<string>(cfg.agents.list.map((e) => e.id));
  let orphansRemoved = 0;

  for (const subdir of ["agents", "workspaces"] as const) {
    const dir = path.join(openclawDir(), subdir);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // directory doesn't exist — nothing to scan
    }

    for (const name of entries) {
      if (!GS_ID_PATTERN.test(name)) continue;
      if (keepIds.has(name)) continue;
      orphansRemoved++;
      try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); }
      catch (e) { errors.push(`rm ${subdir}/${name}: ${(e as Error).message}`); }
    }
  }

  return { pruned, kept, orphansRemoved, errors };
}

export async function pruneGoalSupervisor(sql: Sql, goalId: string): Promise<void> {
  const [row] = await sql`
    SELECT g.id, b.slug AS hive_slug
    FROM goals g
    JOIN hives b ON b.id = g.hive_id
    WHERE g.id = ${goalId}
  `;
  if (!row) return;

  const agentId = `hw-gs-${row.hive_slug}-${(row.id as string).slice(0, 8)}`;
  if (!GS_ID_PATTERN.test(agentId)) return;

  const { cfg } = readConfig();
  if (!cfg) return;

  const list = cfg.agents?.list ?? [];
  const idx = list.findIndex((entry) => entry.id === agentId);
  if (idx === -1) return;

  list.splice(idx, 1);
  cfg.agents = cfg.agents ?? {};
  cfg.agents.list = list;
  try {
    writeConfig(cfg);
  } catch { /* ignore */ }

  try { fs.rmSync(agentDir(agentId), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(workspaceDir(agentId), { recursive: true, force: true }); } catch { /* ignore */ }
}
