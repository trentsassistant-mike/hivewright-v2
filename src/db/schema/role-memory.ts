import { pgTable, uuid, varchar, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { roleTemplates } from "./role-templates";
import { tasks } from "./tasks";

export const roleMemory = pgTable("role_memory", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  roleSlug: varchar("role_slug").references(() => roleTemplates.slug).notNull(),
  content: text("content").notNull(),
  sourceTaskId: uuid("source_task_id").references(() => tasks.id),
  confidence: real("confidence").default(1.0).notNull(),
  lastAccessed: timestamp("last_accessed"),
  accessCount: integer("access_count").default(0).notNull(),
  sensitivity: varchar("sensitivity", { length: 50 }).default("internal").notNull(),
  supersededBy: uuid("superseded_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
