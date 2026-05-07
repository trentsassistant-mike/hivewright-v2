import { pgTable, uuid, varchar, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  workspacePath: varchar("workspace_path", { length: 500 }),
  gitRepo: boolean("git_repo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("projects_hive_slug_unique").on(table.hiveId, table.slug),
]);
