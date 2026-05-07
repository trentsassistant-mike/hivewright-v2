import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  pruneStaleGoalSupervisors,
  pruneGoalSupervisor,
} from "../../src/openclaw/goal-supervisor-cleanup";

let tmpDir: string;
let cfgPath: string;

function writeConfig(obj: unknown) {
  fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
}

function seedDir(rel: string) {
  const p = path.join(tmpDir, rel);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "marker"), "x");
  return p;
}

beforeEach(async () => {
  await truncateAll(sql);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cleanup-"));
  cfgPath = path.join(tmpDir, "openclaw.json");
  // Write a default config so unlinkSync works in the "missing entirely" test.
  fs.writeFileSync(cfgPath, JSON.stringify({}));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

async function insertHive(slug: string): Promise<string> {
  const [row] = await sql`INSERT INTO hives (slug, name, type) VALUES (${slug}, ${slug}, 'digital') RETURNING id`;
  return row.id as string;
}

async function insertGoal(
  hiveId: string,
  status: "active" | "paused" | "achieved" | "cancelled" = "active",
): Promise<string> {
  const [row] = await sql`
    INSERT INTO goals (hive_id, title, description, status)
    VALUES (${hiveId}, 't', 'd', ${status})
    RETURNING id
  `;
  return row.id as string;
}

function gsId(hiveSlug: string, goalId: string): string {
  return `hw-gs-${hiveSlug}-${goalId.slice(0, 8)}`;
}

describe("pruneStaleGoalSupervisors", () => {
  it("prunes an entry whose goal has no match in the DB", async () => {
    const bizId = await insertHive("acme");
    await insertGoal(bizId, "achieved"); // real goal, but terminal
    const id = gsId("acme", "deadbeef-0000-0000-0000-000000000000"); // prefix doesn't match any live goal
    writeConfig({ agents: { list: [{ id, model: { primary: "gpt-5.4" } }] } });
    seedDir(`agents/${id}`);
    seedDir(`workspaces/${id}`);

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(1);
    expect(result.kept).toBe(0);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, "agents", id))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "workspaces", id))).toBe(false);
  });

  it("keeps an entry when the matching goal is active", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "active");
    const id = gsId("acme", goalId);
    writeConfig({ agents: { list: [{ id }] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(1);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(1);
  });

  it("keeps an entry when the matching goal is paused", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "paused");
    const id = gsId("acme", goalId);
    writeConfig({ agents: { list: [{ id }] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(1);
  });

  it("prunes when matching goal is achieved", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "achieved");
    const id = gsId("acme", goalId);
    writeConfig({ agents: { list: [{ id }] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(1);
    expect(result.kept).toBe(0);
  });

  it("prunes when matching goal is cancelled", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "cancelled");
    const id = gsId("acme", goalId);
    writeConfig({ agents: { list: [{ id }] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(1);
    expect(result.kept).toBe(0);
  });

  it("leaves non-hw-gs-* entries alone", async () => {
    writeConfig({ agents: { list: [
      { id: "hw-dev-agent" },
      { id: "main" },
      { id: "hivewright" },
    ] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(0); // these aren't even counted — they're not gs entries
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(3);
  });

  it("reports counts correctly across a mixed batch", async () => {
    const bizId = await insertHive("acme");
    const liveGoal = await insertGoal(bizId, "active");
    const doneGoal = await insertGoal(bizId, "achieved");

    writeConfig({ agents: { list: [
      { id: "hw-dev-agent" },
      { id: gsId("acme", liveGoal) },
      { id: gsId("acme", doneGoal) },
      { id: gsId("acme", "ffffffff-0000-0000-0000-000000000000") }, // no matching goal
    ] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(2);
    expect(result.kept).toBe(1);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const remaining = cfg.agents.list.map((a: { id: string }) => a.id).sort();
    expect(remaining).toEqual(["hw-dev-agent", gsId("acme", liveGoal)].sort());
  });

  it("handles hive slugs containing hyphens", async () => {
    const bizId = await insertHive("acme-corp");
    const goalId = await insertGoal(bizId, "active");
    const id = gsId("acme-corp", goalId);
    writeConfig({ agents: { list: [{ id }] } });

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(1);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(1);
    expect(cfg.agents.list[0].id).toBe(id);
  });

  it("tolerates a missing agents section", async () => {
    writeConfig({});
    const result = await pruneStaleGoalSupervisors(sql);
    expect(result.pruned).toBe(0);
    expect(result.kept).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns an error entry when openclaw.json is missing entirely", async () => {
    fs.unlinkSync(cfgPath);
    const result = await pruneStaleGoalSupervisors(sql);
    expect(result.pruned).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("pruneGoalSupervisor", () => {
  it("removes the single matching entry and its directories", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "achieved");
    const id = gsId("acme", goalId);
    writeConfig({ agents: { list: [{ id, model: { primary: "gpt-5.4" } }] } });
    seedDir(`agents/${id}`);
    seedDir(`workspaces/${id}`);

    await pruneGoalSupervisor(sql, goalId);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, "agents", id))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "workspaces", id))).toBe(false);
  });

  it("leaves other entries untouched", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "achieved");
    const otherId = gsId("acme", "ffffffff-0000-0000-0000-000000000000");
    writeConfig({ agents: { list: [
      { id: gsId("acme", goalId) },
      { id: otherId },
      { id: "hw-dev-agent" },
    ] } });

    await pruneGoalSupervisor(sql, goalId);

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const ids = cfg.agents.list.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([otherId, "hw-dev-agent"].sort());
  });

  it("is a no-op when the entry doesn't exist", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "achieved");
    writeConfig({ agents: { list: [{ id: "hw-dev-agent" }] } });

    await expect(pruneGoalSupervisor(sql, goalId)).resolves.toBeUndefined();
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(1);
  });

  it("is a no-op when the goal doesn't exist", async () => {
    writeConfig({ agents: { list: [{ id: "hw-gs-acme-deadbeef" }] } });

    await expect(
      pruneGoalSupervisor(sql, "00000000-0000-0000-0000-000000000000"),
    ).resolves.toBeUndefined();
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(1); // unchanged — we couldn't derive the id
  });

  it("rejects a goal whose derived agentId has invalid characters", async () => {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type) VALUES ('../evil', 'evil', 'digital') RETURNING id
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${biz.id}, 't', 'd', 'achieved')
      RETURNING id
    `;
    const crafted = `hw-gs-../evil-${(goal.id as string).slice(0, 8)}`;
    writeConfig({ agents: { list: [{ id: crafted }] } });
    seedDir(`agents/${crafted}`);

    await pruneGoalSupervisor(sql, goal.id as string);

    // Entry untouched in config; dir untouched on disk — regex rejected it.
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "agents", crafted))).toBe(true);
  });
});

describe("pruneStaleGoalSupervisors orphan-dir cleanup", () => {
  it("removes hw-gs-* agents/ directories that have no corresponding JSON entry", async () => {
    writeConfig({ agents: { list: [] } });
    const orphan = "hw-gs-acme-deadbeef";
    seedDir(`agents/${orphan}`);

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.orphansRemoved).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "agents", orphan))).toBe(false);
  });

  it("removes hw-gs-* workspaces/ directories that have no JSON entry", async () => {
    writeConfig({ agents: { list: [] } });
    const orphan = "hw-gs-acme-c0ffee00";
    seedDir(`workspaces/${orphan}`);

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.orphansRemoved).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "workspaces", orphan))).toBe(false);
  });

  it("keeps directories whose id IS in the (kept) JSON list", async () => {
    const bizId = await insertHive("acme");
    const goalId = await insertGoal(bizId, "active");
    const id = gsId("acme", goalId);
    writeConfig({ agents: { list: [{ id }] } });
    seedDir(`agents/${id}`);

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.orphansRemoved).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "agents", id))).toBe(true);
  });

  it("leaves non-hw-gs-* directories alone", async () => {
    writeConfig({ agents: { list: [] } });
    seedDir("agents/hw-dev-agent");
    seedDir("agents/some-other-stuff");
    seedDir("workspaces/main");

    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.orphansRemoved).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "agents", "hw-dev-agent"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "agents", "some-other-stuff"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "workspaces", "main"))).toBe(true);
  });

  it("tolerates missing agents/ or workspaces/ directories", async () => {
    writeConfig({ agents: { list: [] } });
    // Neither agents/ nor workspaces/ exists under tmpDir — test that readdir
    // failures don't abort the sweep.
    const result = await pruneStaleGoalSupervisors(sql);

    expect(result.orphansRemoved).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
