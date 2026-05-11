import {
  pgTable,
  uuid,
  text,
  jsonb,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { goals } from "./goals";

/**
 * Audit trail of goal completions. One row per call to completeGoal().
 *
 * Multiple rows per goal_id are allowed so a re-opened-then-re-completed
 * goal has full history (the goals.status column is the current truth;
 * this table is the ledger). No uniqueness constraint on goal_id.
 *
 * `evidence` shape:
 * {
 *   taskIds?: string[],
 *   workProductIds?: string[],
 *   bundle?: Array<{
 *     type: string,
 *     description: string,
 *     reference?: string,
 *     value?: unknown,
 *     verified?: boolean
 *   }>
 * }
 * — referenced rows are NOT FK-validated at insert time (work_products in
 * particular may be soft-deleted before audit lookup). Evidence is for
 * provenance, not joinable foreign keys.
 *
 * Cascade-on-delete is intentional: dropping a goal purges its audit
 * history. Goals are currently soft-deleted via status (cancelled / achieved),
 * so hard DELETE is not expected in normal operation. If a future hard-delete
 * path emerges, revisit whether ON DELETE RESTRICT is preferable.
 */
export const goalCompletions = pgTable(
  "goal_completions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    goalId: uuid("goal_id")
      .references(() => goals.id, { onDelete: "cascade" })
      .notNull(),
    summary: text("summary").notNull(),
    evidence: jsonb("evidence").default({}).notNull(),
    learningGate: jsonb("learning_gate").$type<Record<string, unknown>>().default({}).notNull(),
    createdBy: varchar("created_by", { length: 255 }).notNull(), // 'goal-supervisor' | 'owner' | 'system'
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => ({
    // Composite (goal_id, created_at DESC NULLS FIRST) index — serves both
    // single-goal history queries and the idempotency LIMIT 1 lookup
    // without a sort step. NULLS FIRST matches PostgreSQL's default for
    // DESC ordering, which is what the planner requires to use this index
    // for ORDER BY clauses that don't specify a NULLS direction.
    goalIdCreatedAtIdx: index("goal_completions_goal_id_created_at_idx").on(
      t.goalId,
      t.createdAt.desc().nullsFirst(),
    ),
  }),
);
