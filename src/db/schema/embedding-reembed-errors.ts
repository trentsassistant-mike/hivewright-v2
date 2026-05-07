import { integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { embeddingConfig } from "./embedding-config";
import { memoryEmbeddings } from "./memory-embeddings";

export const embeddingReembedErrors = pgTable("embedding_reembed_errors", {
  id: uuid("id").defaultRandom().primaryKey(),
  configId: uuid("config_id").notNull().references(() => embeddingConfig.id, { onDelete: "cascade" }),
  memoryEmbeddingId: uuid("memory_embedding_id").notNull().references(() => memoryEmbeddings.id, { onDelete: "cascade" }),
  sourceType: varchar("source_type", { length: 50 }).notNull(),
  sourceId: uuid("source_id").notNull(),
  chunkText: text("chunk_text").notNull(),
  errorMessage: text("error_message").notNull(),
  attemptCount: integer("attempt_count").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
