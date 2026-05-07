import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, real, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { eaMessages } from "./ea-threads";
import { tasks } from "./tasks";

export const taskQualitySignals = pgTable(
  "task_quality_signals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .references(() => tasks.id, { onDelete: "cascade" })
      .notNull(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    signalType: varchar("signal_type", { length: 32 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    evidence: text("evidence").notNull(),
    confidence: real("confidence").default(0.5).notNull(),
    ownerMessageId: uuid("owner_message_id").references(() => eaMessages.id, { onDelete: "set null" }),
    rating: real("rating"),
    comment: text("comment"),
    isQaFixture: boolean("is_qa_fixture").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("task_quality_signals_hive_created_idx").on(t.hiveId, t.createdAt),
    index("task_quality_signals_task_created_idx").on(t.taskId, t.createdAt),
    index("task_quality_signals_source_idx").on(t.source, t.createdAt),
    check(
      "task_quality_signals_type_chk",
      sql`${t.signalType} IN ('positive', 'negative', 'neutral')`,
    ),
    check(
      "task_quality_signals_source_chk",
      sql`${t.source} IN ('implicit_ea', 'explicit_owner_feedback', 'explicit_ai_peer_feedback')`,
    ),
    check(
      "task_quality_signals_confidence_chk",
      sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`,
    ),
  ],
);
