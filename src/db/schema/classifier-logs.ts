import { pgTable, uuid, varchar, text, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { classifications } from "./classifications";

export const classifierLogs = pgTable(
  "classifier_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    classificationId: uuid("classification_id").references(() => classifications.id, { onDelete: "set null" }),
    provider: varchar("provider", { length: 50 }).notNull(),
    model: varchar("model", { length: 100 }).notNull(),
    requestInput: text("request_input").notNull(),
    requestPrompt: text("request_prompt").notNull(),
    responseRaw: text("response_raw"),
    tokensInput: integer("tokens_input"),
    tokensOutput: integer("tokens_output"),
    costCents: integer("cost_cents"),
    latencyMs: integer("latency_ms").notNull(),
    success: boolean("success").notNull(),
    errorReason: text("error_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_classifier_logs_created").on(t.createdAt.desc()),
    index("idx_classifier_logs_provider_success").on(t.provider, t.success, t.createdAt.desc()),
  ],
);
