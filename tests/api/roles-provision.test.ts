import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { testSql as sql, truncateAll } from "../_lib/test-db";

// ---------------------------------------------------------------------------
// Mock the provisioning registry so individual tests can inject a slow stub.
// The factory runs once; per-test behaviour is set via mockImplementation.
// ---------------------------------------------------------------------------
vi.mock("../../src/provisioning/index", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/provisioning/index")>();
  return {
    ...real,
    provisionerFor: vi.fn(real.provisionerFor),
  };
});

import { provisionerFor } from "../../src/provisioning/index";
import { OpenClawProvisioner } from "../../src/provisioning/openclaw";
import { POST } from "../../src/app/api/roles/[slug]/provision/route";
import type { Provisioner, ProvisionProgress, ProvisionerInput } from "../../src/provisioning/types";

const mockProvisionerFor = vi.mocked(provisionerFor);

let tmp: string;

beforeEach(async () => {
  await truncateAll(sql);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-prov-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, recommended_model, role_md, soul_md, tools_md)
    VALUES ('dev-agent', 'Dev', 'eng', 'executor', 'openclaw', 'gpt-5.4', 'x', 'x', 'x')
    ON CONFLICT (slug) DO UPDATE SET adapter_type = 'openclaw', active = true
  `;
  // Reset per-test mock state; each test sets its own mockImplementation.
  mockProvisionerFor.mockReset();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

describe("POST /api/roles/:slug/provision", () => {
  it("streams SSE ending in a done event with satisfied=true", async () => {
    // Use the real provisioner for this test.
    mockProvisionerFor.mockImplementation(() => new OpenClawProvisioner());

    const req = new Request("http://x/api/roles/dev-agent/provision", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ slug: "dev-agent" }) });
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    const text = await res.text();
    expect(text).toMatch(/event: done/);
    expect(text).toMatch(/"satisfied":true/);
  });

  it("returns 404 for an unknown slug", async () => {
    const req = new Request("http://x/api/roles/nope/provision", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ slug: "nope" }) });
    expect(res.status).toBe(404);
  });

  it("stops streaming when the client aborts mid-stream", async () => {
    // Slow stub: yields 3 events with 50ms gaps so abort fires mid-stream.
    let yieldCount = 0;
    const slowProvisioner: Provisioner = {
      async check() { return { satisfied: false, fixable: true }; },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async *provision(_input: ProvisionerInput): AsyncIterable<ProvisionProgress> {
        await new Promise((r) => setTimeout(r, 50));
        yieldCount++;
        yield { phase: "checking", message: "step 1" };

        await new Promise((r) => setTimeout(r, 50));
        yieldCount++;
        yield { phase: "checking", message: "step 2" };

        await new Promise((r) => setTimeout(r, 50));
        yieldCount++;
        yield { phase: "done", status: { satisfied: true, fixable: true } };
      },
    };

    mockProvisionerFor.mockReturnValue(slowProvisioner);

    const ac = new AbortController();
    const req = new Request("http://x/api/roles/dev-agent/provision", {
      method: "POST",
      signal: ac.signal,
    });
    const res = await POST(req, { params: Promise.resolve({ slug: "dev-agent" }) });
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    const reader = res.body!.getReader();

    // Read the first SSE chunk, then abort immediately.
    const first = await reader.read();
    expect(first.done).toBe(false);
    ac.abort();

    // Drain the rest — the stream should close cleanly without throwing.
    let drainedOk = true;
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) break;
      }
    } catch {
      drainedOk = false;
    }
    expect(drainedOk).toBe(true);

    // Key regression guard: with abort handling the loop breaks after detecting
    // aborted=true, so the stub should have been pulled fewer than 3 times.
    // Without the abort check in route.ts the loop would run all three yields
    // (each with a 50ms delay) — yieldCount would be 3.
    expect(yieldCount).toBeLessThan(3);
  });

  it("returns 400 for an unsupported adapter type", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, department, type, adapter_type, recommended_model, role_md, soul_md, tools_md)
      VALUES ('weird-agent', 'Weird', 'eng', 'executor', 'nonexistent-adapter', 'gpt-5.4', 'x', 'x', 'x')
      ON CONFLICT (slug) DO UPDATE SET adapter_type = 'nonexistent-adapter', active = true
    `;
    const req = new Request("http://x/api/roles/weird-agent/provision", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ slug: "weird-agent" }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("unsupported adapter 'nonexistent-adapter'");
  });

  it("emits a final done event when the provisioner throws mid-stream", async () => {
    const throwingProvisioner = {
      check: async () => ({ satisfied: false, fixable: true }),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      provision: async function* (_input: ProvisionerInput): AsyncIterable<ProvisionProgress> {
        yield { phase: "checking" as const, message: "first event" };
        throw new Error("kaboom mid-stream");
      },
    };

    // Set up the mock to return the throwing provisioner for this test
    const { provisionerFor } = await import("../../src/provisioning/index");
    (provisionerFor as ReturnType<typeof vi.fn>).mockReturnValue(throwingProvisioner);

    await sql`
      INSERT INTO role_templates (slug, name, department, type, adapter_type, recommended_model, role_md, soul_md, tools_md)
      VALUES ('throw-agent', 'Throw', 'eng', 'executor', 'openclaw', 'gpt-5.4', 'x', 'x', 'x')
      ON CONFLICT (slug) DO UPDATE SET adapter_type = 'openclaw', active = true
    `;

    const req = new Request("http://x/api/roles/throw-agent/provision", { method: "POST" });
    const res = await POST(req, { params: Promise.resolve({ slug: "throw-agent" }) });
    const text = await res.text();

    // Two SSE events: the initial progress, then a done with the error.
    const events = text.match(/event: \w+/g) ?? [];
    expect(events).toEqual(["event: progress", "event: done"]);
    expect(text).toMatch(/"satisfied":false/);
    expect(text).toMatch(/kaboom mid-stream/);
  });
});
