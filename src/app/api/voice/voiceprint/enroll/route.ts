import { NextResponse } from "next/server";
import { requireApiUser } from "@/app/api/_lib/auth";
import { sql } from "@/app/api/_lib/db";
import { canAccessHive } from "@/auth/users";
import { db } from "@/db";
import { ownerVoiceprints } from "@/db/schema/voice-sessions";
import { loadVoiceServicesUrl } from "@/lib/voice-services-url";

/**
 * POST /api/voice/voiceprint/enroll
 *
 * Accepts a multipart form with `hiveId` + `sample` (a WAV recording),
 * forwards the raw WAV bytes to the GPU voice-services
 * `/voiceprint/embed` endpoint, validates the returned 192-d Pyannote
 * embedding, and stores it in `owner_voiceprints`. This is the v1
 * enrolment path — the owner records a short clip while on the tailnet
 * and curls it up; a proper in-browser MediaRecorder flow ships in
 * v1.5 (see `docs/voice-ea/README.md`).
 *
 * Task 17 (live-call verification) reads from `owner_voiceprints` to
 * compare incoming-call audio against the enrolled baseline. Multiple
 * enrolments per hive are allowed — re-enrolment simply appends a new
 * row, and the verifier uses the latest by `enrolled_at`.
 *
 * Auth: NextAuth session OR INTERNAL_SERVICE_TOKEN bearer (same as
 * every other /api/voice/* endpoint).
 *
 * Failure modes:
 *   400 — missing/empty `hiveId` or `sample`
 *   400 — `twilio-voice` connector not installed (so no GPU URL to
 *         forward to)
 *   413 — sample exceeds the 10 MB cap
 *   502 — GPU service returned a malformed embedding
 *   502 — GPU service request failed (network / non-200)
 */

const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const EMBEDDING_DIM = 192;

export async function POST(req: Request): Promise<NextResponse> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { error: "multipart form required" },
      { status: 400 },
    );
  }

  const hiveId = form.get("hiveId");
  const sample = form.get("sample");
  if (typeof hiveId !== "string" || hiveId.length === 0) {
    return NextResponse.json({ error: "hiveId required" }, { status: 400 });
  }
  if (!(sample instanceof Blob) || sample.size === 0) {
    return NextResponse.json({ error: "sample required" }, { status: 400 });
  }

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Forbidden: caller cannot access this hive" },
        { status: 403 },
      );
    }
  }

  const audioBuf = Buffer.from(await sample.arrayBuffer());
  if (audioBuf.length > MAX_SAMPLE_BYTES) {
    return NextResponse.json(
      { error: "sample too large (max 10 MB)" },
      { status: 413 },
    );
  }

  // Voice services URL comes from the per-hive `voice-ea` connector
  // install (canonical source of truth post-Phase-A; falls back to the
  // VOICE_SERVICES_URL env for tests / fresh dev boxes).
  const voiceServicesUrl = await loadVoiceServicesUrl(sql, hiveId);
  if (!voiceServicesUrl) {
    return NextResponse.json(
      { error: "voice-ea connector not installed or missing voiceServicesUrl" },
      { status: 400 },
    );
  }

  // Forward the raw WAV bytes to the GPU service. The GPU endpoint is
  // `POST /voiceprint/embed` with the WAV as the request body (not
  // multipart — see gpu-services/voice/src/voice_services/server.py).
  let embedRes: Response;
  try {
    embedRes = await fetch(
      `${voiceServicesUrl}/voiceprint/embed`,
      {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: audioBuf,
      },
    );
  } catch (err) {
    return NextResponse.json(
      { error: `voice services unreachable: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (!embedRes.ok) {
    return NextResponse.json(
      { error: `voice services returned HTTP ${embedRes.status}` },
      { status: 502 },
    );
  }

  const payload = (await embedRes.json().catch(() => null)) as
    | { embedding?: unknown }
    | null;
  const embedding = payload?.embedding;
  if (
    !Array.isArray(embedding) ||
    embedding.length !== EMBEDDING_DIM ||
    !embedding.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return NextResponse.json(
      { error: "voice services returned malformed embedding" },
      { status: 502 },
    );
  }

  const [inserted] = await db
    .insert(ownerVoiceprints)
    .values({ hiveId, embedding: embedding as number[] })
    .returning({ id: ownerVoiceprints.id, enrolledAt: ownerVoiceprints.enrolledAt });

  return NextResponse.json({
    ok: true,
    id: inserted.id,
    enrolledAt: inserted.enrolledAt,
  });
}
