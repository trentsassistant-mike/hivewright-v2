import { describe, it, expect, beforeEach } from "vitest";
import { POST as createTask } from "@/app/api/tasks/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const BASE = "http://localhost:3000";
let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type, delegates_to)
    VALUES
      ('dev-agent', 'Dev Agent', 'executor', 'claude-code', '[]'::jsonb),
      ('bookkeeper', 'Bookkeeper', 'executor', 'claude-code', '[]'::jsonb)
    ON CONFLICT (slug) DO UPDATE SET
      delegates_to = EXCLUDED.delegates_to,
      active = true
  `;
  const [biz] = await sql`INSERT INTO hives (slug, name, type) VALUES ('p6-deleg-test', 'Deleg Test', 'digital') RETURNING *`;
  bizId = biz.id;
});

describe("Delegation validation", () => {
  it("allows owner to assign to any role", async () => {
    const req = new Request(`${BASE}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: bizId, assignedTo: "dev-agent", title: "p6-deleg-owner-task", brief: "Test", createdBy: "owner" }),
    });
    const res = await createTask(req);
    expect(res.status).toBe(201);
  });

  it("blocks role from delegating to roles not in delegates_to", async () => {
    // dev-agent has delegates_to: [] (empty = can't delegate to anyone)
    const req = new Request(`${BASE}/api/tasks`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: bizId, assignedTo: "bookkeeper", title: "p6-deleg-blocked", brief: "Test", createdBy: "dev-agent" }),
    });
    const res = await createTask(req);
    expect(res.status).toBe(403);
  });
});
