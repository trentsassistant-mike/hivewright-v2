import { pgTable, uuid, text, jsonb, real, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const standingInstructions = pgTable("standing_instructions", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  content: text("content").notNull(),
  affectedDepartments: jsonb("affected_departments").$type<string[]>().default([]),
  sourceInsightId: uuid("source_insight_id"),
  confidence: real("confidence").default(0.85).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  reviewAt: timestamp("review_at"),
});
