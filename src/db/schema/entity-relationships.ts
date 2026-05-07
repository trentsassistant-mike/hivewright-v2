import { pgTable, uuid, varchar, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { entities } from "./entities";

export const entityRelationships = pgTable("entity_relationships", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").references(() => hives.id).notNull(),
  fromEntityId: uuid("from_entity_id").references(() => entities.id).notNull(),
  toEntityId: uuid("to_entity_id").references(() => entities.id).notNull(),
  relationshipType: varchar("relationship_type", { length: 100 }).notNull(), // uses, competes_with, depends_on, part_of, etc.
  confidence: real("confidence").default(0.8).notNull(),
  evidence: jsonb("evidence").$type<string[]>().default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
