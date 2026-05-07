import { pgTable, uuid, varchar, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const schedules = pgTable("schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  cronExpression: varchar("cron_expression", { length: 100 }).notNull(),
  taskTemplate: jsonb("task_template").$type<{
    kind?: string;
    goalId?: string | null;
    assignedTo: string;
    title: string;
    brief: string;
    qaRequired?: boolean;
    priority?: number;
  }>().notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  createdBy: varchar("created_by", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
