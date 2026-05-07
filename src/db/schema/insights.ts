import { pgTable, uuid, varchar, text, jsonb, real, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const insights = pgTable("insights", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  content: text("content").notNull(),
  evidence: jsonb("evidence").$type<{ quote: string; wpId: string }[]>(),
  connectionType: varchar("connection_type", { length: 50 }).notNull(),
  affectedDepartments: jsonb("affected_departments").$type<string[]>().default([]),
  confidence: real("confidence").default(0.5).notNull(),
  priority: varchar("priority", { length: 50 }).default("medium").notNull(),
  status: varchar("status", { length: 50 }).default("new").notNull(),
  sourceWorkProducts: jsonb("source_work_products").$type<string[]>().default([]),
  maxSourceSensitivity: varchar("max_source_sensitivity", { length: 50 }).default("internal").notNull(),
  curatorReason: text("curator_reason"),
  curatedAt: timestamp("curated_at"),
  decisionId: uuid("decision_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
