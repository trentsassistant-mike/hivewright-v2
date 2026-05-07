import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { modelDiscoveryRuns } from "./model-discovery-runs";

export const modelCatalog = pgTable(
  "model_catalog",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 100 }).notNull(),
    adapterType: varchar("adapter_type", { length: 100 }).notNull(),
    modelId: varchar("model_id", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    family: varchar("family", { length: 120 }),
    capabilities: jsonb("capabilities").$type<string[]>().default([]).notNull(),
    local: boolean("local").default(false).notNull(),
    costPerInputToken: numeric("cost_per_input_token", { precision: 20, scale: 12 }),
    costPerOutputToken: numeric("cost_per_output_token", { precision: 20, scale: 12 }),
    benchmarkQualityScore: numeric("benchmark_quality_score", { precision: 5, scale: 2 }),
    routingCostScore: numeric("routing_cost_score", { precision: 5, scale: 2 }),
    metadataSourceName: varchar("metadata_source_name", { length: 255 }),
    metadataSourceUrl: varchar("metadata_source_url", { length: 1000 }),
    metadataLastCheckedAt: timestamp("metadata_last_checked_at", { withTimezone: true }),
    discoverySource: varchar("discovery_source", { length: 100 }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastDiscoveryRunId: uuid("last_discovery_run_id").references(() => modelDiscoveryRuns.id, {
      onDelete: "set null",
    }),
    staleSince: timestamp("stale_since", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("model_catalog_provider_adapter_model_idx").on(
      table.provider,
      table.adapterType,
      table.modelId,
    ),
    index("model_catalog_adapter_idx").on(table.adapterType),
    index("model_catalog_stale_since_idx").on(table.staleSince),
  ],
);
