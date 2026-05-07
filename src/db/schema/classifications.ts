import { pgTable, uuid, varchar, text, numeric, boolean, timestamp, check, index, AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tasks } from "./tasks";
import { goals } from "./goals";
import { roleTemplates } from "./role-templates";

export const classifications = pgTable(
  "classifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 10 }).notNull(),
    assignedRole: varchar("assigned_role", { length: 100 }).references(() => roleTemplates.slug),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
    reasoning: text("reasoning").notNull(),
    provider: varchar("provider", { length: 50 }).notNull(),
    model: varchar("model", { length: 100 }),
    wasFallback: boolean("was_fallback").default(false).notNull(),
    supersededBy: uuid("superseded_by").references((): AnyPgColumn => classifications.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check(
      "classifications_target_xor",
      sql`(${t.taskId} IS NOT NULL AND ${t.goalId} IS NULL) OR (${t.taskId} IS NULL AND ${t.goalId} IS NOT NULL)`,
    ),
    check("classifications_type_values", sql`${t.type} IN ('task', 'goal')`),
    check(
      "classifications_role_only_for_task",
      sql`${t.type} = 'task' OR ${t.assignedRole} IS NULL`,
    ),
    index("idx_classifications_task_current")
      .on(t.taskId, t.createdAt.desc())
      .where(sql`${t.supersededBy} IS NULL`),
    index("idx_classifications_goal_current")
      .on(t.goalId, t.createdAt.desc())
      .where(sql`${t.supersededBy} IS NULL`),
  ],
);
