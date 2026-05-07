import { pgTable, uuid, varchar, text, boolean, jsonb, timestamp, integer } from "drizzle-orm/pg-core";

export const roleTemplates = pgTable("role_templates", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  department: varchar("department", { length: 100 }),
  type: varchar("type", { length: 50 }).notNull(), // system | executor
  delegatesTo: jsonb("delegates_to").$type<string[]>().default([]),
  recommendedModel: varchar("recommended_model", { length: 255 }),
  fallbackModel: varchar("fallback_model", { length: 255 }),
  adapterType: varchar("adapter_type", { length: 100 }).notNull(),
  // Cross-adapter fallback: when the primary adapter_type is unhealthy (e.g.
  // local Ollama offline), the dispatcher transparently runs on this adapter
  // with fallback_model instead. NULL = use the same adapter as primary
  // (legacy behaviour — same-adapter rate-limit fallback only).
  fallbackAdapterType: varchar("fallback_adapter_type", { length: 100 }),
  skills: jsonb("skills").$type<string[]>().default([]),
  /**
   * Per-role tool/MCP scope. NULL = inherit whatever the runtime CLI's global
   * config says (current behaviour, preserves backwards compat).
   *
   * - mcps: list of MCP server slugs from src/tools/mcp-catalog.ts the role
   *         is allowed to use. Adapter expands these into per-spawn config.
   * - allowedTools: optional whitelist of built-in tool names (claude:
   *         "Bash,Edit,Read,Write"; codex: future). When set, --strict-mcp-config
   *         is also passed so global tools are excluded.
   */
  toolsConfig: jsonb("tools_config").$type<{ mcps?: string[]; allowedTools?: string[] }>(),
  roleMd: text("role_md"),
  soulMd: text("soul_md"),
  toolsMd: text("tools_md"),
  /**
   * Terminal roles are inherently single-turn: watchdogs (hive-supervisor),
   * system plumbing (qa, doctor, goal-supervisor), and analysis-only
   * executors (research-analyst, design-agent). Their completions don't
   * imply pending follow-up work, so the Hive Supervisor's
   * `unsatisfied_completion` and `orphan_output` detectors exclude them.
   * Maintained in role.yaml and re-synced on every role library sync;
   * not dashboard-overridable.
   */
  terminal: boolean("terminal").default(false).notNull(),
  /**
   * Max tasks of this role the dispatcher will run concurrently. The
   * task-claimer serialises per role via a NOT EXISTS check against the
   * active-task count for the same slug. Prior to 2026-04-22 this was
   * hardcoded to 1 (a carryover from OpenClaw's single-session-file
   * constraint). OpenClaw is retired, so the cap is now per-role
   * configurable. `goal-supervisor` is permanently exempt (persistent
   * per-goal sessions — serialisation would deadlock parallel goals).
   * Sensible floor is 1; no hard ceiling but the dispatcher-wide
   * maxConcurrentTasks still bounds overall in-flight work.
   */
  concurrencyLimit: integer("concurrency_limit").default(1).notNull(),
  ownerPinned: boolean("owner_pinned").default(false).notNull(),
  active: boolean("active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
