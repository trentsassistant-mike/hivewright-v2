import { integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const embeddingConfig = pgTable("embedding_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: varchar("provider", { length: 32 }).notNull(),
  modelName: varchar("model_name", { length: 255 }).notNull(),
  dimension: integer("dimension").notNull(),
  apiCredentialKey: varchar("api_credential_key", { length: 255 }),
  endpointOverride: varchar("endpoint_override", { length: 500 }),
  status: varchar("status", { length: 32 }).notNull().default("ready"),
  lastReembeddedId: uuid("last_reembedded_id"),
  reembedTotal: integer("reembed_total").notNull().default(0),
  reembedProcessed: integer("reembed_processed").notNull().default(0),
  reembedStartedAt: timestamp("reembed_started_at"),
  reembedFinishedAt: timestamp("reembed_finished_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: varchar("updated_by", { length: 255 }),
});
