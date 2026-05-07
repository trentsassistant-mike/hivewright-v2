import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireSystemOwner: vi.fn(),
}));

import { PATCH } from "./route";
import { sql } from "@/app/api/_lib/db";
import { requireSystemOwner } from "@/app/api/_lib/auth";

const mockSql = sql as unknown as ReturnType<typeof vi.fn> & {
  begin: ReturnType<typeof vi.fn>;
};
const mockRequireSystemOwner = requireSystemOwner as unknown as ReturnType<typeof vi.fn>;

const hiveId = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ id: hiveId }) };

function patchRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/hives/${hiveId}/creation-pause`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/hives/[id]/creation-pause", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.begin = vi.fn(async (callback: (tx: typeof mockSql) => Promise<unknown>) => callback(mockSql));
    mockRequireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("requires a system owner before DB use", async () => {
    mockRequireSystemOwner.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
    });

    const res = await PATCH(patchRequest({ paused: true, reason: "Recovery" }), params);

    expect(res.status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("requires a reason when pausing", async () => {
    const res = await PATCH(patchRequest({ paused: true, reason: " " }), params);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("reason is required when pausing creation");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("snapshots and disables enabled schedules when pausing", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "22222222-2222-4222-8222-222222222222" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        hive_id: hiveId,
        creation_paused: true,
        reason: "Recovery",
        paused_by: "owner@example.com",
        updated_at: new Date("2026-05-02T06:00:00.000Z"),
        operating_state: "paused",
        schedule_snapshot: ["22222222-2222-4222-8222-222222222222"],
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        paused: true,
        reason: "Recovery",
        paused_by: "owner@example.com",
        updated_at: new Date("2026-05-02T06:00:00.000Z"),
        operating_state: "paused",
        schedule_snapshot: ["22222222-2222-4222-8222-222222222222"],
      }]);

    const res = await PATCH(patchRequest({ paused: true, reason: "Recovery" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      paused: true,
      reason: "Recovery",
      pausedBy: "owner@example.com",
      operatingState: "paused",
      pausedScheduleIds: ["22222222-2222-4222-8222-222222222222"],
      updatedAt: "2026-05-02T06:00:00.000Z",
    });
    const queryText = mockSql.mock.calls.map((call) => String(call[0]));
    expect(queryText.some((query) => query.includes("FROM schedules") && query.includes("enabled = true"))).toBe(true);
    expect(queryText.some((query) => query.includes("UPDATE schedules") && query.includes("enabled = false"))).toBe(true);
    expect(queryText.some((query) => query.includes("INSERT INTO hive_runtime_lock_events"))).toBe(true);
  });

  it("restores the saved schedule snapshot when resuming", async () => {
    mockSql
      .mockResolvedValueOnce([{ "?column?": 1 }])
      .mockResolvedValueOnce([{
        creation_paused: true,
        operating_state: "paused",
        schedule_snapshot: ["22222222-2222-4222-8222-222222222222"],
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        hive_id: hiveId,
        creation_paused: false,
        reason: null,
        paused_by: "owner@example.com",
        updated_at: new Date("2026-05-02T07:00:00.000Z"),
        operating_state: "normal",
        schedule_snapshot: [],
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        paused: false,
        reason: null,
        paused_by: "owner@example.com",
        updated_at: new Date("2026-05-02T07:00:00.000Z"),
        operating_state: "normal",
        schedule_snapshot: [],
      }]);

    const res = await PATCH(patchRequest({ paused: false }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      paused: false,
      reason: null,
      pausedBy: "owner@example.com",
      operatingState: "normal",
      pausedScheduleIds: [],
      updatedAt: "2026-05-02T07:00:00.000Z",
    });
    const queryText = mockSql.mock.calls.map((call) => String(call[0]));
    expect(queryText.some((query) => query.includes("UPDATE schedules") && query.includes("enabled = true"))).toBe(true);
  });
});
