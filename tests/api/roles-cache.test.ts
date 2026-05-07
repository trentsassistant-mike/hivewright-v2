import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { GET as ROLES_GET } from "../../src/app/api/roles/route";
import { POST as PROVISION_POST } from "../../src/app/api/roles/[slug]/provision/route";
import { invalidateAll, getCachedStatus } from "../../src/provisioning/status-cache";

let tmp: string;

beforeEach(async () => {
  await truncateAll(sql);
  invalidateAll();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roles-cache-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
  process.env.OLLAMA_ENDPOINT = "http://127.0.0.1:1"; // fail-fast: avoids 5s timeout for ollama roles
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, recommended_model, role_md, soul_md, tools_md)
    VALUES ('cache-agent', 'Cache', 'eng', 'executor', 'openclaw', 'gpt-5.4', 'x', 'x', 'x')
    ON CONFLICT (slug) DO UPDATE SET adapter_type = 'openclaw', active = true
  `;
});

afterEach(() => {
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OLLAMA_ENDPOINT;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("roles route caching", () => {
  it("populates the cache after a GET /api/roles call", async () => {
    expect(getCachedStatus("cache-agent")).toBeUndefined();
    const res = await ROLES_GET();
    expect(res.status).toBe(200);
    expect(getCachedStatus("cache-agent")).toBeDefined();
  });

  it("provision invalidates the cached entry for that slug", async () => {
    await ROLES_GET();
    expect(getCachedStatus("cache-agent")).toBeDefined();

    const req = new Request("http://x/api/roles/cache-agent/provision", { method: "POST" });
    const res = await PROVISION_POST(req, { params: Promise.resolve({ slug: "cache-agent" }) });
    // Drain the stream to ensure the route's finally block runs
    await res.text();
    expect(getCachedStatus("cache-agent")).toBeUndefined();
  });
});
