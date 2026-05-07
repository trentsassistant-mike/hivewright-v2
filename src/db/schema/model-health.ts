import {
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const modelHealth = pgTable(
  "model_health",
  {
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    modelId: varchar("model_id", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).default("unknown").notNull(),
    lastProbedAt: timestamp("last_probed_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }),
    lastFailureReason: text("last_failure_reason"),
    nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    sampleCostUsd: numeric("sample_cost_usd", { precision: 12, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "model_health_pkey",
      columns: [table.fingerprint, table.modelId],
    }),
    index("model_health_next_probe_idx").on(table.nextProbeAt),
    index("model_health_status_idx").on(table.status),
  ],
);
