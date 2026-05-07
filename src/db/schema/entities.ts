import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const entities = pgTable("entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // person, company, product, service, location, concept
  attributes: jsonb("attributes").$type<Record<string, string>>().default({}),
  sourceTaskIds: jsonb("source_task_ids").$type<string[]>().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
