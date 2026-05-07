import { beforeEach, describe, expect, it } from "vitest";
import {
  signVoiceSessionToken,
  verifyVoiceSessionToken,
} from "@/lib/voice-session-token";

describe("voice session token", () => {
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-secret-do-not-ship";
  });

  it("signs and verifies a fresh token round-trip", () => {
    const token = signVoiceSessionToken({
      hiveId: "hive-1",
      ownerId: "owner-1",
    });
    const payload = verifyVoiceSessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload?.hiveId).toBe("hive-1");
    expect(payload?.ownerId).toBe("owner-1");
    expect(payload?.exp).toBeGreaterThan(Date.now());
  });

  it("returns null for a token with a tampered payload", () => {
    const token = signVoiceSessionToken({
      hiveId: "hive-1",
      ownerId: "owner-1",
    });
    // Flip a single character in the payload so the signature no longer
    // matches. The payload section is everything before the dot.
    const dot = token.indexOf(".");
    const tampered = "X" + token.slice(1, dot) + token.slice(dot);
    expect(verifyVoiceSessionToken(tampered)).toBeNull();
  });

  it("returns null for an expired token", () => {
    const past = Date.now() - 120_000;
    const token = signVoiceSessionToken({
      hiveId: "hive-1",
      ownerId: "owner-1",
      now: past, // exp = past + 60s, well in the past
    });
    expect(verifyVoiceSessionToken(token)).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(verifyVoiceSessionToken("")).toBeNull();
    expect(verifyVoiceSessionToken("nodotoken")).toBeNull();
    expect(verifyVoiceSessionToken(".onlydot")).toBeNull();
    expect(verifyVoiceSessionToken("body.")).toBeNull();
  });

  it("returns null when the secret is missing", () => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    // Sign throws when secret is missing — callers shouldn't be calling
    // sign without env. Verify, on the other hand, must NEVER throw — it
    // returns null on any failure mode including missing secret.
    expect(() =>
      signVoiceSessionToken({ hiveId: "h", ownerId: "o" }),
    ).toThrow();
    // any token verifies as null when the secret is gone
    expect(verifyVoiceSessionToken("x.y")).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const other = "different-secret";
    process.env.INTERNAL_SERVICE_TOKEN = other;
    const token = signVoiceSessionToken({
      hiveId: "hive-1",
      ownerId: "owner-1",
    });
    process.env.INTERNAL_SERVICE_TOKEN = "test-secret-do-not-ship";
    expect(verifyVoiceSessionToken(token)).toBeNull();
  });
});
