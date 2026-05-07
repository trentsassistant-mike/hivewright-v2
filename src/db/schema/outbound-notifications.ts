import { jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const outboundNotifications = pgTable("outbound_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "set null" }),
  category: varchar("category", { length: 80 }).notNull(),
  sourceTable: varchar("source_table", { length: 80 }).notNull(),
  sourceId: uuid("source_id").notNull(),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: uuid("entity_id").notNull(),
  channelId: varchar("channel_id", { length: 32 }).notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 32 }).default("pending").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  notifiedAt: timestamp("notified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
