import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { goals } from "./goals";
import { hives } from "./hives";
import { projects } from "./projects";
import { roleTemplates } from "./role-templates";
import { tasks } from "./tasks";

export const pipelineTemplates = pgTable(
  "pipeline_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: varchar("scope", { length: 20 }).notNull(),
    hiveId: uuid("hive_id").references(() => hives.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    department: varchar("department", { length: 100 }).notNull(),
    description: text("description"),
    mode: varchar("mode", { length: 50 }).default("production").notNull(),
    defaultSlaSeconds: integer("default_sla_seconds").default(900).notNull(),
    maxTotalCostCents: integer("max_total_cost_cents"),
    finalOutputContract: jsonb("final_output_contract").$type<Record<string, unknown>>().default({}).notNull(),
    dashboardVisibilityPolicy: varchar("dashboard_visibility_policy", { length: 50 }).default("summary_artifacts_only").notNull(),
    version: integer("version").default(1).notNull(),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    scopeCheck: check("pipeline_templates_scope_check", sql`${t.scope} IN ('global', 'hive')`),
    hiveScopeCheck: check(
      "pipeline_templates_hive_scope_check",
      sql`(${t.scope} = 'global' AND ${t.hiveId} IS NULL) OR (${t.scope} = 'hive' AND ${t.hiveId} IS NOT NULL)`,
    ),
    versionCheck: check("pipeline_templates_version_check", sql`${t.version} >= 1`),
    modeCheck: check("pipeline_templates_mode_check", sql`${t.mode} IN ('production', 'research', 'implementation', 'qa', 'monitoring', 'support')`),
    defaultSlaCheck: check("pipeline_templates_default_sla_seconds_check", sql`${t.defaultSlaSeconds} > 0`),
    maxTotalCostCheck: check("pipeline_templates_max_total_cost_cents_check", sql`${t.maxTotalCostCents} IS NULL OR ${t.maxTotalCostCents} >= 0`),
    dashboardVisibilityCheck: check("pipeline_templates_dashboard_visibility_policy_check", sql`${t.dashboardVisibilityPolicy} IN ('summary_artifacts_only', 'artifact_only', 'debug_full_transcript')`),
    slugVersionIdx: uniqueIndex("pipeline_templates_scope_hive_slug_version_idx").on(
      t.scope,
      sql`COALESCE(${t.hiveId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.slug,
      t.version,
    ),
    activeIdx: index("pipeline_templates_active_department_idx").on(
      t.active,
      t.department,
    ),
  }),
);

export const pipelineSteps = pgTable(
  "pipeline_steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .references(() => pipelineTemplates.id, { onDelete: "cascade" })
      .notNull(),
    stepOrder: integer("step_order").notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    roleSlug: varchar("role_slug", { length: 100 })
      .references(() => roleTemplates.slug)
      .notNull(),
    duty: text("duty").notNull(),
    skillSlugs: jsonb("skill_slugs").$type<string[]>().default([]).notNull(),
    connectorCapabilities: jsonb("connector_capabilities").$type<string[]>().default([]).notNull(),
    qaRequired: boolean("qa_required").default(false).notNull(),
    maxRuntimeSeconds: integer("max_runtime_seconds").default(300).notNull(),
    maxRetries: integer("max_retries").default(1).notNull(),
    maxCostCents: integer("max_cost_cents"),
    outputContract: jsonb("output_contract").$type<Record<string, unknown>>().default({}).notNull(),
    acceptanceCriteria: text("acceptance_criteria"),
    failurePolicy: varchar("failure_policy", { length: 50 }).default("retry_then_fail").notNull(),
    driftCheck: jsonb("drift_check").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => ({
    orderCheck: check("pipeline_steps_order_check", sql`${t.stepOrder} >= 1`),
    maxRuntimeCheck: check("pipeline_steps_max_runtime_seconds_check", sql`${t.maxRuntimeSeconds} > 0`),
    maxRetriesCheck: check("pipeline_steps_max_retries_check", sql`${t.maxRetries} >= 0 AND ${t.maxRetries} <= 3`),
    maxCostCheck: check("pipeline_steps_max_cost_cents_check", sql`${t.maxCostCents} IS NULL OR ${t.maxCostCents} >= 0`),
    failurePolicyCheck: check("pipeline_steps_failure_policy_check", sql`${t.failurePolicy} IN ('retry_then_fail', 'fail_fast', 'ask_owner', 'continue_with_warning', 'skip_optional')`),
    templateOrderIdx: uniqueIndex("pipeline_steps_template_order_idx").on(
      t.templateId,
      t.stepOrder,
    ),
    templateSlugIdx: uniqueIndex("pipeline_steps_template_slug_idx").on(
      t.templateId,
      t.slug,
    ),
  }),
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hiveId: uuid("hive_id")
      .references(() => hives.id, { onDelete: "cascade" })
      .notNull(),
    templateId: uuid("template_id")
      .references(() => pipelineTemplates.id)
      .notNull(),
    templateVersion: integer("template_version").notNull(),
    status: varchar("status", { length: 50 }).default("active").notNull(),
    currentStepId: uuid("current_step_id").references(() => pipelineSteps.id),
    sourceTaskId: uuid("source_task_id").references(() => tasks.id),
    goalId: uuid("goal_id").references(() => goals.id),
    projectId: uuid("project_id").references(() => projects.id),
    supervisorHandoff: text("supervisor_handoff"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    statusCheck: check("pipeline_runs_status_check", sql`${t.status} IN ('active', 'complete', 'failed', 'cancelled')`),
    templateVersionCheck: check("pipeline_runs_template_version_check", sql`${t.templateVersion} >= 1`),
    hiveStatusIdx: index("pipeline_runs_hive_status_idx").on(t.hiveId, t.status),
  }),
);

export const pipelineStepRuns = pgTable(
  "pipeline_step_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .references(() => pipelineRuns.id, { onDelete: "cascade" })
      .notNull(),
    stepId: uuid("step_id")
      .references(() => pipelineSteps.id)
      .notNull(),
    taskId: uuid("task_id").references(() => tasks.id),
    status: varchar("status", { length: 50 }).default("pending").notNull(),
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (t) => ({
    statusCheck: check("pipeline_step_runs_status_check", sql`${t.status} IN ('pending', 'running', 'complete', 'failed', 'skipped')`),
    runStepIdx: uniqueIndex("pipeline_step_runs_run_step_idx").on(t.runId, t.stepId),
    taskIdx: uniqueIndex("pipeline_step_runs_task_idx").on(t.taskId),
    runStatusIdx: index("pipeline_step_runs_run_status_idx").on(t.runId, t.status),
  }),
);
