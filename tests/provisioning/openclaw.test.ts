import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OpenClawProvisioner } from "../../src/provisioning/openclaw";

let tmpDir: string;
let cfgPath: string;

function writeConfig(obj: unknown) {
  fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-test-"));
  cfgPath = path.join(tmpDir, "openclaw.json");
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
  // Write a default empty config so tests that call unlinkSync have something to remove
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }, null, 2));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("OpenClawProvisioner.check", () => {
  it("returns satisfied when agents.list has hw-<slug> entry", async () => {
    writeConfig({ agents: { list: [{ id: "hw-dev-agent", model: { primary: "gpt-5.4" } }] } });
    const p = new OpenClawProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "gpt-5.4" });
    expect(status.satisfied).toBe(true);
  });

  it("returns fixable=true unsatisfied when entry missing but config exists", async () => {
    writeConfig({ agents: { list: [] } });
    const p = new OpenClawProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "gpt-5.4" });
    expect(status.satisfied).toBe(false);
    expect(status.fixable).toBe(true);
    expect(status.reason).toMatch(/not registered/i);
  });

  it("returns fixable=false when openclaw.json missing entirely", async () => {
    fs.unlinkSync(cfgPath);
    const p = new OpenClawProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "gpt-5.4" });
    expect(status.satisfied).toBe(false);
    expect(status.fixable).toBe(false);
    expect(status.reason).toMatch(/not installed/i);
  });
});

describe("OpenClawProvisioner.provision", () => {
  it("adds a new agents.list entry and agentDir on disk", async () => {
    writeConfig({ agents: { list: [] } });
    const p = new OpenClawProvisioner();

    const events = [];
    for await (const ev of p.provision({ slug: "dev-agent", recommendedModel: "gpt-5.4" })) {
      events.push(ev);
    }

    expect(events.at(-1)).toMatchObject({ phase: "done", status: { satisfied: true } });

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    const entry = cfg.agents.list.find((a: { id: string }) => a.id === "hw-dev-agent");
    expect(entry).toBeDefined();
    expect(entry.model.primary).toBe("gpt-5.4");
    expect(entry.workspace).toMatch(/hw-dev-agent$/);
    expect(fs.existsSync(entry.agentDir)).toBe(true);
    // Regression: never write `tools` as a flat array. OpenClaw expects
    // { allow?: string[], deny?: string[] } and rejects the entire config
    // if it sees an array. Omitting the field is fine — agents inherit
    // defaults. (See ~Apr 2026 incident where 5 agents written by this
    // path took the EA offline because openclaw refused to load the file.)
    if (entry.tools !== undefined) {
      expect(Array.isArray(entry.tools)).toBe(false);
      expect(entry.tools).toMatchObject(expect.any(Object));
    }
  });

  it("is a no-op when entry already exists", async () => {
    writeConfig({ agents: { list: [{ id: "hw-dev-agent", model: { primary: "old-model" } }] } });
    const p = new OpenClawProvisioner();

    for await (const event of p.provision({ slug: "dev-agent", recommendedModel: "gpt-5.4" })) {
      void event;
    }

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(1);
    expect(cfg.agents.list[0].model.primary).toBe("old-model");
  });

  it("yields fixable=false status when config missing", async () => {
    fs.unlinkSync(cfgPath);
    const p = new OpenClawProvisioner();

    const events = [];
    for await (const ev of p.provision({ slug: "dev-agent", recommendedModel: "gpt-5.4" })) {
      events.push(ev);
    }
    expect(events.at(-1)).toMatchObject({ phase: "done", status: { satisfied: false, fixable: false } });
  });
});

describe("OpenClawProvisioner goal-supervisor special case", () => {
  it("check() reports satisfied without reading the config", async () => {
    fs.unlinkSync(cfgPath);
    const p = new OpenClawProvisioner();
    const status = await p.check({ slug: "goal-supervisor", recommendedModel: "gpt-5.4" });
    expect(status.satisfied).toBe(true);
  });

  it("provision() yields a single done event and never writes the config", async () => {
    writeConfig({ agents: { list: [] } });
    const p = new OpenClawProvisioner();
    const events = [];
    for await (const ev of p.provision({ slug: "goal-supervisor", recommendedModel: "gpt-5.4" })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ phase: "done", status: { satisfied: true } });

    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    expect(cfg.agents.list).toHaveLength(0);
  });
});
