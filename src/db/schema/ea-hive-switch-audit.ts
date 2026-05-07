import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { eaMessages, eaThreads } from "./ea-threads";

export const eaHiveSwitchAudit = pgTable(
  "ea_hive_switch_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromHiveId: uuid("from_hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    toHiveId: uuid("to_hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    eaThreadId: uuid("ea_thread_id").references(() => eaThreads.id, {
      onDelete: "set null",
    }),
    ownerMessageId: uuid("owner_message_id").references(() => eaMessages.id, {
      onDelete: "set null",
    }),
    requestPath: varchar("request_path", { length: 255 }).notNull(),
    requestMethod: varchar("request_method", { length: 16 }).notNull(),
    actor: varchar("actor", { length: 100 }).default("ea").notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    createdResourceType: varchar("created_resource_type", { length: 64 }),
    createdResourceId: uuid("created_resource_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    fromHiveCreatedIdx: index("ea_hive_switch_audit_from_hive_created_idx").on(
      t.fromHiveId,
      t.createdAt,
    ),
    toHiveCreatedIdx: index("ea_hive_switch_audit_to_hive_created_idx").on(
      t.toHiveId,
      t.createdAt,
    ),
    threadCreatedIdx: index("ea_hive_switch_audit_thread_created_idx").on(
      t.eaThreadId,
      t.createdAt,
    ),
  }),
);
