import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { completeGoal } from "../../src/goals/completion";

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  await truncateAll(sql);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-compprune-"));
  cfgPath = path.join(tmpDir, "openclaw.json");
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("completeGoal triggers goal-supervisor prune", () => {
  it("removes the hw-gs-* entry for the completed goal", async () => {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type) VALUES ('acme', 'Acme', 'digital') RETURNING id
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${biz.id}, 'ship thing', 'd', 'active')
      RETURNING id
    `;
    const agentId = `hw-gs-acme-${(goal.id as string).slice(0, 8)}`;
    fs.writeFileSync(cfgPath, JSON.stringify({
      agents: { list: [{ id: agentId, model: { primary: "gpt-5.4" } }] }
    }));

    await completeGoal(sql, goal.id as string, "did it");

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(0);
  });
});
