import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { actionPolicies } from "./action-policies";
import { decisions } from "./decisions";
import { goals } from "./goals";
import { hives } from "./hives";
import { roleTemplates } from "./role-templates";
import { tasks } from "./tasks";

export type ExternalActionRequestState =
  | "proposed"
  | "blocked"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled";

export const externalActionRequests = pgTable(
  "external_action_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    policyId: uuid("policy_id").references(() => actionPolicies.id, { onDelete: "set null" }),
    connector: varchar("connector", { length: 128 }).notNull(),
    operation: varchar("operation", { length: 128 }).notNull(),
    roleSlug: varchar("role_slug", { length: 100 }).references(() => roleTemplates.slug, {
      onDelete: "set null",
    }),
    state: varchar("state", { length: 32 }).$type<ExternalActionRequestState>().default("proposed").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    externalReference: text("external_reference"),
    requestPayloadHash: varchar("request_payload_hash", { length: 128 }),
    operationRiskTier: varchar("operation_risk_tier", { length: 32 }),
    requestPayload: jsonb("request_payload").$type<Record<string, unknown>>().default({}).notNull(),
    responsePayload: jsonb("response_payload").$type<Record<string, unknown>>().default({}).notNull(),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    executionMetadata: jsonb("execution_metadata").$type<Record<string, unknown>>().default({}).notNull(),
    encryptedExecutionPayload: text("encrypted_execution_payload"),
    errorMessage: text("error_message"),
    requestedBy: varchar("requested_by", { length: 255 }),
    reviewedBy: varchar("reviewed_by", { length: 255 }),
    reviewedAt: timestamp("reviewed_at"),
    executedAt: timestamp("executed_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("external_action_requests_hive_state_created_idx").on(
      table.hiveId,
      table.state,
      table.createdAt,
    ),
    index("external_action_requests_task_idx").on(table.taskId),
    index("external_action_requests_goal_idx").on(table.goalId),
    index("external_action_requests_decision_idx").on(table.decisionId),
    uniqueIndex("external_action_requests_hive_idempotency_key_unique")
      .on(table.hiveId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      "external_action_requests_state_check",
      sql`${table.state} IN ('proposed', 'blocked', 'awaiting_approval', 'approved', 'rejected', 'executing', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      "external_action_requests_request_payload_object_check",
      sql`jsonb_typeof(${table.requestPayload}) = 'object'`,
    ),
    check(
      "external_action_requests_response_payload_object_check",
      sql`jsonb_typeof(${table.responsePayload}) = 'object'`,
    ),
    check(
      "external_action_requests_policy_snapshot_object_check",
      sql`jsonb_typeof(${table.policySnapshot}) = 'object'`,
    ),
    check(
      "external_action_requests_execution_metadata_object_check",
      sql`jsonb_typeof(${table.executionMetadata}) = 'object'`,
    ),
  ],
);
