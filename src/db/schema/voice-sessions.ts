import {
  pgTable,
  uuid,
  varchar,
  integer,
  timestamp,
  jsonb,
  index,
  vector,
} from "drizzle-orm/pg-core";
import { hives } from "./hives";

export const voiceSessions = pgTable(
  "voice_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    endReason: varchar("end_reason", { length: 32 }),
    postCallSummaryPostedAt: timestamp("post_call_summary_posted_at", {
      withTimezone: true,
    }),
    twilioCallSid: varchar("twilio_call_sid", { length: 64 }),
    transportSeconds: integer("transport_seconds").notNull().default(0),
    llmCostCents: integer("llm_cost_cents").notNull().default(0),
    transportCostCents: integer("transport_cost_cents").notNull().default(0),
    /**
     * Which carrier delivered this call's audio. `'twilio'` for legacy
     * rows; `'direct-ws'` for the post-2026-05-07 PCM-over-WebSocket
     * path. New rows default to `'direct-ws'`.
     */
    transport: varchar("transport", { length: 32 })
      .notNull()
      .default("direct-ws"),
  },
  (t) => ({
    hiveStartedAtIdx: index("voice_sessions_hive_started_at_idx").on(
      t.hiveId,
      t.startedAt,
    ),
  }),
);

export const voiceSessionEvents = pgTable(
  "voice_session_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .references(() => voiceSessions.id, { onDelete: "cascade" })
      .notNull(),
    at: timestamp("at").defaultNow().notNull(),
    kind: varchar("kind", { length: 32 }).notNull(),
    text: varchar("text", { length: 65535 }),
    metadata: jsonb("metadata"),
  },
  (t) => ({
    sessionAtIdx: index("voice_session_events_session_at_idx").on(
      t.sessionId,
      t.at,
    ),
  }),
);

export const ownerVoiceprints = pgTable(
  "owner_voiceprints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    embedding: vector("embedding", { dimensions: 192 }).notNull(),
    enrolledAt: timestamp("enrolled_at").defaultNow().notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
  },
  (t) => ({
    hiveIdx: index("owner_voiceprints_hive_idx").on(t.hiveId),
  }),
);
