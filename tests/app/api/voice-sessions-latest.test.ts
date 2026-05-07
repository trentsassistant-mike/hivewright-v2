import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET } from "@/app/api/voice/sessions/latest/route";

const HIVE_A = "00000000-0000-0000-0000-000000000001";
const HIVE_B = "00000000-0000-0000-0000-000000000002";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`INSERT INTO hives (id, slug, name, type) VALUES
    (${HIVE_A}, 'a', 'A', 'real'),
    (${HIVE_B}, 'b', 'B', 'real')`;
});

describe("GET /api/voice/sessions/latest", () => {
  it("returns the most recent session for a hive", async () => {
    await sql`INSERT INTO voice_sessions (id, hive_id, started_at) VALUES
      ('00000000-0000-0000-0000-000000000010', ${HIVE_A}, '2026-04-23 00:00:00'),
      ('00000000-0000-0000-0000-000000000011', ${HIVE_A}, '2026-04-23 00:05:00'),
      ('00000000-0000-0000-0000-000000000012', ${HIVE_B}, '2026-04-23 00:10:00')`;
    const req = new Request(
      `http://localhost/api/voice/sessions/latest?hiveId=${HIVE_A}`,
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe("00000000-0000-0000-0000-000000000011");
  });

  it("returns { session: null } when the hive has no sessions", async () => {
    const req = new Request(
      `http://localhost/api/voice/sessions/latest?hiveId=${HIVE_A}`,
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBeNull();
  });

  it("400s when hiveId is missing", async () => {
    const req = new Request(`http://localhost/api/voice/sessions/latest`);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });
});
