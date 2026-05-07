import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const hiveRuntimeLocks = pgTable("hive_runtime_locks", {
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).primaryKey(),
  creationPaused: boolean("creation_paused").default(false).notNull(),
  reason: text("reason"),
  pausedBy: text("paused_by"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  operatingState: text("operating_state").default("normal").notNull(),
  scheduleSnapshot: jsonb("schedule_snapshot").default([]).notNull(),
});

export const hiveRuntimeLockEvents = pgTable("hive_runtime_lock_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  previousState: text("previous_state"),
  nextState: text("next_state").notNull(),
  creationPaused: boolean("creation_paused").notNull(),
  reason: text("reason"),
  changedBy: text("changed_by"),
  scheduleSnapshot: jsonb("schedule_snapshot").default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
