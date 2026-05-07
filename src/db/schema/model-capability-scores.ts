import {
  index,
  numeric,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { modelCatalog } from "./model-catalog";

export const modelCapabilityScores = pgTable(
  "model_capability_scores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    modelCatalogId: uuid("model_catalog_id").references(() => modelCatalog.id, {
      onDelete: "set null",
    }),
    provider: varchar("provider", { length: 100 }).notNull(),
    adapterType: varchar("adapter_type", { length: 100 }).notNull(),
    modelId: varchar("model_id", { length: 255 }).notNull(),
    canonicalModelId: varchar("canonical_model_id", { length: 255 }).notNull(),
    axis: varchar("axis", { length: 50 }).notNull(),
    score: numeric("score", { precision: 5, scale: 2 }).notNull(),
    rawScore: varchar("raw_score", { length: 255 }),
    source: varchar("source", { length: 255 }).notNull(),
    sourceUrl: varchar("source_url", { length: 1000 }).notNull(),
    benchmarkName: varchar("benchmark_name", { length: 255 }).notNull(),
    modelVersionMatched: varchar("model_version_matched", { length: 255 }).notNull(),
    confidence: varchar("confidence", { length: 20 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("model_capability_scores_model_axis_source_idx").on(
      table.provider,
      table.adapterType,
      table.canonicalModelId,
      table.axis,
      table.source,
      table.benchmarkName,
    ),
    index("model_capability_scores_catalog_idx").on(table.modelCatalogId),
    index("model_capability_scores_axis_idx").on(table.axis),
  ],
);
