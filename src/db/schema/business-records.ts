import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { connectorInstalls } from "./connectors";

export const businessRecords = pgTable(
  "business_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    connectorInstallId: uuid("connector_install_id").references(() => connectorInstalls.id, {
      onDelete: "set null",
    }),
    sourceConnector: varchar("source_connector", { length: 128 }).notNull(),
    externalId: text("external_id").notNull(),
    recordType: varchar("record_type", { length: 128 }).notNull(),
    status: varchar("status", { length: 128 }),
    title: text("title"),
    occurredAt: timestamp("occurred_at"),
    amountCents: integer("amount_cents"),
    currency: varchar("currency", { length: 16 }),
    counterparty: text("counterparty"),
    normalized: jsonb("normalized").$type<Record<string, unknown>>().default({}).notNull(),
    rawRedacted: jsonb("raw_redacted").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("business_records_source_key_idx").on(
      table.hiveId,
      table.sourceConnector,
      table.externalId,
      table.recordType,
    ),
  ],
);
