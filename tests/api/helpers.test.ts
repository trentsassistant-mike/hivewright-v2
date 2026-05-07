import { describe, it, expect } from "vitest";
import {
  jsonOk,
  jsonError,
  jsonPaginated,
  parseSearchParams,
} from "@/app/api/_lib/responses";

describe("jsonOk", () => {
  it("returns 200 JSON response with data", async () => {
    const res = jsonOk({ name: "test" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("test");
  });
});

describe("jsonError", () => {
  it("returns error with specified status", async () => {
    const res = jsonError("Not found", 404);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

describe("jsonPaginated", () => {
  it("returns paginated response with total and items", async () => {
    const res = jsonPaginated([{ id: 1 }], 50, 10, 0);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(50);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(0);
  });
});

describe("parseSearchParams", () => {
  it("clamps limit to the configured max", () => {
    const params = parseSearchParams("http://localhost/api/test?limit=999");

    expect(params.getInt("limit", 50)).toBe(200);
  });

  it("falls back to the supplied default for missing or invalid limits", () => {
    const missing = parseSearchParams("http://localhost/api/test");
    const invalid = parseSearchParams("http://localhost/api/test?limit=abc");

    expect(missing.getInt("limit", 50)).toBe(50);
    expect(invalid.getInt("limit", 50)).toBe(50);
  });

  it("clamps negative offsets to zero", () => {
    const params = parseSearchParams("http://localhost/api/test?offset=-25");

    expect(params.getInt("offset", 0)).toBe(0);
  });

  it("preserves valid integer values", () => {
    const params = parseSearchParams("http://localhost/api/test?limit=75&offset=10");

    expect(params.getInt("limit", 50)).toBe(75);
    expect(params.getInt("offset", 0)).toBe(10);
  });
});
