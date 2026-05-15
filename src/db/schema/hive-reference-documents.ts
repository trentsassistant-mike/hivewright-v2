import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const hiveReferenceDocuments = pgTable("hive_reference_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  hiveId: uuid("hive_id").notNull().references(() => hives.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  relativePath: text("relative_path").notNull(),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes").default(0).notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("hive_reference_documents_hive_relative_path_idx").on(table.hiveId, table.relativePath),
]);
