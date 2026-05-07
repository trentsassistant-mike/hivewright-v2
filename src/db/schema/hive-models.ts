import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { credentials } from "./credentials";
import { hives } from "./hives";
import { modelDiscoveryRuns } from "./model-discovery-runs";
import { modelCatalog } from "./model-catalog";

export const hiveModels = pgTable(
  "hive_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    modelId: varchar("model_id", { length: 255 }).notNull(),
    adapterType: varchar("adapter_type", { length: 100 }).notNull(),
    modelCatalogId: uuid("model_catalog_id").references(() => modelCatalog.id, { onDelete: "set null" }),
    credentialId: uuid("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    costPerInputToken: numeric("cost_per_input_token", { precision: 20, scale: 12 }),
    costPerOutputToken: numeric("cost_per_output_token", { precision: 20, scale: 12 }),
    benchmarkQualityScore: numeric("benchmark_quality_score", { precision: 5, scale: 2 }),
    routingCostScore: numeric("routing_cost_score", { precision: 5, scale: 2 }),
    fallbackPriority: integer("fallback_priority").default(100).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    autoDiscovered: boolean("auto_discovered").default(false).notNull(),
    ownerDisabledAt: timestamp("owner_disabled_at", { withTimezone: true }),
    ownerDisabledReason: text("owner_disabled_reason"),
    lastDiscoveryRunId: uuid("last_discovery_run_id").references(() => modelDiscoveryRuns.id, {
      onDelete: "set null",
    }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("hive_models_hive_provider_model_idx").on(
      table.hiveId,
      table.provider,
      table.modelId,
    ),
    index("hive_models_hive_enabled_priority_idx").on(
      table.hiveId,
      table.enabled,
      table.fallbackPriority,
    ),
    index("hive_models_credential_idx").on(table.credentialId),
    index("hive_models_model_catalog_idx").on(table.modelCatalogId),
    index("hive_models_owner_disabled_idx")
      .on(table.hiveId, table.ownerDisabledAt)
      .where(sql`${table.ownerDisabledAt} IS NOT NULL`),
  ],
);
