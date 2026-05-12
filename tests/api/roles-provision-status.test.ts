import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { testSql as sql, truncateAll, invalidateProvisionCache } from "../_lib/test-db";
import { GET, POST } from "../../src/app/api/roles/route";
import { syncRoleLibrary } from "../../src/roles/sync";

beforeEach(async () => {
  await truncateAll(sql);
  invalidateProvisionCache();
  process.env.OPENCLAW_CONFIG_PATH = "/nonexistent/openclaw.json"; // ensures openclaw check returns fixable=false
  process.env.OLLAMA_ENDPOINT = "http://127.0.0.1:1"; // fail immediately instead of 5s timeout
  const codexAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-codex-auth-"));
  const codexAuthFile = path.join(codexAuthDir, "auth.json");
  fs.writeFileSync(codexAuthFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "codex-oauth-token" },
  }));
  process.env.CODEX_AUTH_FILE = codexAuthFile;
  delete process.env.OPENAI_API_KEY;
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, recommended_model, role_md, soul_md, tools_md)
    VALUES ('dev-agent', 'Dev', 'engineering', 'executor', 'claude-code', 'claude-sonnet-4-6', 'x', 'x', 'x')
    ON CONFLICT (slug) DO UPDATE SET adapter_type = EXCLUDED.adapter_type, active = true
  `;
});

afterEach(() => {
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OLLAMA_ENDPOINT;
  delete process.env.OPENAI_API_KEY;
  if (process.env.CODEX_AUTH_FILE) {
    fs.rmSync(path.dirname(process.env.CODEX_AUTH_FILE), { recursive: true, force: true });
  }
  delete process.env.CODEX_AUTH_FILE;
});

describe("GET /api/roles returns provisionStatus", () => {
  it("includes { satisfied, fixable } per row", async () => {
    const res = await GET(new Request("http://localhost/api/roles"));
    const body = await res.json();
    const dev = (body.data as Array<{ slug: string; provisionStatus: { satisfied: boolean } }>).find((r) => r.slug === "dev-agent");
    expect(dev?.provisionStatus.satisfied).toBe(true);
  });

  it("treats auto model routing as configured without adapter provisioning", async () => {
    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto'
      WHERE slug = 'dev-agent'
    `;

    const res = await GET(new Request("http://localhost/api/roles"));
    const body = await res.json();
    const dev = (body.data as Array<{
      slug: string;
      adapterType: string;
      recommendedModel: string;
      provisionStatus: { satisfied: boolean; fixable: boolean; reason: string };
    }>).find((r) => r.slug === "dev-agent");

    expect(dev).toMatchObject({
      adapterType: "auto",
      recommendedModel: "auto",
      provisionStatus: { satisfied: true, fixable: false },
    });
    expect(dev?.provisionStatus.reason).toContain("automatic model routing");
  });

  it("exposes image-designer from the role library with automatic model routing", async () => {
    process.env.OPENAI_API_KEY = "sk-test-openai-image-key";
    await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql, { resetModelAndAdapter: true });

    const res = await GET(new Request("http://localhost/api/roles"));
    const body = await res.json();
    const imageDesigner = (body.data as Array<{
      slug: string;
      adapterType: string;
      recommendedModel: string;
      active: boolean;
      provisionStatus: { satisfied: boolean; fixable: boolean; reason: string };
    }>).find((r) => r.slug === "image-designer");

    expect(imageDesigner).toMatchObject({
      slug: "image-designer",
      adapterType: "auto",
      recommendedModel: "auto",
      active: true,
      provisionStatus: { satisfied: true, fixable: false },
    });
    expect(imageDesigner?.provisionStatus.reason).toContain("automatic model routing");
    expect(imageDesigner?.provisionStatus.reason).not.toContain("sk-test-openai-image-key");
  });

  it("exposes frontend-designer from the role library with automatic model routing", async () => {
    await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql, { resetModelAndAdapter: true });

    const res = await GET(new Request("http://localhost/api/roles"));
    const body = await res.json();
    const frontendDesigner = (body.data as Array<{
      slug: string;
      adapterType: string;
      recommendedModel: string;
      active: boolean;
      skills: string[];
      provisionStatus: { satisfied: boolean; fixable: boolean };
    }>).find((r) => r.slug === "frontend-designer");

    expect(frontendDesigner).toMatchObject({
      slug: "frontend-designer",
      adapterType: "auto",
      recommendedModel: "auto",
      active: true,
      provisionStatus: { satisfied: true, fixable: false },
    });
    expect(Array.isArray(frontendDesigner?.skills)).toBe(true);
    expect(frontendDesigner?.skills).toContain("frontend-design:frontend-design");
    expect(frontendDesigner?.skills).toContain("figma:figma-implement-design");
  });
});

describe("POST /api/roles returns provisionStatus", () => {
  it("responds with updated row and provisionStatus after adapter change", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        slug: "dev-agent",
        adapterType: "openclaw",
        recommendedModel: "gpt-5.4",
      }),
    });
    const res = await POST(req);
    const body = await res.json();
    const data = body.data as { slug: string; updated: boolean; provisionStatus: { satisfied: boolean; fixable: boolean } };
    expect(data.updated).toBe(true);
    expect(data.provisionStatus.satisfied).toBe(false); // openclaw config is missing
    expect(data.provisionStatus.fixable).toBe(false);
  });

  it("returns a satisfied provisionStatus when switching a role to auto routing", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: JSON.stringify({
        slug: "dev-agent",
        adapterType: "auto",
        recommendedModel: "auto",
      }),
    });

    const res = await POST(req);
    const body = await res.json();
    const data = body.data as {
      slug: string;
      updated: boolean;
      provisionStatus: { satisfied: boolean; fixable: boolean; reason: string };
    };

    expect(data.updated).toBe(true);
    expect(data.provisionStatus).toMatchObject({ satisfied: true, fixable: false });
    expect(data.provisionStatus.reason).toContain("automatic model routing");
  });
});
