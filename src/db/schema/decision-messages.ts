import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { decisions } from "./decisions";

export const decisionMessages = pgTable("decision_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  decisionId: uuid("decision_id").references(() => decisions.id).notNull(),
  sender: varchar("sender", { length: 50 }).notNull(), // owner | goal-supervisor | system
  content: text("content").notNull(),
  supervisorWokenAt: timestamp("supervisor_woken_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
