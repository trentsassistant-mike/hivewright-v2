import { pgTable, uuid, varchar, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tasks } from "./tasks";

export const taskWorkspaces = pgTable("task_workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
  baseWorkspacePath: text("base_workspace_path"),
  worktreePath: text("worktree_path"),
  branchName: varchar("branch_name", { length: 255 }),
  isolationStatus: varchar("isolation_status", { length: 50 }).notNull(),
  isolationActive: boolean("isolation_active").default(false).notNull(),
  reused: boolean("reused").default(false).notNull(),
  failureReason: text("failure_reason"),
  skippedReason: text("skipped_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  reusedAt: timestamp("reused_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  taskWorkspacesTaskIdUnique: uniqueIndex("task_workspaces_task_id_unique").on(table.taskId),
}));
