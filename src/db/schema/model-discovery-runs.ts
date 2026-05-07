import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { credentials } from "./credentials";
import { hives } from "./hives";

export const modelDiscoveryRuns = pgTable(
  "model_discovery_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }),
    adapterType: varchar("adapter_type", { length: 100 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    credentialId: uuid("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    source: varchar("source", { length: 100 }).notNull(),
    status: varchar("status", { length: 32 }).default("running").notNull(),
    modelsSeen: integer("models_seen").default(0).notNull(),
    modelsImported: integer("models_imported").default(0).notNull(),
    modelsAutoEnabled: integer("models_auto_enabled").default(0).notNull(),
    modelsMarkedStale: integer("models_marked_stale").default(0).notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("model_discovery_runs_hive_adapter_idx").on(
      table.hiveId,
      table.adapterType,
      table.startedAt.desc(),
    ),
  ],
);
