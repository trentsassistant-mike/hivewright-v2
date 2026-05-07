import type { Sql } from "postgres";

export const OPERATIONS_MAP_PARKED_QA_HIVE_ID = "00000000-0000-4000-8000-00000000a501";
export const OPERATIONS_MAP_PARKED_QA_GOAL_ID = "00000000-0000-4000-8000-00000000a503";
export const OPERATIONS_MAP_PARKED_QA_TASK_ID = "00000000-0000-4000-8000-00000000a502";
export const OPERATIONS_MAP_PARKED_QA_HIVE_SLUG = "operations-map-parked-qa";
export const OPERATIONS_MAP_PARKED_QA_TASK_TITLE = "Operations Map manual QA parked task";

export interface OperationsMapParkedQaFixture {
  hiveId: string;
  hiveSlug: string;
  hiveName: string;
  goalId: string;
  taskId: string;
  taskTitle: string;
}

export async function createOperationsMapParkedQaFixture(sql: Sql): Promise<OperationsMapParkedQaFixture> {
  await cleanupOperationsMapParkedQaFixture(sql);

  await sql`
    INSERT INTO hives (id, slug, name, type, description, is_system_fixture)
    VALUES (
      ${OPERATIONS_MAP_PARKED_QA_HIVE_ID}::uuid,
      ${OPERATIONS_MAP_PARKED_QA_HIVE_SLUG},
      'Operations Map Parked QA',
      'digital',
      'Manual QA fixture for verifying the Operations Map parked-state critical lane.',
      false
    )
  `;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Developer Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  await sql`
    INSERT INTO goals (id, hive_id, title, description, status)
    VALUES (
      ${OPERATIONS_MAP_PARKED_QA_GOAL_ID}::uuid,
      ${OPERATIONS_MAP_PARKED_QA_HIVE_ID}::uuid,
      'Operations Map parked-state fixture',
      'Fixture goal that keeps the parked task consumable by dashboard joins.',
      'active'
    )
  `;

  await sql`
    INSERT INTO tasks (
      id,
      hive_id,
      goal_id,
      assigned_to,
      created_by,
      status,
      priority,
      title,
      brief,
      acceptance_criteria,
      updated_at
    )
    VALUES (
      ${OPERATIONS_MAP_PARKED_QA_TASK_ID}::uuid,
      ${OPERATIONS_MAP_PARKED_QA_HIVE_ID}::uuid,
      ${OPERATIONS_MAP_PARKED_QA_GOAL_ID}::uuid,
      'dev-agent',
      'qa-fixture',
      'blocked',
      4,
      ${OPERATIONS_MAP_PARKED_QA_TASK_TITLE},
      'Manual verification fixture: select the Operations Map Parked QA hive on / and confirm this blocked task appears in the Operations Map Critical lane as Parked.',
      'Dashboard / renders Operations Map with a Critical lane entry labelled Parked for this blocked fixture task.',
      NOW()
    )
  `;

  return {
    hiveId: OPERATIONS_MAP_PARKED_QA_HIVE_ID,
    hiveSlug: OPERATIONS_MAP_PARKED_QA_HIVE_SLUG,
    hiveName: "Operations Map Parked QA",
    goalId: OPERATIONS_MAP_PARKED_QA_GOAL_ID,
    taskId: OPERATIONS_MAP_PARKED_QA_TASK_ID,
    taskTitle: OPERATIONS_MAP_PARKED_QA_TASK_TITLE,
  };
}

export async function cleanupOperationsMapParkedQaFixture(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM tasks
    WHERE id = ${OPERATIONS_MAP_PARKED_QA_TASK_ID}::uuid
      AND created_by = 'qa-fixture'
  `;
  await sql`
    DELETE FROM goals
    WHERE id = ${OPERATIONS_MAP_PARKED_QA_GOAL_ID}::uuid
      AND hive_id = ${OPERATIONS_MAP_PARKED_QA_HIVE_ID}::uuid
  `;
  await sql`
    DELETE FROM hives
    WHERE id = ${OPERATIONS_MAP_PARKED_QA_HIVE_ID}::uuid
      AND slug = ${OPERATIONS_MAP_PARKED_QA_HIVE_SLUG}
  `;
}
