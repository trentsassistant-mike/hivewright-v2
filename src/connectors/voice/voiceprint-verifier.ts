import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ownerVoiceprints } from "@/db/schema/voice-sessions";

/**
 * Continuous voiceprint verification for an in-progress voice call.
 *
 * Owned by `VoiceSessionRuntime` — one instance per active call. The runtime
 * forwards inbound caller PCM chunks via `pushSamples(pcm)`; the verifier
 * buffers 3-second windows of 8 kHz int16-LE PCM and, once a window is full,
 * POSTs a WAV to the GPU voice-services `/voiceprint/embed` endpoint. The
 * returned 192-d Pyannote embedding is compared (cosine similarity) to the
 * enrolled owner vector for the hive (latest row in `owner_voiceprints`).
 *
 * Three consecutive mismatched windows → `onFail()` fires once. The runtime
 * responds by transitioning to `ended` with `endReason="voiceprint_fail"`.
 *
 * Fail-open design: if no owner voiceprint is enrolled for the hive, the
 * verifier is a silent no-op. This is deliberate for v1 soft-launch — owners
 * who haven't enrolled yet must still be able to make calls. The buffer is
 * still drained so it can't grow unbounded over a long call.
 *
 * In-flight guard: only one verify POST is in flight at a time. Incoming PCM
 * keeps the buffer filling during the window, but we skip kicking off another
 * verify until the prior one resolves — the GPU roundtrip is typically shorter
 * than a single 3s window so this rarely matters in practice, but it prevents
 * a backlog forming on a slow GPU.
 */

const SAMPLE_RATE_HZ = 8000; // Twilio Media Streams μ-law, decoded to 8 kHz PCM
const WINDOW_DURATION_SEC = 3;
const WINDOW_SAMPLES = SAMPLE_RATE_HZ * WINDOW_DURATION_SEC; // 24000 samples
const WINDOW_BYTES = WINDOW_SAMPLES * 2; // int16 LE → 48 KB per window
const CONSECUTIVE_FAIL_THRESHOLD = 3;
// Forgiving v1 default — tune once we have real call data. Pyannote cosine
// similarity between same-speaker clips typically lands 0.65–0.85; different
// speakers typically 0.3–0.5. 0.55 splits the difference with a bias toward
// fail-open to minimise false hang-ups.
const SIMILARITY_THRESHOLD = 0.55;

export interface VoiceprintVerifierDeps {
  hiveId: string;
  voiceServicesUrl: string;
  onFail: () => void;
}

export class VoiceprintVerifier {
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private enrolled: number[] | null = null;
  private enrolledLoaded = false;
  private consecutiveFails = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private deps: VoiceprintVerifierDeps) {}

  /**
   * Append inbound caller PCM (int16 LE, 8 kHz, mono). Fire-and-forget —
   * never throws, never awaits; the runtime's media hot path must stay
   * synchronous.
   */
  pushSamples(pcm: Buffer): void {
    this.buffer.push(pcm);
    this.bufferedBytes += pcm.length;
    if (this.bufferedBytes >= WINDOW_BYTES && !this.inFlight) {
      this.inFlight = this.verifyNextWindow().finally(() => {
        this.inFlight = null;
      });
    }
  }

  private async loadEnrolled(): Promise<void> {
    if (this.enrolledLoaded) return;
    this.enrolledLoaded = true;
    try {
      const [row] = await db
        .select({ embedding: ownerVoiceprints.embedding })
        .from(ownerVoiceprints)
        .where(eq(ownerVoiceprints.hiveId, this.deps.hiveId))
        .orderBy(desc(ownerVoiceprints.enrolledAt))
        .limit(1);
      if (row?.embedding) {
        // drizzle-pgvector returns the stored vector as number[] directly.
        this.enrolled = row.embedding as unknown as number[];
      }
    } catch (err) {
      console.error("[voiceprint] failed to load enrolled vector:", err);
    }
  }

  private async verifyNextWindow(): Promise<void> {
    await this.loadEnrolled();
    if (!this.enrolled) {
      // Fail-open: no enrollment → no verification. Drain the buffer so a
      // long un-enrolled call doesn't slowly eat memory.
      this.drainWindow();
      return;
    }
    const wav = this.drainWindowAsWav();
    if (!wav) return;
    try {
      // The DOM `BodyInit` type (pulled in by `lib: ["dom"]`) doesn't list
      // Node's `Buffer` / `Uint8Array` variants — but at runtime Node's
      // `fetch` (undici) accepts them fine. Cast through `BodyInit` to
      // bypass the DOM-vs-Node typing mismatch. Same pattern used by
      // src/app/api/voice/voiceprint/enroll/route.ts in an API-route
      // context where Next's ambient types paper over the gap for us.
      const embedRes = await fetch(
        `${this.deps.voiceServicesUrl.replace(/\/$/, "")}/voiceprint/embed`,
        {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: wav as unknown as BodyInit,
        },
      );
      if (!embedRes.ok) {
        console.warn(
          "[voiceprint] embed call failed:",
          embedRes.status,
        );
        return;
      }
      const payload = (await embedRes.json().catch(() => null)) as
        | { embedding?: unknown }
        | null;
      const embedding = payload?.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length !== this.enrolled.length
      ) {
        console.warn("[voiceprint] malformed embedding");
        return;
      }
      const sim = cosineSimilarity(
        embedding as number[],
        this.enrolled,
      );
      if (sim >= SIMILARITY_THRESHOLD) {
        this.consecutiveFails = 0;
        return;
      }
      this.consecutiveFails += 1;
      console.warn(
        `[voiceprint] mismatch window sim=${sim.toFixed(3)} fails=${this.consecutiveFails}/${CONSECUTIVE_FAIL_THRESHOLD}`,
      );
      if (this.consecutiveFails >= CONSECUTIVE_FAIL_THRESHOLD) {
        this.deps.onFail();
      }
    } catch (err) {
      console.error("[voiceprint] verify window failed:", err);
    }
  }

  private drainWindow(): Buffer | null {
    if (this.bufferedBytes < WINDOW_BYTES) return null;
    const merged = Buffer.concat(this.buffer);
    const window = merged.subarray(0, WINDOW_BYTES);
    const rest = merged.subarray(WINDOW_BYTES);
    this.buffer = rest.length > 0 ? [Buffer.from(rest)] : [];
    this.bufferedBytes = rest.length;
    return Buffer.from(window);
  }

  private drainWindowAsWav(): Buffer | null {
    const pcm = this.drainWindow();
    if (!pcm) return null;
    return pcmToWav(pcm, SAMPLE_RATE_HZ, 1, 16);
  }

  // Exposed for tests that want to exercise cosine similarity in isolation
  // without spinning up a full verifier + fetch mock.
  static _cosineSimilarity = (a: number[], b: number[]): number =>
    cosineSimilarity(a, b);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Wrap raw PCM (int16 LE, mono) in a minimal WAV RIFF container. The GPU
 * `/voiceprint/embed` endpoint expects `audio/wav`, not raw PCM.
 */
function pcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const chunkSize = 36 + dataSize;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(chunkSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  header.writeUInt16LE(1, 20); // AudioFormat = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
