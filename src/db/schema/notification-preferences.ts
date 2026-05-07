import { pgTable, uuid, varchar, jsonb, boolean, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const notificationPreferences = pgTable("notification_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  channel: varchar("channel", { length: 50 }).notNull(), // discord | telegram | email | push
  config: jsonb("config").$type<Record<string, string>>().default({}),
  priorityFilter: varchar("priority_filter", { length: 50 }).default("all").notNull(), // all | urgent | normal
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
