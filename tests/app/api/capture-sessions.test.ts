import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import {
  GET as LIST_CAPTURE_SESSIONS,
  POST as CREATE_CAPTURE_SESSION,
} from "@/app/api/capture-sessions/route";
import {
  DELETE as DELETE_CAPTURE_SESSION,
  GET as READ_CAPTURE_SESSION,
  PATCH as UPDATE_CAPTURE_SESSION,
} from "@/app/api/capture-sessions/[id]/route";
import { POST as CREATE_CAPTURE_DRAFT } from "@/app/api/capture-sessions/[id]/draft/route";

async function seedHive(): Promise<string> {
  const slug = "capture-" + Math.random().toString(36).slice(2, 10);
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type)
    VALUES ('Capture Hive', ${slug}, 'digital')
    RETURNING id
  `;
  return hive.id;
}

function jsonRequest(url: string, method: string, body: Record<string, unknown>) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("/api/capture-sessions metadata-only API", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("creates, lists, reads, updates, and purges a consented metadata-only capture session", async () => {
    const hiveId = await seedHive();

    const createRes = await CREATE_CAPTURE_SESSION(
      jsonRequest("http://t/api/capture-sessions", "POST", {
        hiveId,
        consent: true,
        status: "draft",
        captureScope: { kind: "browser-tab", audio: false },
        metadata: { source: "api-smoke", durationLimitSeconds: 300 },
        evidenceSummary: { notes: "metadata only; no raw video" },
        redactedSummary: "Owner will review extracted workflow metadata later.",
        workProductRefs: [],
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const sessionId = created.data.id;
    expect(created.data.hiveId).toBe(hiveId);
    expect(created.data.status).toBe("draft");
    expect(created.data.ownerUserId).toBe("test-user");
    expect(created.data.metadata).toEqual({
      source: "api-smoke",
      durationLimitSeconds: 300,
    });

    const listRes = await LIST_CAPTURE_SESSIONS(
      new Request(`http://t/api/capture-sessions?hiveId=${hiveId}`),
    );
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].id).toBe(sessionId);

    const readRes = await READ_CAPTURE_SESSION(
      new Request(`http://t/api/capture-sessions/${sessionId}`),
      params(sessionId),
    );
    expect(readRes.status).toBe(200);
    const read = await readRes.json();
    expect(read.data.evidenceSummary).toEqual({
      notes: "metadata only; no raw video",
    });

    const recordingRes = await UPDATE_CAPTURE_SESSION(
      jsonRequest(`http://t/api/capture-sessions/${sessionId}`, "PATCH", {
        status: "recording",
      }),
      params(sessionId),
    );
    expect(recordingRes.status).toBe(200);
    const recording = await recordingRes.json();
    expect(recording.data.status).toBe("recording");
    expect(recording.data.startedAt).not.toBeNull();

    const stoppedRes = await UPDATE_CAPTURE_SESSION(
      jsonRequest(`http://t/api/capture-sessions/${sessionId}`, "PATCH", {
        status: "stopped",
        metadata: { source: "api-smoke", durationSeconds: 42 },
      }),
      params(sessionId),
    );
    expect(stoppedRes.status).toBe(200);
    const stopped = await stoppedRes.json();
    expect(stopped.data.status).toBe("stopped");
    expect(stopped.data.stoppedAt).not.toBeNull();
    expect(stopped.data.metadata).toEqual({
      source: "api-smoke",
      durationSeconds: 42,
    });

    const readyRes = await UPDATE_CAPTURE_SESSION(
      jsonRequest(`http://t/api/capture-sessions/${sessionId}`, "PATCH", {
        status: "review_ready",
        evidenceSummary: {
          redactedSteps: ["Open dashboard", "Filter tasks", "Review result"],
        },
        workProductRefs: ["work-product-placeholder"],
      }),
      params(sessionId),
    );
    expect(readyRes.status).toBe(200);
    const ready = await readyRes.json();
    expect(ready.data.status).toBe("review_ready");
    expect(ready.data.workProductRefs).toEqual(["work-product-placeholder"]);

    const deleteRes = await DELETE_CAPTURE_SESSION(
      new Request(`http://t/api/capture-sessions/${sessionId}`, { method: "DELETE" }),
      params(sessionId),
    );
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toEqual({ data: { id: sessionId, purged: true } });

    const rows = await sql`SELECT id FROM capture_sessions WHERE id = ${sessionId}`;
    expect(rows).toHaveLength(0);
  });

  it("rejects missing consent and invalid lifecycle transitions", async () => {
    const hiveId = await seedHive();

    const noConsent = await CREATE_CAPTURE_SESSION(
      jsonRequest("http://t/api/capture-sessions", "POST", { hiveId }),
    );
    expect(noConsent.status).toBe(400);
    expect((await noConsent.json()).error).toContain("consent=true");

    const createRes = await CREATE_CAPTURE_SESSION(
      jsonRequest("http://t/api/capture-sessions", "POST", {
        hiveId,
        consent: true,
      }),
    );
    const created = await createRes.json();

    const invalidTransition = await UPDATE_CAPTURE_SESSION(
      jsonRequest(`http://t/api/capture-sessions/${created.data.id}`, "PATCH", {
        status: "review_ready",
      }),
      params(created.data.id),
    );
    expect(invalidTransition.status).toBe(400);
    expect((await invalidTransition.json()).error).toContain("draft -> review_ready");
  });

  it("rejects raw media fields and multipart uploads for the metadata-only MVP", async () => {
    const hiveId = await seedHive();

    const rawVideo = await CREATE_CAPTURE_SESSION(
      jsonRequest("http://t/api/capture-sessions", "POST", {
        hiveId,
        consent: true,
        metadata: {
          rawVideoBytes: "base64-video-would-be-here",
        },
      }),
    );
    expect(rawVideo.status).toBe(400);
    expect((await rawVideo.json()).error).toContain("raw media field");

    const formData = new FormData();
    formData.append("hiveId", hiveId);
    formData.append("consent", "true");
    formData.append("file", new File(["fake"], "capture.webm", { type: "video/webm" }));
    const multipart = await CREATE_CAPTURE_SESSION(
      new Request("http://t/api/capture-sessions", {
        method: "POST",
        body: formData,
      }),
    );
    expect(multipart.status).toBe(415);
    expect((await multipart.json()).error).toContain("metadata-only");

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'capture_sessions'
      ORDER BY ordinal_position
    `;
    expect(columns.map((column) => column.column_name)).not.toEqual(
      expect.arrayContaining([
        "video",
        "raw_video",
        "video_bytes",
        "raw_video_bytes",
        "media_bytes",
        "storage_path",
      ]),
    );
  });

  it("records draft creation UX actions in the canonical action log without sensitive payloads", async () => {
    const hiveId = await seedHive();

    const createRes = await CREATE_CAPTURE_SESSION(
      jsonRequest("http://t/api/capture-sessions", "POST", {
        hiveId,
        consent: true,
        status: "draft",
        metadata: {
          title: "Sensitive onboarding workflow",
          observedSteps: ["Open dashboard", "Paste API key sk-live-secret"],
          sensitiveDataWarnings: ["API key was redacted"],
          redactionNotes: ["Credential-like input replaced with placeholder"],
        },
        evidenceSummary: {
          decisionNotes: ["Use the redacted workspace only"],
        },
        redactedSummary: "Owner pasted [REDACTED] into the form.",
        workProductRefs: [],
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const sessionId = created.data.id as string;

    const draftRes = await CREATE_CAPTURE_DRAFT(
      jsonRequest(`http://t/api/capture-sessions/${sessionId}/draft`, "POST", {
        reviewNotes: "Reviewed with a secret-like value sk-live-secret that must not be logged.",
      }),
      params(sessionId),
    );
    expect(draftRes.status).toBe(201);
    const approved = await draftRes.json();
    const draftId = approved.data.draft.id as string;

    const events = await sql<{
      event_type: string;
      target_type: string;
      target_id: string | null;
      metadata: Record<string, unknown>;
    }[]>`
      SELECT event_type, target_type, target_id, metadata
      FROM agent_audit_events
      WHERE hive_id = ${hiveId}
      ORDER BY created_at ASC
    `;

    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        "redaction_applied",
        "draft_workflow_created",
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "draft_workflow_created",
          target_type: "skill_draft",
          target_id: draftId,
        }),
      ]),
    );

    const createEvent = events.find((event) => event.event_type === "draft_workflow_created");
    expect(createEvent?.metadata).toMatchObject({
      captureSessionId: sessionId,
      skillDraftId: draftId,
      draftStatus: "pending",
      rawMediaPresent: false,
    });

    const serializedMetadata = JSON.stringify(events.map((event) => event.metadata));
    expect(serializedMetadata).not.toContain("sk-live-secret");
    expect(serializedMetadata).not.toContain("raw workflow content");
  });
});
