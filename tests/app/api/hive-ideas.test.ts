import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import * as attachmentPersist from "@/attachments/persist";

// -----------------------------------------------------------------------------
// Section A: CRUD + lifecycle with the default VITEST bypass
// (requireApiUser returns isSystemOwner=true). No auth/canAccessHive mocks.
// -----------------------------------------------------------------------------
import {
  GET as IDEAS_GET,
  POST as IDEAS_POST,
} from "@/app/api/hives/[id]/ideas/route";
import {
  PATCH as IDEA_PATCH,
  DELETE as IDEA_DELETE,
} from "@/app/api/hives/[id]/ideas/[ideaId]/route";

const createdHiveSlugs = new Set<string>();

async function seedHive(): Promise<string> {
  const slug = "hi-" + Math.random().toString(36).slice(2, 8);
  createdHiveSlugs.add(slug);
  const [h] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type) VALUES ('I', ${slug}, 'digital') RETURNING id
  `;
  return h.id;
}

function hiveAttachmentDir(slug: string) {
  return `/home/example/hives/${slug}`;
}

function req(
  url: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  const hdrs: Record<string, string> = { ...(headers ?? {}) };
  if (body) hdrs["Content-Type"] = "application/json";
  return new Request(url, {
    method,
    headers: hdrs,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("/api/hives/[id]/ideas — CRUD + lifecycle (system-owner bypass)", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  afterAll(async () => {
    for (const slug of createdHiveSlugs) {
      const dir = hiveAttachmentDir(slug);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("POST creates an idea with session-derived created_by='owner'", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req(`http://t/api/hives/${id}/ideas`, "POST", {
        title: "Bundle monthly digest",
        body: "Send an end-of-month recap email to the owner.",
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("Bundle monthly digest");
    expect(body.data.body).toBe("Send an end-of-month recap email to the owner.");
    expect(body.data.hiveId).toBe(id);
    expect(body.data.createdBy).toBe("owner");
    expect(body.data.status).toBe("open");
    expect(body.data.aiAssessment).toBeNull();
    expect(body.data.promotedToGoalId).toBeNull();
  });

  it("POST persists body=null when body is omitted", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req("http://t", "POST", { title: "no body" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.body).toBeNull();
  });

  it("POST rejects missing title with 400", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req("http://t", "POST", {}),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects empty title with 400", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req("http://t", "POST", { title: "   " }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 404 when hive does not exist", async () => {
    const fake = "00000000-0000-0000-0000-000000000000";
    const res = await IDEAS_POST(
      req("http://t", "POST", { title: "x" }),
      { params: Promise.resolve({ id: fake }) },
    );
    expect(res.status).toBe(404);
  });

  // Session-path attribution: a privileged caller can identify themselves as
  // an agent by setting `X-System-Role`. This is the seam the native EA
  // (Sprint 2) and daily-review agent (Sprint 3) will use. The body is NEVER
  // consulted for attribution.
  it("POST with X-System-Role='ea' records created_by='ea'", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req(
        "http://t",
        "POST",
        { title: "parked by EA" },
        { "X-System-Role": "ea" },
      ),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.createdBy).toBe("ea");
  });

  it("POST with X-System-Role='ideas-curator' records the role slug", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req(
        "http://t",
        "POST",
        { title: "auto-captured by curator" },
        { "X-System-Role": "ideas-curator" },
      ),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.createdBy).toBe("ideas-curator");
  });

  it("POST ignores body.createdBy — attribution is session-derived only", async () => {
    const id = await seedHive();
    // Even a privileged caller cannot override attribution via the body.
    // The body shape is { title, body? } — any extra keys are silently
    // ignored for POST (strict shape is enforced on PATCH).
    const res = await IDEAS_POST(
      req("http://t", "POST", {
        title: "body-attributed?",
        createdBy: "ideas-curator",
      } as unknown as { title: string }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // No X-System-Role header → privileged caller defaults to "owner",
    // regardless of what the body claims.
    expect(body.data.createdBy).toBe("owner");
  });

  it("POST rejects a malformed X-System-Role header with 400", async () => {
    const id = await seedHive();
    const res = await IDEAS_POST(
      req(
        "http://t",
        "POST",
        { title: "bad slug" },
        // Uppercase + space → fails the role-slug pattern.
        { "X-System-Role": "Owner Bot" },
      ),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);

    const rows = await sql`SELECT id FROM hive_ideas WHERE hive_id = ${id}`;
    expect(rows.length).toBe(0);
  });

  it("POST accepts multipart attachments and stores them against idea_id", async () => {
    const id = await seedHive();
    const fileBytes = Buffer.from("idea-image");
    const formData = new FormData();
    formData.append("title", "Pinned reference");
    formData.append("body", "Keep this around");
    formData.append("files", new File([fileBytes], "reference.png", { type: "image/png" }));

    const res = await IDEAS_POST(
      new Request(`http://t/api/hives/${id}/ideas`, { method: "POST", body: formData }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const attachments = await sql`
      SELECT task_id, goal_id, idea_id, filename, storage_path
      FROM task_attachments
      WHERE idea_id = ${body.data.id}
    `;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].task_id).toBeNull();
    expect(attachments[0].goal_id).toBeNull();
    expect(attachments[0].filename).toBe("reference.png");
    expect(fs.existsSync(attachments[0].storage_path as string)).toBe(true);
  });

  it("POST rolls back the idea row if attachment persistence fails", async () => {
    const id = await seedHive();
    const fileBytes = Buffer.from("idea-image");
    const formData = new FormData();
    formData.append("title", "Atomic create failure");
    formData.append("body", "should not persist");
    formData.append("files", new File([fileBytes], "reference.png", { type: "image/png" }));

    const persistSpy = vi
      .spyOn(attachmentPersist, "persistAttachmentsForParent")
      .mockRejectedValueOnce(new Error("disk full"));

    const res = await IDEAS_POST(
      new Request(`http://t/api/hives/${id}/ideas`, { method: "POST", body: formData }),
      { params: Promise.resolve({ id }) },
    );

    expect(res.status).toBe(500);
    const [ideaCount] = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
      FROM hive_ideas
      WHERE hive_id = ${id} AND title = 'Atomic create failure'
    `;
    expect(ideaCount.c).toBe(0);
    persistSpy.mockRestore();
  });

  it("GET defaults to status='open' only", async () => {
    const id = await seedHive();
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'O', 'owner', 'open')`;
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'R', 'owner', 'reviewed')`;
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'A', 'owner', 'archived')`;
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'P', 'owner', 'promoted')`;

    const res = await IDEAS_GET(
      req(`http://t/api/hives/${id}/ideas`, "GET"),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("O");
    expect(body.data[0].status).toBe("open");
  });

  it("GET with explicit ?status=archived returns only archived", async () => {
    const id = await seedHive();
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'O', 'owner', 'open')`;
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'A', 'owner', 'archived')`;

    const res = await IDEAS_GET(
      req(`http://t/api/hives/${id}/ideas?status=archived`, "GET"),
      { params: Promise.resolve({ id }) },
    );
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe("archived");
  });

  it("GET with explicit ?status=promoted returns only promoted", async () => {
    const id = await seedHive();
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'A', 'owner', 'open')`;
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status) VALUES (${id}, 'B', 'owner', 'promoted')`;

    const res = await IDEAS_GET(
      req(`http://t/api/hives/${id}/ideas?status=promoted`, "GET"),
      { params: Promise.resolve({ id }) },
    );
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].title).toBe("B");
  });

  it("GET rejects invalid status filter with 400", async () => {
    const id = await seedHive();
    const res = await IDEAS_GET(
      req(`http://t/api/hives/${id}/ideas?status=nope`, "GET"),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(400);
  });

  it("GET orders ideas newest-first by created_at", async () => {
    const id = await seedHive();
    // Explicit created_at so ordering is deterministic regardless of
    // insertion speed.
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status, created_at) VALUES (${id}, 'old', 'owner', 'open', '2026-01-01'::timestamp)`;
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by, status, created_at) VALUES (${id}, 'new', 'owner', 'open', '2026-04-01'::timestamp)`;

    const res = await IDEAS_GET(
      req("http://t", "GET"),
      { params: Promise.resolve({ id }) },
    );
    const body = await res.json();
    expect(body.data.map((r: { title: string }) => r.title)).toEqual(["new", "old"]);
  });

  it("PATCH updates title and body and bumps updated_at", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "orig", body: "orig body" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();
    const before = new Date(created.updatedAt).getTime();

    await new Promise((r) => setTimeout(r, 10));

    const res = await IDEA_PATCH(
      req("http://t", "PATCH", { title: "renamed", body: "new body" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("renamed");
    expect(body.data.body).toBe("new body");
    expect(new Date(body.data.updatedAt).getTime()).toBeGreaterThan(before);
  });

  it("PATCH accepts multipart attachments while updating title/body", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "orig", body: "orig body" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const fileBytes = Buffer.from("idea-pdf");
    const formData = new FormData();
    formData.append("title", "renamed");
    formData.append("body", "new body");
    formData.append("files", new File([fileBytes], "brief.pdf", { type: "application/pdf" }));

    const res = await IDEA_PATCH(
      new Request(`http://t/api/hives/${id}/ideas/${created.id}`, {
        method: "PATCH",
        body: formData,
      }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe("renamed");
    expect(body.data.body).toBe("new body");

    const attachments = await sql`
      SELECT task_id, goal_id, idea_id, filename, storage_path
      FROM task_attachments
      WHERE idea_id = ${created.id}
    `;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("brief.pdf");
    expect(attachments[0].task_id).toBeNull();
    expect(attachments[0].goal_id).toBeNull();
    expect(fs.existsSync(attachments[0].storage_path as string)).toBe(true);
  });

  it("PATCH rolls back field updates if attachment persistence fails", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "orig", body: "orig body" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const fileBytes = Buffer.from("idea-pdf");
    const formData = new FormData();
    formData.append("title", "should roll back");
    formData.append("body", "should stay orig");
    formData.append("files", new File([fileBytes], "brief.pdf", { type: "application/pdf" }));

    const persistSpy = vi
      .spyOn(attachmentPersist, "persistAttachmentsForParent")
      .mockRejectedValueOnce(new Error("disk full"));

    const res = await IDEA_PATCH(
      new Request(`http://t/api/hives/${id}/ideas/${created.id}`, {
        method: "PATCH",
        body: formData,
      }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );

    expect(res.status).toBe(500);
    const [row] = await sql<{ title: string; body: string | null }[]>`
      SELECT title, body
      FROM hive_ideas
      WHERE id = ${created.id}
    `;
    expect(row.title).toBe("orig");
    expect(row.body).toBe("orig body");
    persistSpy.mockRestore();
  });

  it("PATCH transitions status open → reviewed → promoted", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const r1 = await IDEA_PATCH(
      req("http://t", "PATCH", { status: "reviewed" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(r1.status).toBe(200);
    expect((await r1.json()).data.status).toBe("reviewed");

    const r2 = await IDEA_PATCH(
      req("http://t", "PATCH", { status: "promoted" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.status).toBe("promoted");
  });

  it("PATCH archived=true is shorthand for status='archived'", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const res = await IDEA_PATCH(
      req("http://t", "PATCH", { archived: true }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("archived");
  });

  it("PATCH rejects invalid status with 400", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const res = await IDEA_PATCH(
      req("http://t", "PATCH", { status: "bogus" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH rejects unknown fields with 400", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const res = await IDEA_PATCH(
      req("http://t", "PATCH", { reviewed_at: "2026-01-01T00:00:00Z" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH accepts promoted_to_goal_id with status=promoted for traceability", async () => {
    const id = await seedHive();
    // Seed a goal to link to — FK requires the row exist.
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description)
      VALUES (${id}, 'Bundle monthly digest', 'from idea') RETURNING id
    `;
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "Bundle monthly digest" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const res = await IDEA_PATCH(
      req("http://t", "PATCH", {
        status: "promoted",
        promoted_to_goal_id: goal.id,
      }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("promoted");
    expect(body.data.promotedToGoalId).toBe(goal.id);
  });

  it("PATCH rejects malformed promoted_to_goal_id with 400", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const res = await IDEA_PATCH(
      req("http://t", "PATCH", { promoted_to_goal_id: "not-a-uuid" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(400);
  });

  it("PATCH with X-System-Role='ideas-curator' can write ai_assessment", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    const res = await IDEA_PATCH(
      req(
        "http://t",
        "PATCH",
        {
          ai_assessment: "High fit for MRR target; promote.",
          status: "reviewed",
        },
        { "X-System-Role": "ideas-curator" },
      ),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.aiAssessment).toBe("High fit for MRR target; promote.");
    expect(body.data.status).toBe("reviewed");
  });

  it("PATCH rejects ai_assessment from dashboard owner (no system-role header) with 403", async () => {
    const id = await seedHive();
    const createRes = await IDEAS_POST(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    // The dashboard owner session is privileged but is NOT on the system
    // path — ai_assessment is a machine-only field.
    const res = await IDEA_PATCH(
      req("http://t", "PATCH", {
        ai_assessment: "owner trying to write",
      }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(403);

    const [row] = await sql<{ ai_assessment: string | null }[]>`
      SELECT ai_assessment FROM hive_ideas WHERE id = ${created.id}
    `;
    expect(row.ai_assessment).toBeNull();
  });

  it("PATCH returns 404 when idea belongs to a different hive", async () => {
    const id1 = await seedHive();
    const id2 = await seedHive();
    const [i] = await sql<{ id: string }[]>`
      INSERT INTO hive_ideas (hive_id, title, created_by) VALUES (${id2}, 'other', 'owner') RETURNING id
    `;
    const res = await IDEA_PATCH(
      req("http://t", "PATCH", { title: "x" }),
      { params: Promise.resolve({ id: id1, ideaId: i.id }) },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE hard-removes the idea", async () => {
    const id = await seedHive();
    const [i] = await sql<{ id: string }[]>`
      INSERT INTO hive_ideas (hive_id, title, created_by) VALUES (${id}, 'gone', 'owner') RETURNING id
    `;
    const res = await IDEA_DELETE(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id, ideaId: i.id }) },
    );
    expect(res.status).toBe(204);
    const [remaining] = await sql`SELECT id FROM hive_ideas WHERE id = ${i.id}`;
    expect(remaining).toBeUndefined();
  });

  it("DELETE returns 404 when idea belongs to a different hive", async () => {
    const id1 = await seedHive();
    const id2 = await seedHive();
    const [i] = await sql<{ id: string }[]>`
      INSERT INTO hive_ideas (hive_id, title, created_by) VALUES (${id2}, 'other', 'owner') RETURNING id
    `;
    const res = await IDEA_DELETE(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id: id1, ideaId: i.id }) },
    );
    expect(res.status).toBe(404);
    const [still] = await sql`SELECT id FROM hive_ideas WHERE id = ${i.id}`;
    expect(still).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// Section B: authorization — non-system-owner sessions must be gated by
// canAccessHive. This mirrors the hardening in src/app/api/work/route.ts
// (requireApiUser + canAccessHive). Pattern adapted from
// tests/api/api-auth-guards.test.ts.
// -----------------------------------------------------------------------------
const authState = vi.hoisted(() => ({ isSystemOwner: true, canAccess: true }));

vi.mock("@/app/api/_lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/_lib/auth")>();
  return {
    ...actual,
    requireApiUser: async () => ({
      user: {
        id: "test-user",
        email: "test@local",
        isSystemOwner: authState.isSystemOwner,
      },
    }),
  };
});

vi.mock("@/auth/users", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/auth/users")>();
  return {
    ...actual,
    canAccessHive: async () => authState.canAccess,
  };
});

// Imports resolved after mocks are registered.
import {
  GET as IDEAS_GET_M,
  POST as IDEAS_POST_M,
} from "@/app/api/hives/[id]/ideas/route";
import {
  PATCH as IDEA_PATCH_M,
  DELETE as IDEA_DELETE_M,
} from "@/app/api/hives/[id]/ideas/[ideaId]/route";

describe("/api/hives/[id]/ideas — authorization + ai_assessment gate", () => {
  beforeEach(async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    await truncateAll(sql);
  });

  it("created_by='system' when session is not a system owner", async () => {
    authState.isSystemOwner = false;
    authState.canAccess = true;

    const id = await seedHive();
    const res = await IDEAS_POST_M(
      req("http://t", "POST", { title: "ea-captured" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.createdBy).toBe("system");
  });

  it("non-system-owner cannot spoof created_by via X-System-Role header", async () => {
    // A hive member with access tries to attribute the idea to "owner",
    // "ea", or a role slug. The header is ignored for non-privileged
    // callers — attribution is forced to "system" so role authorship stays
    // trustworthy.
    authState.isSystemOwner = false;
    authState.canAccess = true;

    const id = await seedHive();
    for (const spoof of ["owner", "ea", "ideas-curator"]) {
      const res = await IDEAS_POST_M(
        req(
          "http://t",
          "POST",
          { title: `spoof-${spoof}` },
          { "X-System-Role": spoof },
        ),
        { params: Promise.resolve({ id }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.createdBy).toBe("system");
    }
  });

  it("non-system-owner cannot spoof created_by via body.createdBy", async () => {
    // The body is never consulted for attribution, even when the session
    // is non-privileged.
    authState.isSystemOwner = false;
    authState.canAccess = true;

    const id = await seedHive();
    const res = await IDEAS_POST_M(
      req("http://t", "POST", {
        title: "body-spoof",
        createdBy: "ideas-curator",
      } as unknown as { title: string }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.createdBy).toBe("system");
  });

  it("POST returns 403 when caller lacks hive access", async () => {
    authState.isSystemOwner = false;
    authState.canAccess = false;

    const id = await seedHive();
    const res = await IDEAS_POST_M(
      req("http://t", "POST", { title: "blocked" }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(403);

    const rows = await sql`SELECT id FROM hive_ideas WHERE hive_id = ${id}`;
    expect(rows.length).toBe(0);
  });

  it("GET returns 403 when caller lacks hive access", async () => {
    authState.isSystemOwner = false;
    authState.canAccess = false;

    const id = await seedHive();
    await sql`INSERT INTO hive_ideas (hive_id, title, created_by) VALUES (${id}, 'x', 'owner')`;

    const res = await IDEAS_GET_M(
      req(`http://t/api/hives/${id}/ideas`, "GET"),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(403);
  });

  it("PATCH returns 403 when caller lacks hive access", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    const id = await seedHive();
    const [i] = await sql<{ id: string }[]>`
      INSERT INTO hive_ideas (hive_id, title, created_by) VALUES (${id}, 't', 'owner') RETURNING id
    `;

    authState.isSystemOwner = false;
    authState.canAccess = false;

    const res = await IDEA_PATCH_M(
      req("http://t", "PATCH", { title: "blocked" }),
      { params: Promise.resolve({ id, ideaId: i.id }) },
    );
    expect(res.status).toBe(403);

    const [row] = await sql<{ title: string }[]>`SELECT title FROM hive_ideas WHERE id = ${i.id}`;
    expect(row.title).toBe("t");
  });

  it("DELETE returns 403 when caller lacks hive access", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    const id = await seedHive();
    const [i] = await sql<{ id: string }[]>`
      INSERT INTO hive_ideas (hive_id, title, created_by) VALUES (${id}, 't', 'owner') RETURNING id
    `;

    authState.isSystemOwner = false;
    authState.canAccess = false;

    const res = await IDEA_DELETE_M(
      req("http://t", "DELETE"),
      { params: Promise.resolve({ id, ideaId: i.id }) },
    );
    expect(res.status).toBe(403);

    const [row] = await sql`SELECT id FROM hive_ideas WHERE id = ${i.id}`;
    expect(row).toBeDefined();
  });

  it("PATCH rejects ai_assessment write from a non-system caller with 403", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    const id = await seedHive();
    const createRes = await IDEAS_POST_M(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    // Non-system caller with hive access attempting to write ai_assessment.
    authState.isSystemOwner = false;
    authState.canAccess = true;

    const res = await IDEA_PATCH_M(
      req(
        "http://t",
        "PATCH",
        { ai_assessment: "attempted owner write" },
        // Even with the header, a non-privileged caller is off the system
        // path (the header is only honored for system-owner sessions).
        { "X-System-Role": "ideas-curator" },
      ),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(403);

    const [row] = await sql<{ ai_assessment: string | null }[]>`
      SELECT ai_assessment FROM hive_ideas WHERE id = ${created.id}
    `;
    expect(row.ai_assessment).toBeNull();
  });

  it("PATCH allows ai_assessment write from system-owner WITH X-System-Role header", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    const id = await seedHive();
    const createRes = await IDEAS_POST_M(
      req(
        "http://t",
        "POST",
        { title: "t" },
        { "X-System-Role": "ideas-curator" },
      ),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();
    expect(created.createdBy).toBe("ideas-curator");

    const res = await IDEA_PATCH_M(
      req(
        "http://t",
        "PATCH",
        { ai_assessment: "Good fit; recommend promote." },
        { "X-System-Role": "ideas-curator" },
      ),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.aiAssessment).toBe("Good fit; recommend promote.");
  });

  it("PATCH rejects ai_assessment write from dashboard owner (no header) with 403", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    const id = await seedHive();
    const createRes = await IDEAS_POST_M(
      req("http://t", "POST", { title: "t" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    // Human owner on the dashboard is system-owner but is NOT on the
    // system path. ai_assessment must stay machine-only.
    const res = await IDEA_PATCH_M(
      req("http://t", "PATCH", { ai_assessment: "owner attempt" }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(res.status).toBe(403);

    const [row] = await sql<{ ai_assessment: string | null }[]>`
      SELECT ai_assessment FROM hive_ideas WHERE id = ${created.id}
    `;
    expect(row.ai_assessment).toBeNull();
  });

  it("PATCH allows owner-facing edits (title/body/status/archived) without header", async () => {
    authState.isSystemOwner = true;
    authState.canAccess = true;
    const id = await seedHive();
    const createRes = await IDEAS_POST_M(
      req("http://t", "POST", { title: "orig", body: "orig body" }),
      { params: Promise.resolve({ id }) },
    );
    const { data: created } = await createRes.json();

    // Owner (no header) updates every lifecycle field that isn't
    // ai_assessment. All should succeed.
    const r1 = await IDEA_PATCH_M(
      req("http://t", "PATCH", {
        title: "new title",
        body: "new body",
        status: "reviewed",
      }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.data.title).toBe("new title");
    expect(b1.data.body).toBe("new body");
    expect(b1.data.status).toBe("reviewed");

    const r2 = await IDEA_PATCH_M(
      req("http://t", "PATCH", { archived: true }),
      { params: Promise.resolve({ id, ideaId: created.id }) },
    );
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.status).toBe("archived");
  });
});
