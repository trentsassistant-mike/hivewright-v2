import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const memoryEmbeddings = pgTable("memory_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceType: varchar("source_type", { length: 50 }).notNull(),
  sourceId: uuid("source_id").notNull(),
  hiveId: uuid("hive_id").references(() => hives.id),
  chunkText: text("chunk_text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
