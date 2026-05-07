import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { POST as createWork } from "@/app/api/work/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  sessionUser: null as { id?: string | null; email?: string | null; name?: string | null } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(authState.authHeader ? { authorization: authState.authHeader } : {}),
}));

vi.mock("@/auth", () => ({
  auth: async () => (authState.sessionUser ? { user: authState.sessionUser } : null),
}));

let hiveId: string;

beforeEach(async () => {
  authState.authHeader = null;
  authState.sessionUser = null;
  process.env.VITEST = "false";
  delete process.env.INTERNAL_SERVICE_TOKEN;

  await truncateAll(sql);

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('work-internal-auth-hive', 'Work Internal Auth Hive', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
});

afterEach(() => {
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
});

describe.sequential("POST /api/work internal bearer auth", () => {
  it("accepts initiative follow-up submission when INTERNAL_SERVICE_TOKEN has surrounding whitespace", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "  initiative-token  ";
    authState.authHeader = "Bearer initiative-token";

    const response = await createWork(new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        input: "Resume the dormant goal with one concrete next implementation step.",
        createdBy: "initiative-engine",
        acceptanceCriteria: "A single executable follow-up task exists for the dormant goal.",
      }),
    }));

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      type: "task",
      title: "Resume the dormant goal with one concrete next implementation step",
    });

    const [task] = await sql<Array<{ created_by: string; assigned_to: string }>>`
      SELECT created_by, assigned_to
      FROM tasks
      WHERE id = ${payload.data.id}
    `;
    expect(task).toMatchObject({
      created_by: "initiative-engine",
      assigned_to: "dev-agent",
    });
  });

  it("still rejects initiative follow-up submission with the wrong bearer token", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "initiative-token";
    authState.authHeader = "Bearer wrong-token";

    const response = await createWork(new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        input: "This should be rejected before work intake runs.",
        createdBy: "initiative-engine",
      }),
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unauthorized",
    });
  });
});
