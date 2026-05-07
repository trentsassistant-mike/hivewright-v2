import { describe, it, expect, beforeEach } from "vitest";
import { GET as getProjects, POST as createProject } from "@/app/api/projects/route";
import { GET as getProjectById } from "@/app/api/projects/[id]/route";
import { testSql as db, truncateAll } from "../_lib/test-db";

const TEST_PREFIX = "p4-proj-";

let testHiveId: string;
let testProjectId: string;

beforeEach(async () => {
  await truncateAll(db);

  // Create a test hive
  const [biz] = await db`
    INSERT INTO hives (slug, name, type, description)
    VALUES (${TEST_PREFIX + "biz"}, ${TEST_PREFIX + "Test Hive"}, 'service', 'Test hive for project API tests')
    RETURNING id
  `;
  testHiveId = biz.id;

  // Create a project so tests that reference testProjectId have it
  const [proj] = await db`
    INSERT INTO projects (hive_id, slug, name, workspace_path)
    VALUES (${testHiveId}, ${TEST_PREFIX + "website"}, ${TEST_PREFIX + "Main Website"}, '/tmp/test-proj')
    RETURNING id
  `;
  testProjectId = proj.id;
});

describe("POST /api/projects", () => {
  it("creates a project and returns 201", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        slug: TEST_PREFIX + "newproj",
        name: TEST_PREFIX + "New Project",
      }),
    });
    const res = await createProject(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.slug).toBe(TEST_PREFIX + "newproj");
    expect(body.data.name).toBe(TEST_PREFIX + "New Project");
    expect(body.data.hiveId).toBe(testHiveId);
    expect(body.data.workspacePath).toContain(TEST_PREFIX + "biz");
    expect(body.data.gitRepo).toBe(true);
  });

  it("returns 400 for missing required fields", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        // missing slug and name
      }),
    });
    const res = await createProject(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing required fields/i);
  });

  it("returns 409 for duplicate slug within same hive", async () => {
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        slug: TEST_PREFIX + "website",
        name: "Duplicate",
      }),
    });
    const res = await createProject(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("returns 404 for nonexistent hive", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = new Request("http://localhost:3000/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: fakeId,
        slug: TEST_PREFIX + "nope",
        name: "Nope",
      }),
    });
    const res = await createProject(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/hive not found/i);
  });
});

describe("GET /api/projects", () => {
  it("returns paginated project list filtered by hiveId", async () => {
    const req = new Request(
      `http://localhost:3000/api/projects?hiveId=${testHiveId}&limit=10&offset=0`,
    );
    const res = await getProjects(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(typeof body.total).toBe("number");
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
    const found = body.data.find((p: { id: string }) => p.id === testProjectId);
    expect(found).toBeDefined();
    expect(found.slug).toBe(TEST_PREFIX + "website");
  });

  it("returns 400 when hiveId is missing", async () => {
    const req = new Request("http://localhost:3000/api/projects");
    const res = await getProjects(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hiveId/i);
  });
});

describe("GET /api/projects/[id]", () => {
  it("returns project detail by id", async () => {
    const req = new Request(`http://localhost:3000/api/projects/${testProjectId}`);
    const res = await getProjectById(req, { params: Promise.resolve({ id: testProjectId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(testProjectId);
    expect(body.data.slug).toBe(TEST_PREFIX + "website");
    expect(body.data.hiveId).toBe(testHiveId);
  });

  it("returns 404 for nonexistent project", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = new Request(`http://localhost:3000/api/projects/${fakeId}`);
    const res = await getProjectById(req, { params: Promise.resolve({ id: fakeId }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });
});
