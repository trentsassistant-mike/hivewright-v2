import { pgTable, uuid, jsonb, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { tasks } from "./tasks";
import type {
  HiveHealthReport,
  SupervisorActions,
  AppliedOutcome,
} from "../../supervisor/types";

export const supervisorReports = pgTable("supervisor_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id")
    .references(() => hives.id, { onDelete: "cascade" })
    .notNull(),
  ranAt: timestamp("ran_at").defaultNow().notNull(),
  report: jsonb("report").$type<HiveHealthReport>().notNull(),
  actions: jsonb("actions").$type<SupervisorActions | null>(),
  actionOutcomes: jsonb("action_outcomes").$type<AppliedOutcome[] | null>(),
  agentTaskId: uuid("agent_task_id").references(() => tasks.id, {
    onDelete: "set null",
  }),
  freshInputTokens: integer("fresh_input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cachedInputTokensKnown: boolean("cached_input_tokens_known").default(false).notNull(),
  totalContextTokens: integer("total_context_tokens"),
  estimatedBillableCostCents: integer("estimated_billable_cost_cents"),
  tokensInput: integer("tokens_input"),
  tokensOutput: integer("tokens_output"),
  costCents: integer("cost_cents"),
});
