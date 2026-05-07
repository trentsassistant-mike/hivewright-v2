import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { VoiceprintVerifier } from "@/connectors/voice/voiceprint-verifier";

/**
 * VoiceprintVerifier unit tests.
 *
 * We exercise the verifier against the real test database (so the
 * drizzle `SELECT ... FROM owner_voiceprints` call actually runs) but
 * mock `global.fetch` so we never hit the GPU. Three scenarios:
 *
 *   1. Fail-open: no enrolled voiceprint → verifier is a silent no-op.
 *   2. Match: embedding similarity above threshold → `onFail` never fires.
 *   3. Mismatch: embedding similarity below threshold for 3 consecutive
 *      windows → `onFail` fires exactly once.
 *
 * Each `pushSamples(3.2s of audio)` call fills one 3s window plus a small
 * remainder. After awaiting the in-flight verify, we push again to trigger
 * the next window.
 */

const HIVE_ID = "00000000-0000-0000-0000-000000000001";

async function seedHive() {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'vp-verifier-test', 'VP Verifier Test', 'real')
  `;
}

/**
 * Build a Buffer of `seconds * sampleRate` int16 LE samples with
 * low-amplitude random noise. Content doesn't matter because the GPU call
 * is mocked — we just need a buffer whose byte length is ≥ one window
 * (48 KB at 3s × 8 kHz × 2 bytes/sample) so `pushSamples` kicks off a
 * verify immediately.
 */
function makeSamples(sampleRate = 8000, seconds = 3.2): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE((Math.random() * 200) | 0, i * 2);
  return buf;
}

/**
 * Poll until predicate is true or deadline elapses. The verifier kicks off
 * its async verify inside `pushSamples`, so tests can't simply `await` a
 * known promise — instead we wait for the observable side-effect (fetch
 * count or onFail calls).
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("VoiceprintVerifier", () => {
  beforeEach(async () => {
    await seedHive();
  });

  it("is a no-op when no owner voiceprint is enrolled (fail-open)", async () => {
    const onFail = vi.fn();
    const fetchMock = vi.fn();
    (global.fetch as unknown) = fetchMock;
    const v = new VoiceprintVerifier({
      hiveId: HIVE_ID,
      voiceServicesUrl: "http://gpu.local:8790",
      onFail,
    });
    v.pushSamples(makeSamples());
    // Give the async enrollment-load + drain a chance to settle.
    await waitFor(() => false, 100);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });

  it("does not fail when similarity stays above threshold", async () => {
    const embedding = new Array(192).fill(0).map((_, i) => (i < 96 ? 1 : 0));
    const vecLiteral = `[${embedding.join(",")}]`;
    await sql`
      INSERT INTO owner_voiceprints (hive_id, embedding)
      VALUES (${HIVE_ID}, ${vecLiteral}::vector)
    `;
    const onFail = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    (global.fetch as unknown) = fetchMock;

    const v = new VoiceprintVerifier({
      hiveId: HIVE_ID,
      voiceServicesUrl: "http://gpu.local:8790",
      onFail,
    });
    for (let i = 0; i < 5; i++) {
      v.pushSamples(makeSamples());
      // Wait for the in-flight verify to settle before pushing the next
      // window so each push actually triggers a new verify.
      await waitFor(
        () => (fetchMock.mock.calls.length ?? 0) >= i + 1,
        2000,
      );
    }
    expect(onFail).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("calls onFail after 3 consecutive mismatched windows", async () => {
    const enrolled = new Array(192).fill(0).map((_, i) => (i < 96 ? 1 : 0));
    // Opposite-direction vector → cosine similarity = -0.5 → below 0.55
    // threshold → every window counts as a fail.
    const mismatch = new Array(192).fill(0).map((_, i) => (i < 96 ? -1 : 0));
    const enrolledLiteral = `[${enrolled.join(",")}]`;
    await sql`
      INSERT INTO owner_voiceprints (hive_id, embedding)
      VALUES (${HIVE_ID}, ${enrolledLiteral}::vector)
    `;
    const onFail = vi.fn();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: mismatch }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    (global.fetch as unknown) = fetchMock;

    const v = new VoiceprintVerifier({
      hiveId: HIVE_ID,
      voiceServicesUrl: "http://gpu.local:8790",
      onFail,
    });
    // Three consecutive full windows → three consecutive fails → onFail.
    for (let i = 0; i < 3; i++) {
      v.pushSamples(makeSamples());
      await waitFor(
        () => (fetchMock.mock.calls.length ?? 0) >= i + 1,
        2000,
      );
    }
    await waitFor(() => onFail.mock.calls.length > 0, 500);
    expect(onFail).toHaveBeenCalledTimes(1);
  });
});
