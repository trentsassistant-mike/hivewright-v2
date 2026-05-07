import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const idempotencyKeys = pgTable("idempotency_keys", {
  hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }).notNull(),
  route: text("route").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  responseBody: jsonb("response_body").notNull(),
  responseStatus: integer("response_status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idempotency_keys_scope_idx").on(table.hiveId, table.route, table.key),
  check("idempotency_keys_key_length", sql`char_length(${table.key}) <= 255`),
  check("idempotency_keys_key_printable_ascii", sql`${table.key} ~ '^[ -~]+$'`),
  check(
    "idempotency_keys_response_status_range",
    sql`${table.responseStatus} >= 100 AND ${table.responseStatus} <= 599`,
  ),
]);
