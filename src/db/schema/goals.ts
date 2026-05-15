import { pgTable, uuid, varchar, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { projects } from "./projects";
import type { GoalBudgetState } from "@/budget/status";

export const goals = pgTable("goals", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  projectId: uuid("project_id").references(() => projects.id),
  parentId: uuid("parent_id"),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  priority: integer("priority").default(5).notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
  budgetCents: integer("budget_cents"),
  spentCents: integer("spent_cents").default(0).notNull(),
  budgetState: varchar("budget_state", { length: 32 }).$type<GoalBudgetState>().default("ok").notNull(),
  budgetWarningTriggeredAt: timestamp("budget_warning_triggered_at", { withTimezone: true }),
  budgetEnforcedAt: timestamp("budget_enforced_at", { withTimezone: true }),
  budgetEnforcementReason: text("budget_enforcement_reason"),
  sessionId: varchar("session_id", { length: 255 }),
  lastWokenSprint: integer("last_woken_sprint"),
  outcomeClassification: varchar("outcome_classification", { length: 32 }),
  outcomeClassificationRationale: text("outcome_classification_rationale"),
  outcomeProcessReferences: jsonb("outcome_process_references").$type<Record<string, unknown>[]>().default([]).notNull(),
  outcomeClassifiedAt: timestamp("outcome_classified_at", { withTimezone: true }),
  outcomeClassifiedBy: varchar("outcome_classified_by", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
