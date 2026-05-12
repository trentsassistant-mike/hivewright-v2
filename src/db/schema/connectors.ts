import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  timestamp,
  text,
  integer,
  bigserial,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { credentials } from "./credentials";

/**
 * A per-hive binding of a catalog connector (Gmail, Xero, Discord, …). The
 * connector itself is defined in `src/connectors/registry.ts` — we only
 * store the install state here. Secrets go through the existing
 * `credentials` table (AES-256 at rest) and are referenced by
 * `credential_id`.
 */
export const connectorInstalls = pgTable("connector_installs", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id")
    .references(() => hives.id, { onDelete: "cascade" })
    .notNull(),
  connectorSlug: varchar("connector_slug", { length: 100 }).notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
  grantedScopes: jsonb("granted_scopes").$type<string[]>().default([]).notNull(),
  credentialId: uuid("credential_id").references(() => credentials.id, {
    onDelete: "set null",
  }),
  status: varchar("status", { length: 32 }).default("active").notNull(), // active | disabled | broken
  lastTestedAt: timestamp("last_tested_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const connectorEvents = pgTable("connector_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  installId: uuid("install_id")
    .references(() => connectorInstalls.id, { onDelete: "cascade" })
    .notNull(),
  operation: varchar("operation", { length: 100 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(), // success | error | skipped
  durationMs: integer("duration_ms"),
  errorText: text("error_text"),
  actor: varchar("actor", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const connectorSyncCursors = pgTable(
  "connector_sync_cursors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    installId: uuid("install_id")
      .references(() => connectorInstalls.id, { onDelete: "cascade" })
      .notNull(),
    stream: varchar("stream", { length: 128 }).notNull(),
    cursor: text("cursor"),
    lastSyncedAt: timestamp("last_synced_at"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("connector_sync_cursors_install_stream_idx").on(table.installId, table.stream),
  ],
);
