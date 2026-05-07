import { pgTable, uuid, varchar, integer, real, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { roleTemplates } from "./role-templates";
import { decisions } from "./decisions";

export const roleModelSwapWatches = pgTable("role_model_swap_watches", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  roleSlug: varchar("role_slug", { length: 100 }).references(() => roleTemplates.slug, { onDelete: "cascade" }).notNull(),
  fromModel: varchar("from_model", { length: 255 }),
  toModel: varchar("to_model", { length: 255 }).notNull(),
  tasksToWatch: integer("tasks_to_watch").default(5).notNull(),
  tasksSeen: integer("tasks_seen").default(0).notNull(),
  qualityFloor: real("quality_floor").default(0.7).notNull(),
  status: varchar("status", { length: 20 }).default("watching").notNull(),
  decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
