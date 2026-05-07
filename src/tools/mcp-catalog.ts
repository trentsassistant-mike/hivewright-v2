/**
 * Central catalog of MCP servers HiveWright knows how to wire into adapter
 * subprocesses. Roles reference these by slug in `role_templates.tools_config.mcps`;
 * adapters (claude-code, codex) read this catalog to construct per-spawn MCP
 * config for the underlying CLI.
 *
 * Adding a new MCP: register it here, then any role can opt in via the dashboard
 * or by editing role.yaml. No adapter code changes required.
 */

export interface McpEntry {
  /** Stable slug used in role_templates.tools_config.mcps. */
  slug: string;
  /** Human-readable label for the dashboard. */
  label: string;
  /** Short tagline shown in the picker. */
  description: string;
  /** Executable to spawn the MCP server (typically "npx"). */
  command: string;
  /** Args passed to the command. */
  args: string[];
  /** Env-var names that must be present in the dispatcher env for this MCP to work. */
  requiredEnv?: string[];
}

export const MCP_CATALOG: McpEntry[] = [
  {
    slug: "context7",
    label: "Context7 Docs",
    description: "Up-to-date library docs (React, Next.js, Prisma, etc.) — better than the model's training cutoff.",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
  },
  {
    slug: "github",
    label: "GitHub",
    description: "Read/write GitHub PRs, issues, files. Needs GITHUB_TOKEN in dispatcher env.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requiredEnv: ["GITHUB_TOKEN"],
  },
  {
    slug: "playwright",
    label: "Playwright Browser",
    description: "Browser automation — navigate, click, take screenshots, read DOM. Used by QA + design + auditor.",
    command: "npx",
    args: ["-y", "@playwright/mcp"],
  },
  {
    slug: "sequential-thinking",
    label: "Sequential Thinking",
    description: "Multi-step reasoning helper — useful for planning roles + research.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
];

export function lookupMcp(slug: string): McpEntry | undefined {
  return MCP_CATALOG.find((e) => e.slug === slug);
}

/**
 * Resolve a role's mcp slug list to full McpEntry definitions, silently
 * dropping unknown slugs (e.g. an MCP catalog entry was removed but old
 * role rows still reference it).
 */
export function resolveMcps(slugs: string[] | undefined | null): McpEntry[] {
  if (!slugs || slugs.length === 0) return [];
  const out: McpEntry[] = [];
  for (const slug of slugs) {
    const entry = lookupMcp(slug);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * Build the JSON object claude-code expects for `--mcp-config`:
 *   { mcpServers: { name: { command, args, env } } }
 */
export function buildClaudeMcpConfig(entries: McpEntry[]): { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } {
  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const e of entries) {
    const cfg: { command: string; args: string[]; env?: Record<string, string> } = {
      command: e.command,
      args: [...e.args],
    };
    if (e.requiredEnv && e.requiredEnv.length > 0) {
      cfg.env = {};
      for (const k of e.requiredEnv) {
        const v = process.env[k];
        if (v !== undefined) cfg.env[k] = v;
      }
    }
    mcpServers[e.slug] = cfg;
  }
  return { mcpServers };
}

/**
 * Gemini CLI reads MCPs from a top-level `mcpServers` object in
 * `.gemini/settings.json`. The object shape matches claude-code's config, but
 * Gemini loads it from disk instead of an inline CLI flag.
 */
export function buildGeminiMcpSettings(entries: McpEntry[]): { mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> } {
  return buildClaudeMcpConfig(entries);
}

/**
 * Build the codex `-c mcp_servers.<name>.*=...` arg pairs. Each MCP becomes
 * three -c overrides (command, args, optional env).
 */
export function buildCodexMcpArgs(entries: McpEntry[]): string[] {
  const args: string[] = [];
  for (const e of entries) {
    args.push("-c", `mcp_servers.${e.slug}.command="${e.command}"`);
    // Codex parses `-c` values as TOML. JSON arrays of strings happen to be valid
    // TOML arrays so `args=[...]` via JSON.stringify works. JSON *objects* are NOT
    // valid TOML inline tables (bare-key vs. quoted-key syntax differs), so emit
    // one `-c` per env key using dotted path — round-trips cleanly and avoids the
    // CLI echoing the raw secret value back out in a parse error if malformed.
    args.push("-c", `mcp_servers.${e.slug}.args=${JSON.stringify(e.args)}`);
    if (e.requiredEnv && e.requiredEnv.length > 0) {
      for (const k of e.requiredEnv) {
        const v = process.env[k];
        if (v === undefined) continue;
        // TOML basic string: escape backslash and double-quote, then wrap in quotes.
        const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        args.push("-c", `mcp_servers.${e.slug}.env.${k}="${escaped}"`);
      }
    }
  }
  return args;
}
