import { boolean, pgTable, uuid, varchar, text, jsonb, timestamp, integer } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { goals } from "./goals";
import { tasks } from "./tasks";

export type DecisionOption = {
  key: string;
  label: string;
  consequence?: string;
  description?: string;
  response?: string;
  canonicalResponse?: string;
  canonical_response?: string;
};

export const decisions = pgTable("decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  goalId: uuid("goal_id").references(() => goals.id),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  title: varchar("title", { length: 500 }).notNull(),
  context: text("context").notNull(),
  recommendation: text("recommendation"),
  options: jsonb("options").$type<DecisionOption[] | { options?: DecisionOption[] } | Record<string, unknown>>(),
  priority: varchar("priority", { length: 50 }).default("normal").notNull(),
  /**
   * Lifecycle:
   *   ea_review → EA is attempting autonomous resolution (default for any
   *               failure-class decision created by the system).
   *   pending   → EA has decided this needs the owner; visible on the
   *               default Decisions tab.
   *   resolved  → Either the EA auto-resolved, or the owner resolved it.
   */
  status: varchar("status", { length: 50 }).default("pending").notNull(),
  kind: varchar("kind", { length: 50 }).default("decision").notNull(),
  routeMetadata: jsonb("route_metadata").$type<Record<string, unknown>>(),
  ownerResponse: text("owner_response"),
  selectedOptionKey: text("selected_option_key"),
  selectedOptionLabel: text("selected_option_label"),
  resolvedBy: text("resolved_by"),
  /** Number of EA-resolution attempts so far (cap at 2 to avoid loops). */
  eaAttempts: integer("ea_attempts").default(0).notNull(),
  /** EA's plain-English summary of what it decided + why. */
  eaReasoning: text("ea_reasoning"),
  /** Timestamp of the last EA decision (auto-resolve OR escalation). */
  eaDecidedAt: timestamp("ea_decided_at"),
  isQaFixture: boolean("is_qa_fixture").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
});
