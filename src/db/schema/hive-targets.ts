import { pgTable, uuid, varchar, text, date, integer, timestamp, index } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const hiveTargets = pgTable(
  "hive_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .notNull()
      .references(() => hives.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    targetValue: varchar("target_value", { length: 255 }),
    deadline: date("deadline"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    hiveIdx: index("hive_targets_hive_id_idx").on(t.hiveId),
  }),
);
