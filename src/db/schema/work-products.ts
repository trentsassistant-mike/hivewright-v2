import { integer, jsonb, pgTable, uuid, varchar, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { tasks } from "./tasks";
import { roleTemplates } from "./role-templates";

export const workProducts = pgTable("work_products", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").references(() => tasks.id).notNull(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  roleSlug: varchar("role_slug").references(() => roleTemplates.slug).notNull(),
  department: varchar("department", { length: 100 }),
  content: text("content").notNull(),
  summary: text("summary"),
  artifactKind: varchar("artifact_kind", { length: 50 }),
  filePath: text("file_path"),
  mimeType: varchar("mime_type", { length: 100 }),
  width: integer("width"),
  height: integer("height"),
  modelName: varchar("model_name", { length: 100 }),
  modelSnapshot: varchar("model_snapshot", { length: 100 }),
  promptTokens: integer("prompt_tokens"),
  outputTokens: integer("output_tokens"),
  costCents: integer("cost_cents"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  sensitivity: varchar("sensitivity", { length: 50 }).default("internal").notNull(),
  synthesized: boolean("synthesized").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
