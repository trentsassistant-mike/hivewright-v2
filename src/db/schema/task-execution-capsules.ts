import { integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar, index } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { tasks } from "./tasks";

export const taskExecutionCapsules = pgTable(
  "task_execution_capsules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    adapterType: varchar("adapter_type", { length: 100 }).notNull(),
    model: varchar("model", { length: 255 }),
    sessionId: text("session_id"),
    status: varchar("status", { length: 50 }).default("active").notNull(),
    qaState: varchar("qa_state", { length: 50 }).default("not_required").notNull(),
    reworkCount: integer("rework_count").default(0).notNull(),
    lastOutput: text("last_output"),
    lastQaFeedback: text("last_qa_feedback"),
    fallbackReason: text("fallback_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    taskUnique: uniqueIndex("task_execution_capsules_task_id_unique").on(table.taskId),
    statusIdx: index("task_execution_capsules_status_idx").on(table.status, table.qaState, table.updatedAt),
  }),
);
