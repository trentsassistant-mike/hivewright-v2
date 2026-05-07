import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const adapterConfig = pgTable("adapter_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id),
  adapterType: varchar("adapter_type", { length: 50 }).notNull(),
  config: jsonb("config").$type<Record<string, string>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
