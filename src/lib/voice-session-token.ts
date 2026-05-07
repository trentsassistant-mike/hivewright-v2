import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived signed handshake token for the direct-WS voice path.
 *
 * The PWA hits `POST /api/voice/direct` on the dashboard (NextAuth-gated)
 * to mint one of these. It then opens `wss://<host>/api/voice/direct/ws?
 * token=<signed>` against the dispatcher. The dispatcher verifies the
 * token with the same secret (`INTERNAL_SERVICE_TOKEN`, already shared
 * between the two processes) before doing any DB work.
 *
 * Why a signed handshake instead of forwarding the NextAuth session cookie?
 * Two reasons:
 *  1. The dispatcher process doesn't run NextAuth — keeping it out of that
 *     stack is simpler and faster.
 *  2. WS upgrade headers don't pass cookies through every reverse-proxy
 *     setup cleanly. A query-string token survives anything that survives
 *     the URL itself.
 *
 * 60 second TTL — long enough for a slow phone connection to actually
 * open the WS, short enough that a leaked token has no useful afterlife.
 */
export interface VoiceSessionTokenPayload {
  hiveId: string;
  ownerId: string;
  exp: number;
}

const TTL_MS = 60_000;

function getSecret(): Buffer {
  const secret = process.env.INTERNAL_SERVICE_TOKEN;
  if (!secret) {
    throw new Error(
      "INTERNAL_SERVICE_TOKEN is not set — cannot sign voice session tokens",
    );
  }
  return Buffer.from(secret, "utf8");
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signVoiceSessionToken(args: {
  hiveId: string;
  ownerId: string;
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  const payload: VoiceSessionTokenPayload = {
    hiveId: args.hiveId,
    ownerId: args.ownerId,
    exp: now + TTL_MS,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(
    createHmac("sha256", getSecret()).update(body).digest(),
  );
  return `${body}.${sig}`;
}

/**
 * Verify a token. Returns the payload on success, `null` on any failure
 * (malformed, bad signature, expired). Never throws — callers shape their
 * "deny" response from the same null shape regardless of which check failed,
 * so attackers can't probe individual error modes.
 */
export function verifyVoiceSessionToken(
  token: string,
  now: number = Date.now(),
): VoiceSessionTokenPayload | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let secret: Buffer;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const expectedSig = b64url(
    createHmac("sha256", secret).update(body).digest(),
  );
  // Constant-time compare. Length-mismatch fast path is also safe — the
  // signature length is a function of the secret/algorithm, not user input.
  if (sig.length !== expectedSig.length) return null;
  const ok = timingSafeEqual(
    Buffer.from(sig, "utf8"),
    Buffer.from(expectedSig, "utf8"),
  );
  if (!ok) return null;

  let payload: VoiceSessionTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload?.hiveId !== "string" ||
    typeof payload?.ownerId !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp <= now) return null;
  return payload;
}
