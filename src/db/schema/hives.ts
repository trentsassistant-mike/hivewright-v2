import { boolean, integer, pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";

export const hives = pgTable("hives", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: varchar("slug", { length: 100 }).unique().notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // physical | digital | greenfield
  description: text("description"),
  mission: text("mission"),
  softwareStack: text("software_stack"),
  workspacePath: varchar("workspace_path", { length: 500 }),
  eaSessionId: varchar("ea_session_id", { length: 255 }),
  isSystemFixture: boolean("is_system_fixture").default(false).notNull(),
  aiBudgetCapCents: integer("ai_budget_cap_cents"),
  aiBudgetWindow: varchar("ai_budget_window", { length: 32 }).default("all_time").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
