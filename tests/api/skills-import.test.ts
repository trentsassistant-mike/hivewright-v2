import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { POST } from "@/app/api/skills/import/route";

const HIVE = "dddddddd-dddd-dddd-dddd-dddddddddddd";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'sop-biz', 'SOP Biz', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('qa', 'QA Reviewer', 'system', 'claude-code'),
           ('owner', 'Owner', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

function buildRequest(payload: unknown): Request {
  return new Request("http://localhost/api/skills/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/skills/import", () => {
  it("creates a pending skill draft from pasted SOP text", async () => {
    const res = await POST(
      buildRequest({
        hiveId: HIVE,
        title: "Handle refund request",
        scope: "hive",
        content: "1. Look up booking\n2. Issue refund\n3. Confirm by email",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.slug).toBe("handle-refund-request");
    expect(body.data.status).toBe("pending");

    const [draft] = await sql`
      SELECT content, scope, role_slug FROM skill_drafts
      WHERE id = ${body.data.id}
    `;
    expect(draft.role_slug).toBe("owner");
    expect(draft.scope).toBe("hive");
    // Normalised wrap-up when no ## heading is present.
    expect((draft.content as string)).toMatch(/^# Handle refund request/);
    expect((draft.content as string)).toMatch(/## How to use/);
  });

  it("leaves already-SKILL.md-shaped content intact", async () => {
    const pretty = "# Foo\n\n## Steps\n\n- step 1\n- step 2\n";
    const res = await POST(
      buildRequest({ hiveId: HIVE, title: "Foo", content: pretty }),
    );
    const body = await res.json();
    const [draft] = await sql`
      SELECT content FROM skill_drafts WHERE id = ${body.data.id}
    `;
    expect(draft.content).toBe(pretty.trim());
  });

  it("rejects missing title or content", async () => {
    const res = await POST(buildRequest({ hiveId: HIVE, title: "", content: "" }));
    expect(res.status).toBe(400);
  });

  it("rejects titles that slugify to empty", async () => {
    const res = await POST(
      buildRequest({ hiveId: HIVE, title: "!!!", content: "anything" }),
    );
    expect(res.status).toBe(400);
  });
});
