import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { hives } from "./hives";
import { roleTemplates } from "./role-templates";

export type ActionPolicyEffect = "allow" | "require_approval" | "block";
export type ActionPolicyEffectType = "read" | "notify" | "write" | "financial" | "destructive" | "system";

export const actionPolicies = pgTable(
  "action_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull().default("Action policy"),
    enabled: boolean("enabled").default(true).notNull(),
    connector: varchar("connector", { length: 128 }),
    operation: varchar("operation", { length: 128 }),
    effectType: varchar("effect_type", { length: 32 }).$type<ActionPolicyEffectType>(),
    effect: varchar("effect", { length: 32 }).$type<ActionPolicyEffect>().notNull(),
    roleSlug: varchar("role_slug", { length: 100 }).references(() => roleTemplates.slug, {
      onDelete: "set null",
    }),
    priority: integer("priority").default(0).notNull(),
    conditions: jsonb("conditions").$type<Record<string, unknown>>().default({}).notNull(),
    reason: text("reason"),
    description: text("description"),
    createdBy: varchar("created_by", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("action_policies_hive_connector_operation_idx").on(
      table.hiveId,
      table.connector,
      table.operation,
    ),
    index("action_policies_hive_role_idx").on(table.hiveId, table.roleSlug),
    check(
      "action_policies_effect_check",
      sql`${table.effect} IN ('allow', 'require_approval', 'block')`,
    ),
    check(
      "action_policies_effect_type_check",
      sql`${table.effectType} IS NULL OR ${table.effectType} IN ('read', 'notify', 'write', 'financial', 'destructive', 'system')`,
    ),
    check(
      "action_policies_conditions_object_check",
      sql`jsonb_typeof(${table.conditions}) = 'object'`,
    ),
  ],
);
