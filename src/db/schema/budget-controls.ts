import { index, integer, pgTable, timestamp, uuid, varchar, uniqueIndex } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const budgetControls = pgTable(
  "budget_controls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id").notNull().references(() => hives.id, { onDelete: "cascade" }),
    scope: varchar("scope", { length: 32 }).notNull(),
    scopeId: uuid("scope_id"),
    capCents: integer("cap_cents").notNull(),
    budgetWindow: varchar("budget_window", { length: 32 }).default("all_time").notNull(),
    currency: varchar("currency", { length: 8 }).default("USD").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    hiveIdx: index("budget_controls_hive_idx").on(t.hiveId),
    scopeIdx: index("budget_controls_scope_idx").on(t.scope, t.scopeId),
  }),
);
