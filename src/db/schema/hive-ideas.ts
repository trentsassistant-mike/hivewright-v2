import { pgTable, uuid, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { goals } from "./goals";

export const hiveIdeas = pgTable(
  "hive_ideas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .notNull()
      .references(() => hives.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    body: text("body"),
    createdBy: varchar("created_by", { length: 50 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    reviewedAt: timestamp("reviewed_at"),
    aiAssessment: text("ai_assessment"),
    promotedToGoalId: uuid("promoted_to_goal_id").references(() => goals.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    hiveIdx: index("hive_ideas_hive_id_idx").on(t.hiveId),
    hiveStatusIdx: index("hive_ideas_hive_id_status_idx").on(t.hiveId, t.status),
  }),
);
