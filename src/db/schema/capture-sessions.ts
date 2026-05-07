import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hives } from "./hives";

export const captureSessions = pgTable(
  "capture_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    ownerUserId: varchar("owner_user_id", { length: 255 }).notNull(),
    ownerEmail: varchar("owner_email", { length: 320 }).notNull(),
    status: varchar("status", { length: 32 }).default("draft").notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    captureScope: jsonb("capture_scope").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    evidenceSummary: jsonb("evidence_summary")
      .$type<Record<string, unknown> | null>(),
    redactedSummary: text("redacted_summary"),
    workProductRefs: jsonb("work_product_refs")
      .$type<string[]>()
      .default([])
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("capture_sessions_hive_status_created_idx").on(
      t.hiveId,
      t.status,
      t.createdAt,
    ),
    index("capture_sessions_owner_created_idx").on(t.ownerUserId, t.createdAt),
    check(
      "capture_sessions_status_check",
      sql`${t.status} IN ('draft', 'recording', 'stopped', 'analysis_pending', 'review_ready', 'cancelled', 'deleted')`,
    ),
  ],
);
