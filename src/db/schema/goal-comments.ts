import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals";

export const goalComments = pgTable(
  "goal_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    goalId: uuid("goal_id")
      .references(() => goals.id, { onDelete: "cascade" })
      .notNull(),
    body: text("body").notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull().default("owner"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    goalIdCreatedAtIdx: index("goal_comments_goal_id_created_at_idx").on(
      t.goalId,
      t.createdAt.desc().nullsFirst(),
    ),
  }),
);
