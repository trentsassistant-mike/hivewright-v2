import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { goals } from "./goals";

/**
 * Durable planning artifacts owned by a goal.
 *
 * MVP: one row per (goalId, documentType). The supervisor upserts and the
 * `revision` counter increments on each update. Full revision history can be
 * added later with a separate `goal_document_revisions` table.
 */
export const goalDocuments = pgTable(
  "goal_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    goalId: uuid("goal_id")
      .references(() => goals.id, { onDelete: "cascade" })
      .notNull(),
    documentType: varchar("document_type", { length: 50 }).notNull(), // plan | research-summary | execution-outline | handover
    title: varchar("title", { length: 500 }).notNull(),
    format: varchar("format", { length: 20 }).default("markdown").notNull(),
    body: text("body").notNull(),
    revision: integer("revision").default(1).notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(), // goal-supervisor | owner | system
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    goalTypeUnique: uniqueIndex("goal_documents_goal_id_document_type_unique").on(
      t.goalId,
      t.documentType,
    ),
  }),
);
