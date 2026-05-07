import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { POST } from "@/app/api/voice/voiceprint/enroll/route";

/**
 * POST /api/voice/voiceprint/enroll — happy path + four failure modes.
 *
 * The GPU `/voiceprint/embed` call is mocked via `global.fetch`; the
 * route's auth gate is bypassed in vitest via the `VITEST` env flag
 * inside `requireApiUser` (same pattern as every other voice test).
 * The DB writes to `owner_voiceprints` run against the shared test
 * database, so assertions can SELECT directly.
 */

const HIVE_ID = "00000000-0000-0000-0000-000000000001";

function wavForm(bytes = 100): FormData {
  const form = new FormData();
  form.append("hiveId", HIVE_ID);
  form.append(
    "sample",
    new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
  );
  return form;
}

function enrollRequest(form: FormData): Request {
  return new Request("http://localhost/api/voice/voiceprint/enroll", {
    method: "POST",
    body: form,
  });
}

describe("POST /api/voice/voiceprint/enroll", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}, 'vp-test', 'Voiceprint Test', 'real')
    `;
    // Voice services URL now comes from env (post-Phase-A — see
    // src/lib/voice-services-url.ts). Restore in afterEach below.
    process.env.VOICE_SERVICES_URL = "http://gpu.local:8790";

    // Default: GPU returns a well-formed 192-d embedding.
    (global.fetch as unknown) = vi.fn(async (url: string) => {
      if (String(url).endsWith("/voiceprint/embed")) {
        return new Response(
          JSON.stringify({ embedding: new Array(192).fill(0.1) }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    });
  });

  afterEach(() => {
    delete process.env.VOICE_SERVICES_URL;
  });

  it("stores a 192-d vector in owner_voiceprints", async () => {
    const res = await POST(enrollRequest(wavForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("string");

    const rows = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM owner_voiceprints
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].hive_id).toBe(HIVE_ID);

    // Confirm the GPU endpoint was hit exactly once at the right URL.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(calledUrl)).toBe("http://gpu.local:8790/voiceprint/embed");
  });

  it("400s when neither voice-ea connector nor VOICE_SERVICES_URL is configured", async () => {
    delete process.env.VOICE_SERVICES_URL;
    const res = await POST(enrollRequest(wavForm()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/voice-ea/i);
  });

  it("400s when hiveId or sample is missing", async () => {
    const form = new FormData();
    form.append("hiveId", HIVE_ID);
    const res = await POST(enrollRequest(form));
    expect(res.status).toBe(400);
  });

  it("413s when sample exceeds 10 MB", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const form = new FormData();
    form.append("hiveId", HIVE_ID);
    form.append("sample", new Blob([big], { type: "audio/wav" }));
    const res = await POST(enrollRequest(form));
    expect(res.status).toBe(413);
  });

  it("502s when voice services returns a malformed embedding", async () => {
    (global.fetch as unknown) = vi.fn(async () =>
      new Response(JSON.stringify({ embedding: "nope" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const res = await POST(enrollRequest(wavForm()));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/malformed/i);
  });
});
