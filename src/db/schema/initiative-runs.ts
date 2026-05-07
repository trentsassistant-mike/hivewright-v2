import { sql } from "drizzle-orm";
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { decisions } from "./decisions";
import { goals } from "./goals";
import { hives } from "./hives";
import { tasks } from "./tasks";

export const initiativeRuns = pgTable("initiative_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id")
    .references(() => hives.id, { onDelete: "cascade" })
    .notNull(),
  triggerType: varchar("trigger_type", { length: 64 }).notNull(),
  triggerRef: varchar("trigger_ref", { length: 255 }),
  status: varchar("status", { length: 32 }).default("running").notNull(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  evaluatedCandidates: integer("evaluated_candidates").default(0).notNull(),
  createdCount: integer("created_count").default(0).notNull(),
  createdGoals: integer("created_goals").default(0).notNull(),
  createdTasks: integer("created_tasks").default(0).notNull(),
  createdDecisions: integer("created_decisions").default(0).notNull(),
  suppressedCount: integer("suppressed_count").default(0).notNull(),
  noopCount: integer("noop_count").default(0).notNull(),
  suppressionReasons: jsonb("suppression_reasons")
    .$type<Record<string, number>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  guardrailConfig: jsonb("guardrail_config")
    .$type<Record<string, number | string>>()
    .default(sql`'{}'::jsonb`)
    .notNull(),
  runFailures: integer("run_failures").default(0).notNull(),
  failureReason: text("failure_reason"),
});

export const initiativeRunDecisions = pgTable("initiative_run_decisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id")
    .references(() => initiativeRuns.id, { onDelete: "cascade" })
    .notNull(),
  hiveId: uuid("hive_id")
    .references(() => hives.id, { onDelete: "cascade" })
    .notNull(),
  triggerType: varchar("trigger_type", { length: 64 }).notNull(),
  candidateKey: varchar("candidate_key", { length: 255 }).notNull(),
  candidateRef: varchar("candidate_ref", { length: 255 }),
  actionTaken: varchar("action_taken", { length: 32 }).notNull(),
  rationale: text("rationale").notNull(),
  suppressionReason: varchar("suppression_reason", { length: 128 }),
  dedupeKey: varchar("dedupe_key", { length: 255 }),
  cooldownHours: integer("cooldown_hours"),
  perRunCap: integer("per_run_cap"),
  perDayCap: integer("per_day_cap"),
  evidence: jsonb("evidence").$type<unknown>().default(sql`'{}'::jsonb`).notNull(),
  actionPayload: jsonb("action_payload").$type<unknown>(),
  createdGoalId: uuid("created_goal_id").references(() => goals.id, {
    onDelete: "set null",
  }),
  createdTaskId: uuid("created_task_id").references(() => tasks.id, {
    onDelete: "set null",
  }),
  createdDecisionId: uuid("created_decision_id").references(() => decisions.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
