import { pgTable, uuid, text, bigint, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tasks } from "./tasks";
import { goals } from "./goals";
import { hiveIdeas } from "./hive-ideas";

export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    ideaId: uuid("idea_id").references(() => hiveIdeas.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_task_attachments_task").on(t.taskId),
    index("idx_task_attachments_goal").on(t.goalId),
    index("idx_task_attachments_idea").on(t.ideaId),
    check(
      "task_attachments_parent_check",
      sql`num_nonnulls(${t.taskId}, ${t.goalId}, ${t.ideaId}) = 1`,
    ),
  ],
);
