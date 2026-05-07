import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hives } from "./hives";

export const eaThreads = pgTable(
  "ea_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    channelId: varchar("channel_id", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    closedAt: timestamp("closed_at"),
  },
  (t) => ({
    activePerChannel: uniqueIndex("ea_threads_active_per_channel")
      .on(t.hiveId, t.channelId)
      .where(sql`status = 'active'`),
  }),
);

export const eaMessages = pgTable(
  "ea_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .references(() => eaThreads.id, { onDelete: "cascade" })
      .notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    content: text("content").notNull(),
    discordMessageId: varchar("discord_message_id", { length: 64 }),
    source: varchar("source", { length: 16 }).notNull().default("discord"),
    voiceSessionId: uuid("voice_session_id"),
    status: varchar("status", { length: 32 }).notNull().default("sent"),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    threadIdCreatedAtIdx: index("ea_messages_thread_id_created_at_idx").on(
      t.threadId,
      t.createdAt,
    ),
  }),
);
