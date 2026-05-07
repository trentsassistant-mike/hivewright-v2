import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { storeCredential } from "@/credentials/manager";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

let GET: typeof import("@/app/api/openrouter/models/route").GET;

const ENCRYPTION_KEY = "test-encryption-key-32-bytes-long!!";

beforeEach(async () => {
  await truncateAll(sql);
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  fetchMock.mockReset();
  ({ GET } = await import("@/app/api/openrouter/models/route"));
});

describe("GET /api/openrouter/models", () => {
  it("returns 503 when OPENROUTER_API_KEY is missing", async () => {
    const res = await GET(new Request("http://localhost/api/openrouter/models"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/openrouter/i);
  });

  it("returns model list with a `free` flag per model", async () => {
    await storeCredential(sql, {
      hiveId: null,
      name: "OpenRouter",
      key: "OPENROUTER_API_KEY",
      value: "or-test-key",
      rolesAllowed: [],
      encryptionKey: ENCRYPTION_KEY,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "google/gemini-2.0-flash-exp:free", name: "Gemini Flash Free",
              pricing: { prompt: "0", completion: "0" } },
            { id: "openai/gpt-4o", name: "GPT-4o",
              pricing: { prompt: "0.0000025", completion: "0.00001" } },
          ],
        }),
        { status: 200 },
      ),
    );

    const res = await GET(new Request("http://localhost/api/openrouter/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.data).toHaveLength(2);
    expect(body.data.data[0].id).toBe("google/gemini-2.0-flash-exp:free");
    expect(body.data.data[0].free).toBe(true);
    expect(body.data.data[1].free).toBe(false);
  });

  it("filters to free models when ?freeOnly=true", async () => {
    await storeCredential(sql, {
      hiveId: null, name: "OpenRouter", key: "OPENROUTER_API_KEY",
      value: "or-test-key", rolesAllowed: [], encryptionKey: ENCRYPTION_KEY,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "a:free", name: "A", pricing: { prompt: "0", completion: "0" } },
            { id: "b", name: "B", pricing: { prompt: "0.001", completion: "0.002" } },
          ],
        }),
        { status: 200 },
      ),
    );

    const res = await GET(new Request("http://localhost/api/openrouter/models?freeOnly=true"));
    const body = await res.json();
    expect(body.data.data).toHaveLength(1);
    expect(body.data.data[0].id).toBe("a:free");
  });
});
