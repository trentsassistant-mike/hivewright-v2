import { pgTable, uuid, varchar, text, integer, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { projects } from "./projects";

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
  sessionId: varchar("session_id", { length: 255 }),
  lastWokenSprint: integer("last_woken_sprint"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});
