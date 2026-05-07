import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MCP_CATALOG,
  lookupMcp,
  resolveMcps,
  buildClaudeMcpConfig,
  buildCodexMcpArgs,
} from "@/tools/mcp-catalog";

describe("mcp-catalog lookup + resolve", () => {
  it("ships the four core MCPs", () => {
    const slugs = MCP_CATALOG.map((e) => e.slug).sort();
    expect(slugs).toEqual(["context7", "github", "playwright", "sequential-thinking"]);
  });

  it("lookupMcp returns the entry by slug", () => {
    expect(lookupMcp("github")?.label).toContain("GitHub");
    expect(lookupMcp("nonexistent")).toBeUndefined();
  });

  it("resolveMcps drops unknown slugs silently", () => {
    const out = resolveMcps(["github", "nope", "playwright"]);
    expect(out.map((e) => e.slug)).toEqual(["github", "playwright"]);
  });

  it("resolveMcps returns [] for null/undefined/empty input", () => {
    expect(resolveMcps(null)).toEqual([]);
    expect(resolveMcps(undefined)).toEqual([]);
    expect(resolveMcps([])).toEqual([]);
  });
});

describe("buildClaudeMcpConfig", () => {
  it("produces the {mcpServers: {name: {command, args}}} shape claude expects", () => {
    const out = buildClaudeMcpConfig(resolveMcps(["context7"]));
    expect(out.mcpServers.context7).toBeDefined();
    expect(out.mcpServers.context7.command).toBe("npx");
    expect(out.mcpServers.context7.args).toEqual(["-y", "@upstash/context7-mcp"]);
  });

  describe("env propagation", () => {
    let savedToken: string | undefined;
    beforeEach(() => { savedToken = process.env.GITHUB_TOKEN; });
    afterEach(() => {
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
    });

    it("forwards required env vars from the parent process to the MCP entry", () => {
      process.env.GITHUB_TOKEN = "ghp_test_token";
      const out = buildClaudeMcpConfig(resolveMcps(["github"]));
      expect(out.mcpServers.github.env?.GITHUB_TOKEN).toBe("ghp_test_token");
    });

    it("omits required env vars that aren't present in process.env", () => {
      delete process.env.GITHUB_TOKEN;
      const out = buildClaudeMcpConfig(resolveMcps(["github"]));
      expect(out.mcpServers.github.env?.GITHUB_TOKEN).toBeUndefined();
    });
  });
});

describe("buildCodexMcpArgs", () => {
  it("emits one -c per field per MCP", () => {
    const args = buildCodexMcpArgs(resolveMcps(["context7"]));
    // command + args = 2 -c pairs (4 string args total)
    expect(args.filter((a) => a === "-c")).toHaveLength(2);
    expect(args).toContain('mcp_servers.context7.command="npx"');
    expect(args.some((a) => a.startsWith("mcp_servers.context7.args="))).toBe(true);
  });

  it("emits one -c per env key using dotted-path TOML syntax (not JSON)", () => {
    const saved = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = "ghp_codex_test";
      const args = buildCodexMcpArgs(resolveMcps(["github"]));
      // Regression: earlier shape was `env={"GITHUB_TOKEN":"..."}` (JSON object)
      // which codex rejected as an invalid TOML inline table and echoed the raw
      // secret back in the parse error. The correct shape is a dotted-path key
      // with a quoted TOML basic string.
      expect(args).toContain('mcp_servers.github.env.GITHUB_TOKEN="ghp_codex_test"');
      expect(args.every((a) => !a.startsWith('mcp_servers.github.env={'))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });

  it("escapes backslashes and double-quotes in env values", () => {
    const saved = process.env.GITHUB_TOKEN;
    try {
      process.env.GITHUB_TOKEN = 'weird\\"value';
      const args = buildCodexMcpArgs(resolveMcps(["github"]));
      expect(args).toContain('mcp_servers.github.env.GITHUB_TOKEN="weird\\\\\\"value"');
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });
});
