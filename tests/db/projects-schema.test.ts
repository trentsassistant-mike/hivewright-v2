import { describe, it, expect, beforeEach } from "vitest";
import { testSql as db, truncateAll } from "../_lib/test-db";

const TEST_PREFIX = "gap1-schema-";

let testHiveId: string;

beforeEach(async () => {
  await truncateAll(db);

  // seed dev-agent role (needed for tasks.assigned_to FK)
  await db`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [biz] = await db`
    INSERT INTO hives (slug, name, type)
    VALUES (${TEST_PREFIX + "biz"}, 'Test Biz', 'digital')
    RETURNING id
  `;
  testHiveId = biz.id;

  // Seed a project that dependent tests can reference
  await db`
    INSERT INTO projects (hive_id, slug, name, workspace_path)
    VALUES (${testHiveId}, ${TEST_PREFIX + "website"}, 'Website Rebuild', '/tmp/test-workspace')
  `;
});

describe("projects table", () => {
  it("can insert a project", async () => {
    const [project] = await db`
      SELECT id, slug, name, workspace_path, git_repo
      FROM projects WHERE slug = ${TEST_PREFIX + "website"}
    `;
    expect(project.slug).toBe(TEST_PREFIX + "website");
    expect(project.name).toBe("Website Rebuild");
    expect(project.workspace_path).toBe("/tmp/test-workspace");
    expect(project.git_repo).toBe(true);
  });

  it("enforces unique slug per hive", async () => {
    await expect(
      db`INSERT INTO projects (hive_id, slug, name, workspace_path)
         VALUES (${testHiveId}, ${TEST_PREFIX + "website"}, 'Dupe', '/tmp/dupe')`,
    ).rejects.toThrow();
  });

  it("allows tasks to reference a project", async () => {
    const [project] = await db`
      SELECT id FROM projects WHERE slug = ${TEST_PREFIX + "website"}
    `;
    const [task] = await db`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, project_id)
      VALUES (${testHiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "task"}, 'brief', ${project.id})
      RETURNING project_id
    `;
    expect(task.project_id).toBe(project.id);
  });

  it("allows tasks without a project", async () => {
    const [task] = await db`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${testHiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "task-no-proj"}, 'brief')
      RETURNING project_id
    `;
    expect(task.project_id).toBeNull();
  });
});
