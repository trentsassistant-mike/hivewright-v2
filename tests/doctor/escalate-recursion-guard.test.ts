import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { escalateRecursionGuard } from "../../src/doctor/escalate";

vi.mock("../../src/notifications/sender", () => ({
  sendPushNotification: vi.fn().mockResolvedValue(undefined),
  sendNotification: vi.fn().mockResolvedValue({ sent: 0, errors: 0, skipped: 0 }),
}));

const BIZ = "11111111-1111-1111-1111-111111111111";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`INSERT INTO hives (id, slug, name, type) VALUES (${BIZ}, 'biz', 'Biz', 'digital')`;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev', 'Dev', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('doctor', 'Doctor', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

async function insertParentAndDoctor(): Promise<{ parentId: string; doctorId: string }> {
  const [parent] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief)
    VALUES (${BIZ}, 'dev', 'owner', 'failed', 5, 'parent task', 'parent brief')
    RETURNING id
  `;
  const [doctor] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, assigned_to, created_by, status, priority, title, brief, parent_task_id)
    VALUES (${BIZ}, 'doctor', 'dispatcher', 'failed', 5, 'doctor: parent task', 'doctor brief', ${parent.id})
    RETURNING id
  `;
  return { parentId: parent.id, doctorId: doctor.id };
}

describe("escalateRecursionGuard", () => {
  it("creates an urgent decision linked to the parent task with 3 options", async () => {
    const { parentId, doctorId } = await insertParentAndDoctor();
    await escalateRecursionGuard(sql, doctorId, "boom");

    const [d] = await sql<{
      hive_id: string;
      goal_id: string | null;
      task_id: string | null;
      title: string;
      priority: string;
      options: { label: string; action: string }[];
    }[]>`
      SELECT hive_id, goal_id, task_id, title, priority, options
      FROM decisions WHERE task_id = ${parentId}
    `;
    expect(d).toBeDefined();
    expect(d.hive_id).toBe(BIZ);
    expect(d.priority).toBe("urgent");
    expect(d.title).toContain("Doctor could not resolve");
    expect(d.options).toHaveLength(3);
    expect(d.options.map((o) => o.action)).toEqual(["retry", "reassign", "drop"]);
  });

  it("creates the decision with status='ea_review' and does NOT fire inline notifications", async () => {
    // EA-first pipeline: escalateRecursionGuard hands the decision to
    // the EA-resolver loop instead of pinging the owner directly. The
    // EA decides whether to auto-resolve (cancel the orphan, retry
    // with a new role, etc.) or escalate with rewritten plain-English
    // context — and only then does it fire the notification itself.
    const { parentId, doctorId } = await insertParentAndDoctor();
    const { sendPushNotification, sendNotification } = await import("../../src/notifications/sender");
    vi.mocked(sendPushNotification).mockClear();
    vi.mocked(sendNotification).mockClear();

    await escalateRecursionGuard(sql, doctorId, "boom");

    const [d] = await sql<{ status: string }[]>`SELECT status FROM decisions WHERE task_id = ${parentId}`;
    expect(d.status).toBe("ea_review");
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("tags the decision kind='decision' for owner-actionable failures (still no inline notify)", async () => {
    const { parentId, doctorId } = await insertParentAndDoctor();
    const { sendPushNotification, sendNotification } = await import("../../src/notifications/sender");
    vi.mocked(sendPushNotification).mockClear();
    vi.mocked(sendNotification).mockClear();

    await escalateRecursionGuard(sql, doctorId, "Budget cap reached — ship anyway?");

    const [d] = await sql<{ kind: string; status: string }[]>`
      SELECT kind, status FROM decisions WHERE task_id = ${parentId}
    `;
    expect(d.kind).toBe("decision");
    expect(d.status).toBe("ea_review");
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("tags the decision kind='system_error' for infra failures (also via ea_review)", async () => {
    const { parentId, doctorId } = await insertParentAndDoctor();
    const { sendPushNotification, sendNotification } = await import("../../src/notifications/sender");
    vi.mocked(sendPushNotification).mockClear();
    vi.mocked(sendNotification).mockClear();

    await escalateRecursionGuard(
      sql,
      doctorId,
      'Process exited with code 1: Error loading config.toml: invalid type: string "{...}"',
    );

    const [d] = await sql<{ kind: string; priority: string; status: string }[]>`
      SELECT kind, priority, status FROM decisions WHERE task_id = ${parentId}
    `;
    expect(d.kind).toBe("system_error");
    expect(d.priority).toBe("urgent");
    expect(d.status).toBe("ea_review");
    expect(sendPushNotification).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
