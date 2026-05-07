/**
 * Capture Sessions API — Sprint 3 verification tests
 *
 * Covers: consent gating, session create, stop, cancel/delete,
 * raw-media rejection, and state-transition enforcement.
 *
 * Uses the same vi.mock pattern as other API tests in this directory.
 * The vitest environment is "node" so there is no DOM / browser API;
 * browser-side getDisplayMedia and MediaRecorder behaviours are covered
 * separately in the Playwright / manual verification notes at the bottom.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// ---- Auth mock ----
vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

// ---- DB mock ----
vi.mock("@/app/api/_lib/db", () => {
  const sql = vi.fn() as unknown as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<Record<string, unknown>[]>;
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  return { sql };
});

// ---- Hive access mocks ----
vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

vi.mock("@/skills/self-creation", () => ({
  proposeSkill: vi.fn(),
}));

vi.mock("@/audit/agent-events", () => ({
  AGENT_AUDIT_EVENTS: {
    captureStarted: "capture_started",
    captureStopped: "capture_stopped",
    captureCancelled: "capture_cancelled",
    captureUploaded: "capture_uploaded",
    redactionApplied: "redaction_applied",
    draftWorkflowCreated: "draft_workflow_created",
    draftWorkflowApproved: "draft_workflow_approved",
    draftWorkflowRejected: "draft_workflow_rejected",
    draftWorkflowDeleted: "draft_workflow_deleted",
    workflowActivated: "workflow_activated",
  },
  recordAgentAuditEventBestEffort: vi.fn(),
}));

import { POST as createSession, GET as listSessions } from "@/app/api/capture-sessions/route";
import {
  GET as getSession,
  PATCH as patchSession,
  DELETE as deleteSession,
} from "@/app/api/capture-sessions/[id]/route";
import {
  DELETE as rejectDraftPreview,
  GET as getDraftPreview,
  POST as createDraftFromSession,
} from "@/app/api/capture-sessions/[id]/draft/route";
import { requireApiUser } from "@/app/api/_lib/auth";
import { sql } from "@/app/api/_lib/db";
import { canMutateHive, canAccessHive } from "@/auth/users";
import { proposeSkill } from "@/skills/self-creation";
import { recordAgentAuditEventBestEffort } from "@/audit/agent-events";

const mockRequireApiUser = vi.mocked(requireApiUser);
const mockSql = vi.mocked(sql) as unknown as Mock;
const mockCanMutateHive = vi.mocked(canMutateHive);
const mockCanAccessHive = vi.mocked(canAccessHive);
const mockProposeSkill = vi.mocked(proposeSkill);
const mockRecordAudit = vi.mocked(recordAgentAuditEventBestEffort);

const testUser = {
  id: "user-test",
  email: "test@local",
  isSystemOwner: true,
};

const hiveId = "hive-111";

const baseSessionRow = {
  id: "session-abc",
  hive_id: hiveId,
  owner_user_id: testUser.id,
  owner_email: testUser.email,
  status: "recording",
  consented_at: new Date().toISOString(),
  started_at: new Date().toISOString(),
  stopped_at: null,
  cancelled_at: null,
  deleted_at: null,
  capture_scope: { type: "browser_tab" },
  metadata: {},
  evidence_summary: null,
  redacted_summary: null,
  work_product_refs: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const draftRow = {
  id: "draft-123",
  hiveId,
  roleSlug: "dev-agent",
  targetRoleSlugs: ["dev-agent"],
  sourceTaskId: null,
  originatingTaskId: null,
  originatingFeedbackId: null,
  slug: "capture-session-abc",
  content: "# Draft Workflow From Capture Session",
  scope: "hive",
  sourceType: "internal" as const,
  provenanceUrl: null,
  internalSourceRef: "capture-session:session-abc",
  licenseNotes: null,
  securityReviewStatus: "not_required" as const,
  qaReviewStatus: "pending" as const,
  evidence: [],
  status: "pending" as const,
  feedback: null,
  approvedBy: null,
  approvedAt: null,
  publishedBy: null,
  publishedAt: null,
  archivedBy: null,
  archivedAt: null,
  archiveReason: null,
  adoptionEvidence: [],
  createdAt: new Date("2026-05-01T01:02:00.000Z"),
  updatedAt: new Date("2026-05-01T01:02:00.000Z"),
};

function makeRequest(
  method: string,
  url: string,
  body?: unknown,
): Request {
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    bodyStr = JSON.stringify(body);
  }
  return new Request(url, { method, headers, body: bodyStr });
}

function authAsOwner() {
  mockRequireApiUser.mockResolvedValue({ user: testUser });
  mockCanMutateHive.mockResolvedValue(true);
  mockCanAccessHive.mockResolvedValue(true);
}

function authAsHiveMember() {
  mockRequireApiUser.mockResolvedValue({
    user: { ...testUser, isSystemOwner: false },
  });
  mockCanMutateHive.mockResolvedValue(true);
  mockCanAccessHive.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockRequireApiUser.mockReset();
  mockCanMutateHive.mockReset();
  mockCanAccessHive.mockReset();
  mockProposeSkill.mockReset();
  mockRecordAudit.mockReset();
});

// ---------------------------------------------------------------------------
// POST /api/capture-sessions — consent gating and session creation
// ---------------------------------------------------------------------------
describe("POST /api/capture-sessions", () => {
  it("rejects when consent is not true", async () => {
    authAsOwner();
    // sql is not called before the consent check
    mockSql.mockResolvedValue([{ id: hiveId }]);

    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId,
      consent: false,
    });
    const res = await createSession(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/consent=true/i);
  });

  it("rejects when consent is missing", async () => {
    authAsOwner();
    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId,
    });
    const res = await createSession(req);
    expect(res.status).toBe(400);
  });

  it("creates a session with consent=true and status=recording", async () => {
    authAsOwner();
    // First sql call checks the hive exists; second is the INSERT
    mockSql
      .mockResolvedValueOnce([{ id: hiveId }])
      .mockResolvedValueOnce([baseSessionRow]);

    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId,
      consent: true,
      status: "recording",
      captureScope: { type: "browser_tab" },
    });
    const res = await createSession(req);
    expect(res.status).toBe(201);
    const body = await res.json() as { data: typeof baseSessionRow };
    expect(body.data.id).toBe("session-abc");
    expect(body.data.status).toBe("recording");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "capture_started",
        actor: expect.objectContaining({
          id: testUser.id,
          label: testUser.email,
          type: "owner",
        }),
        hiveId,
        targetType: "capture_session",
        targetId: "session-abc",
        outcome: "success",
        metadata: expect.objectContaining({
          captureSessionId: "session-abc",
          previousStatus: null,
          nextStatus: "recording",
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
  });

  it("emits redaction_applied when capture metadata carries redaction signals", async () => {
    authAsOwner();
    const redactedRow = {
      ...baseSessionRow,
      metadata: {
        redactionNotes: ["API key replaced with placeholder"],
        sensitiveDataWarnings: ["credential-like token detected"],
      },
      redacted_summary: "Opened settings and used [REDACTED].",
    };
    mockSql
      .mockResolvedValueOnce([{ id: hiveId }])
      .mockResolvedValueOnce([redactedRow]);

    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId,
      consent: true,
      status: "recording",
      metadata: redactedRow.metadata,
      redactedSummary: redactedRow.redacted_summary,
    });
    const res = await createSession(req);
    expect(res.status).toBe(201);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "redaction_applied",
        hiveId,
        targetId: "session-abc",
        metadata: expect.objectContaining({
          sensitiveWarningCount: 1,
          redactionNoteCount: 1,
          redactionApplied: true,
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
  });

  it("rejects raw media fields (video)", async () => {
    authAsOwner();
    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId,
      consent: true,
      video: "base64-blob-here",
    });
    const res = await createSession(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/raw media/i);
  });

  it("rejects raw media fields nested in metadata", async () => {
    authAsOwner();
    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId,
      consent: true,
      metadata: { frames: ["frame1", "frame2"] },
    });
    const res = await createSession(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/raw media/i);
  });

  it("rejects multipart/form-data content type", async () => {
    authAsOwner();
    const req = new Request("http://test/api/capture-sessions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=abc" },
      body: "--abc\r\n\r\n\r\n--abc--",
    });
    const res = await createSession(req);
    expect(res.status).toBe(415);
  });

  it("rejects missing hiveId", async () => {
    authAsOwner();
    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      consent: true,
    });
    const res = await createSession(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/hiveId/i);
  });

  it("returns 404 when hive does not exist", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([]); // hive lookup returns empty

    const req = makeRequest("POST", "http://test/api/capture-sessions", {
      hiveId: "nonexistent-hive",
      consent: true,
    });
    const res = await createSession(req);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/capture-sessions/[id] — stop and cancel transitions
// ---------------------------------------------------------------------------
describe("PATCH /api/capture-sessions/[id]", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("transitions recording → stopped (Stop action)", async () => {
    authAsOwner();
    const stoppedRow = { ...baseSessionRow, status: "stopped", stopped_at: new Date().toISOString() };
    mockSql
      .mockResolvedValueOnce([baseSessionRow]) // loadSession
      .mockResolvedValueOnce([stoppedRow]);     // UPDATE

    const req = makeRequest("PATCH", `http://test/api/capture-sessions/${baseSessionRow.id}`, {
      status: "stopped",
    });
    const res = await patchSession(req, makeParams(baseSessionRow.id));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string } };
    expect(body.data.status).toBe("stopped");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "capture_stopped",
        hiveId,
        targetId: "session-abc",
        metadata: expect.objectContaining({
          previousStatus: "recording",
          nextStatus: "stopped",
          occurredAt: expect.any(String),
        }),
      }),
    );
  });

  it("transitions recording → cancelled (Cancel action)", async () => {
    authAsOwner();
    const cancelledRow = { ...baseSessionRow, status: "cancelled", cancelled_at: new Date().toISOString() };
    mockSql
      .mockResolvedValueOnce([baseSessionRow])
      .mockResolvedValueOnce([cancelledRow]);

    const req = makeRequest("PATCH", `http://test/api/capture-sessions/${baseSessionRow.id}`, {
      status: "cancelled",
    });
    const res = await patchSession(req, makeParams(baseSessionRow.id));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string } };
    expect(body.data.status).toBe("cancelled");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "capture_cancelled",
        hiveId,
        targetId: "session-abc",
        metadata: expect.objectContaining({
          previousStatus: "recording",
          nextStatus: "cancelled",
          occurredAt: expect.any(String),
        }),
      }),
    );
  });

  it("rejects an invalid state transition (stopped → recording)", async () => {
    authAsOwner();
    const stoppedRow = { ...baseSessionRow, status: "stopped" };
    mockSql.mockResolvedValueOnce([stoppedRow]);

    const req = makeRequest("PATCH", `http://test/api/capture-sessions/${baseSessionRow.id}`, {
      status: "recording",
    });
    const res = await patchSession(req, makeParams(baseSessionRow.id));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/invalid.*transition/i);
  });

  it("rejects raw media fields in PATCH body", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([baseSessionRow]);

    const req = makeRequest("PATCH", `http://test/api/capture-sessions/${baseSessionRow.id}`, {
      status: "stopped",
      screenshots: ["img1"],
    });
    const res = await patchSession(req, makeParams(baseSessionRow.id));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/raw media/i);
  });

  it("returns 404 for unknown session id", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([]);

    const req = makeRequest("PATCH", "http://test/api/capture-sessions/ghost-id", {
      status: "stopped",
    });
    const res = await patchSession(req, makeParams("ghost-id"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/capture-sessions/[id] — hard purge
// ---------------------------------------------------------------------------
describe("DELETE /api/capture-sessions/[id]", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("hard-purges the session row and returns purged: true", async () => {
    authAsOwner();
    mockSql
      .mockResolvedValueOnce([baseSessionRow]) // loadSession
      .mockResolvedValueOnce([]);              // DELETE

    const req = new Request(
      `http://test/api/capture-sessions/${baseSessionRow.id}`,
      { method: "DELETE" },
    );
    const res = await deleteSession(req, makeParams(baseSessionRow.id));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; purged: boolean } };
    expect(body.data.purged).toBe(true);
    expect(body.data.id).toBe(baseSessionRow.id);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "draft_workflow_deleted",
        hiveId,
        targetType: "capture_session",
        targetId: "session-abc",
        metadata: expect.objectContaining({
          deletedDerivedCaptureSessionMetadata: true,
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
  });

  it("returns 404 for unknown session id", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([]);

    const req = new Request("http://test/api/capture-sessions/ghost-id", {
      method: "DELETE",
    });
    const res = await deleteSession(req, makeParams("ghost-id"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/capture-sessions/[id] — review page session load
// ---------------------------------------------------------------------------
describe("GET /api/capture-sessions/[id]", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it("returns session data for review page load", async () => {
    authAsOwner();
    const stoppedRow = { ...baseSessionRow, status: "stopped" };
    mockSql.mockResolvedValueOnce([stoppedRow]);

    const req = new Request(
      `http://test/api/capture-sessions/${baseSessionRow.id}`,
    );
    const res = await getSession(req, makeParams(baseSessionRow.id));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; status: string } };
    expect(body.data.id).toBe("session-abc");
    expect(body.data.status).toBe("stopped");
  });

  it("returns 404 for unknown session", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([]);

    const req = new Request("http://test/api/capture-sessions/ghost");
    const res = await getSession(req, makeParams("ghost"));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /api/capture-sessions/[id]/draft — reviewed capture to inactive draft
// ---------------------------------------------------------------------------
describe("/api/capture-sessions/[id]/draft", () => {
  function makeParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  function draftRequest() {
    return new Request(
      `http://test/api/capture-sessions/${baseSessionRow.id}/draft`,
      { method: "POST" },
    );
  }

  const stoppedSessionRow = {
    ...baseSessionRow,
    status: "stopped",
    stopped_at: "2026-05-01T01:01:30.000Z",
  };

  it("generates and stores a structured draft preview from metadata-only capture data", async () => {
    authAsOwner();
    const reviewReadyRow = {
      ...baseSessionRow,
      status: "review_ready",
      metadata: {
        title: "Invoice follow up",
        observedSteps: ["Open CRM", "Find overdue invoice"],
        inferredInputs: ["Customer account", "Invoice ID"],
        decisionNotes: ["Escalate if account is marked high risk"],
        sensitiveDataWarnings: ["Customer data may be visible"],
      },
      evidence_summary: { redactionNotes: ["Customer names redacted"] },
      redacted_summary: "Opened settings and captured workflow steps.",
    };
    mockSql
      .mockResolvedValueOnce([reviewReadyRow])
      .mockResolvedValueOnce([]);

    const res = await getDraftPreview(
      new Request(`http://test/api/capture-sessions/${baseSessionRow.id}/draft`),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        preview: {
          observedSteps: string[];
          inferredInputs: string[];
          decisionNotes: string[];
          sensitiveDataWarnings: string[];
          redactionNotes: string[];
          suggestedSkillContent: string;
          source: { rawMediaAccepted: boolean; fieldsUsed: string[] };
        };
        previewStatus: string;
        rawMediaAccepted: boolean;
      };
    };
    expect(body.data.previewStatus).toBe("generated");
    expect(body.data.rawMediaAccepted).toBe(false);
    expect(body.data.preview.observedSteps).toContain("Open CRM");
    expect(body.data.preview.inferredInputs).toContain("Invoice ID");
    expect(body.data.preview.decisionNotes.join(" ")).toContain("Opened settings");
    expect(body.data.preview.sensitiveDataWarnings).toContain("Customer data may be visible");
    expect(body.data.preview.redactionNotes).toContain("Customer names redacted");
    expect(body.data.preview.suggestedSkillContent).toContain("## Observed steps");
    expect(body.data.preview.source.rawMediaAccepted).toBe(false);
    expect(body.data.preview.source.fieldsUsed).toEqual([
      "metadata",
      "evidenceSummary",
      "redactedSummary",
      "captureScope",
    ]);
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("creates a pending inactive skill draft from metadata-only capture data", async () => {
    authAsOwner();
    const reviewReadyRow = {
      ...baseSessionRow,
      status: "review_ready",
      stopped_at: "2026-05-01T01:01:30.000Z",
      metadata: {
        title: "Invoice follow up",
        observedSteps: ["Open CRM", "Find overdue invoice", "Send follow-up email"],
        inferredInputs: ["Customer account", "Invoice ID"],
        decisionNotes: ["Escalate if account is marked high risk"],
      },
      evidence_summary: { redactionNotes: ["Customer names redacted"] },
      redacted_summary: "Opened settings and captured workflow steps.",
    };
    mockSql
      .mockResolvedValueOnce([reviewReadyRow])
      .mockResolvedValueOnce([]);
    mockProposeSkill.mockResolvedValueOnce(draftRow);

    const res = await createDraftFromSession(
      new Request(`http://test/api/capture-sessions/${baseSessionRow.id}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewNotes: "Owner approved edited draft.",
          suggestedSkillContent: "# Edited Invoice Follow Up\n\n## Observed steps\n\n- Edited step",
        }),
      }),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(201);
    const body = await res.json() as {
      data: {
        draft: { id: string; status: string; publishedAt: string | null };
        created: boolean;
        duplicate: boolean;
        message: string;
      };
    };
    expect(body.data.draft.id).toBe("draft-123");
    expect(body.data.draft.status).toBe("pending");
    expect(body.data.draft.publishedAt).toBeNull();
    expect(body.data.created).toBe(true);
    expect(body.data.duplicate).toBe(false);
    expect(body.data.message).toMatch(/inactive pending draft/i);
    expect(mockProposeSkill).toHaveBeenCalledOnce();
    const input = mockProposeSkill.mock.calls[0]?.[1] as {
      hiveId: string;
      internalSourceRef: string;
      content: string;
      provenanceUrl: string;
      evidence: { source?: string; summary: string }[];
      qaReviewStatus: string;
      securityReviewStatus: string;
      sourceType: string;
    };
    expect(input.hiveId).toBe(hiveId);
    expect(input.internalSourceRef).toBe("capture-session:session-abc");
    expect(input.provenanceUrl).toBe("/setup/workflow-capture/session-abc/review");
    expect(input.sourceType).toBe("internal");
    expect(input.content).toContain("Status: inactive pending draft.");
    expect(input.content).toContain("Capture session ID: session-abc");
    expect(input.content).toContain("Review route: /setup/workflow-capture/session-abc/review");
    expect(input.content).toContain("# Edited Invoice Follow Up");
    expect(input.content).toContain("Owner approved edited draft.");
    expect(input.content).not.toMatch(/videoBlob|screenshots":|frames":/i);
    expect(input.evidence[0]?.source).toBe("capture-session:session-abc");
    expect(input.evidence[0]?.summary).toContain(
      "Review route: /setup/workflow-capture/session-abc/review",
    );
    expect(input.evidence[0]?.summary).toContain("Raw media accepted: false");
    expect(input.qaReviewStatus).toBe("pending");
    expect(input.securityReviewStatus).toBe("not_required");
    expect(mockSql).toHaveBeenCalledTimes(3);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "draft_workflow_created",
        actor: expect.objectContaining({
          id: testUser.id,
          label: testUser.email,
          type: "owner",
        }),
        hiveId,
        targetType: "skill_draft",
        targetId: "draft-123",
        metadata: expect.objectContaining({
          captureSessionId: "session-abc",
          skillDraftId: "draft-123",
          draftStatus: "pending",
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "draft_workflow_approved",
        actor: expect.objectContaining({
          id: testUser.id,
          label: testUser.email,
          type: "owner",
        }),
        hiveId,
        targetType: "skill_draft",
        targetId: "draft-123",
        metadata: expect.objectContaining({
          captureSessionId: "session-abc",
          skillDraftId: "draft-123",
          workflowDraftId: "draft-123",
          workflowSourceRef: "capture-session:session-abc",
          draftStatus: "pending",
          activationStatus: "inactive",
          sourceType: "capture_session_metadata",
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
    expect(mockRecordAudit).not.toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({ eventType: "workflow_activated" }),
    );
  });

  it("returns 404 for a missing capture session", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([]);

    const res = await createDraftFromSession(
      new Request("http://test/api/capture-sessions/ghost/draft", {
        method: "POST",
      }),
      makeParams("ghost"),
    );

    expect(res.status).toBe(404);
    expect(mockProposeSkill).not.toHaveBeenCalled();
  });

  it("returns 404 for a deleted capture session", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([{ ...baseSessionRow, status: "deleted" }]);

    const res = await createDraftFromSession(
      draftRequest(),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(404);
    expect(mockProposeSkill).not.toHaveBeenCalled();
  });

  it("rejects a caller without mutate access to the capture hive", async () => {
    authAsHiveMember();
    mockCanMutateHive.mockResolvedValueOnce(false);
    mockSql.mockResolvedValueOnce([stoppedSessionRow]);

    const res = await createDraftFromSession(
      draftRequest(),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(403);
    expect(mockProposeSkill).not.toHaveBeenCalled();
  });

  it("returns an existing pending draft for duplicate create requests", async () => {
    authAsOwner();
    mockSql
      .mockResolvedValueOnce([stoppedSessionRow])
      .mockResolvedValueOnce([{ ...draftRow, id: "draft-existing" }])
      .mockResolvedValueOnce([]);

    const res = await createDraftFromSession(
      draftRequest(),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { draft: { id: string; status: string }; created: boolean; duplicate: boolean };
    };
    expect(body.data.draft.id).toBe("draft-existing");
    expect(body.data.draft.status).toBe("pending");
    expect(body.data.created).toBe(false);
    expect(body.data.duplicate).toBe(true);
    expect(mockProposeSkill).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it("returns 409 when the pending skill draft cap blocks a new draft", async () => {
    authAsOwner();
    mockSql
      .mockResolvedValueOnce([stoppedSessionRow])
      .mockResolvedValueOnce([]);
    mockProposeSkill.mockRejectedValueOnce(
      new Error("Cannot propose skill: 5 pending skill drafts already exist (cap is 5)."),
    );

    const res = await createDraftFromSession(
      draftRequest(),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/pending skill drafts/i);
  });

  it("rejects raw-media-shaped create payloads before creating a draft", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([stoppedSessionRow]);

    const res = await createDraftFromSession(
      new Request(`http://test/api/capture-sessions/${baseSessionRow.id}/draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewNotes: "looks ready", screenshot: "raw-frame" }),
      }),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(400);
    expect(mockProposeSkill).not.toHaveBeenCalled();
  });

  it("rejects raw-media-shaped stored metadata and does not create or activate anything", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([
      { ...stoppedSessionRow, evidence_summary: { screenshots: ["raw-frame"] } },
    ]);

    const res = await createDraftFromSession(
      draftRequest(),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(400);
    expect(mockProposeSkill).not.toHaveBeenCalled();
  });

  it("rejects/deletes the generated preview metadata without creating a skill draft", async () => {
    authAsOwner();
    mockSql
      .mockResolvedValueOnce([stoppedSessionRow])
      .mockResolvedValueOnce([]);

    const res = await rejectDraftPreview(
      new Request(`http://test/api/capture-sessions/${baseSessionRow.id}/draft`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Needs more owner context" }),
      }),
      makeParams(baseSessionRow.id),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { previewStatus: string; rejected: boolean } };
    expect(body.data.previewStatus).toBe("rejected");
    expect(body.data.rejected).toBe(true);
    expect(mockProposeSkill).not.toHaveBeenCalled();
    expect(mockRecordAudit).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        eventType: "draft_workflow_rejected",
        actor: expect.objectContaining({
          id: testUser.id,
          label: testUser.email,
          type: "owner",
        }),
        hiveId,
        targetType: "capture_draft_preview",
        targetId: "session-abc",
        metadata: expect.objectContaining({
          captureSessionId: "session-abc",
          draftPreviewId: "session-abc",
          workflowSourceRef: "capture-session:session-abc",
          previewStatus: "rejected",
          rejectionReason: "provided",
          sourceType: "capture_session_metadata",
          rawMediaPresent: false,
          occurredAt: expect.any(String),
        }),
      }),
    );
  });

});

// ---------------------------------------------------------------------------
// GET /api/capture-sessions — list
// ---------------------------------------------------------------------------
describe("GET /api/capture-sessions", () => {
  it("requires hiveId query parameter", async () => {
    authAsOwner();
    const req = new Request("http://test/api/capture-sessions");
    const res = await listSessions(req);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/hiveId/i);
  });

  it("returns session list for a hive", async () => {
    authAsOwner();
    mockSql.mockResolvedValueOnce([baseSessionRow]);

    const req = new Request(
      `http://test/api/capture-sessions?hiveId=${hiveId}`,
    );
    const res = await listSessions(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string }[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0]?.id).toBe("session-abc");
  });

  it("rejects an invalid status filter", async () => {
    authAsOwner();
    const req = new Request(
      `http://test/api/capture-sessions?hiveId=${hiveId}&status=bogus`,
    );
    const res = await listSessions(req);
    expect(res.status).toBe(400);
  });
});

/*
 * ---------------------------------------------------------------------------
 * Manual / Playwright verification notes (browser API cannot be automated
 * in the vitest node environment)
 * ---------------------------------------------------------------------------
 *
 * 1. CONSENT GATING
 *    Navigate to /setup/workflow-capture. Click "Start browser capture".
 *    Verify: consent dialog appears; "Start Recording" button is disabled.
 *    Check the checkbox. Verify: button becomes enabled.
 *    Click Cancel. Verify: dialog closes, no getDisplayMedia prompt appears.
 *    DevTools Network: no POST /api/capture-sessions before consent confirmed.
 *
 * 2. SESSION CREATE
 *    Confirm consent, select a tab in the browser picker.
 *    DevTools Network: POST /api/capture-sessions with body
 *      { hiveId, consent: true, status: "recording", captureScope: { type: "browser_tab" } }.
 *    Verify: response 201, no video/audio/blob fields in request body.
 *
 * 3. RECORDING PILL
 *    After capture starts, verify the top-right pill is visible with:
 *    - pulsing red dot
 *    - MM:SS counter incrementing every second
 *    - "Stop" and "Cancel" buttons
 *
 * 4. STOP
 *    Click Stop. Verify:
 *    - PATCH /api/capture-sessions/<id> with { status: "stopped" } (no blob fields).
 *    - Navigation to /setup/workflow-capture/<id>/review.
 *    - Review page loads session metadata; analysis section marked "pending future work".
 *
 * 5. CANCEL
 *    Start a new session. Click Cancel.
 *    Verify: confirm dialog appears with "Discard this recording? Nothing will be saved."
 *    Confirm. Verify:
 *    - DELETE /api/capture-sessions/<id> is sent.
 *    - Pill disappears; page returns to idle state.
 *    - No raw media payload in any request.
 *
 * 6. RAW-MEDIA NON-UPLOAD
 *    Throughout all above flows, verify in DevTools Network that NO request
 *    contains video, audio, frames, screenshots, blob, or binary data.
 *    The MediaRecorder chunks remain in browser memory only.
 *
 * 7. ERROR STATES
 *    Permission denied: dismiss browser picker. Verify error banner shows
 *      "Screen capture permission was denied."
 *    Unsupported browser: open in Safari (pre-17). Verify warning banner before capture starts.
 *    Session create failure: mock API to return 500. Verify error banner.
 *    Source ended: close the captured tab. Verify pill transitions to "Stopping…"
 *      then navigates to review.
 */
