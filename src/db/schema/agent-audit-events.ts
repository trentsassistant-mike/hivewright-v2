import { pgTable, uuid, varchar, jsonb, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { goals } from "./goals";
import { tasks } from "./tasks";

export const agentAuditEvents = pgTable("agent_audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventType: varchar("event_type", { length: 120 }).notNull(),
  actorType: varchar("actor_type", { length: 32 }).default("system").notNull(),
  actorId: varchar("actor_id", { length: 255 }),
  actorLabel: varchar("actor_label", { length: 255 }),
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "set null" }),
  goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
  taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
  agentId: varchar("agent_id", { length: 255 }),
  targetType: varchar("target_type", { length: 80 }).notNull(),
  targetId: varchar("target_id", { length: 255 }),
  outcome: varchar("outcome", { length: 32 }).notNull(),
  requestId: varchar("request_id", { length: 255 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
