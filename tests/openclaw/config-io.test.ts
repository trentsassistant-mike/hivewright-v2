import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  configPath,
  openclawDir,
  agentDir,
  workspaceDir,
  readConfig,
  writeConfig,
} from "../../src/openclaw/config-io";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-io-"));
  process.env.OPENCLAW_CONFIG_PATH = path.join(tmp, "openclaw.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("openclaw/config-io", () => {
  it("configPath honors OPENCLAW_CONFIG_PATH", () => {
    expect(configPath()).toBe(path.join(tmp, "openclaw.json"));
  });

  it("openclawDir is the directory containing configPath", () => {
    expect(openclawDir()).toBe(tmp);
  });

  it("agentDir / workspaceDir compose under openclawDir", () => {
    expect(agentDir("hw-foo")).toBe(path.join(tmp, "agents", "hw-foo"));
    expect(workspaceDir("hw-foo")).toBe(path.join(tmp, "workspaces", "hw-foo"));
  });

  it("readConfig returns {cfg:null, error} when file missing", () => {
    const r = readConfig();
    expect(r.cfg).toBeNull();
    expect(r.error).toMatch(/ENOENT/);
  });

  it("writeConfig + readConfig round-trip", () => {
    writeConfig({ agents: { list: [{ id: "hw-x" }] } });
    const r = readConfig();
    expect(r.cfg?.agents?.list?.[0]?.id).toBe("hw-x");
  });
});
