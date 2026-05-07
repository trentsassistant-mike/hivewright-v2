import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const EMPTY_BASE_URL_TOKEN = "";

export interface CredentialFingerprintInput {
  provider: string;
  baseUrl?: string | null;
  secretValue: string;
}

function deriveKey(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey).digest();
}

export function encrypt(plaintext: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

export function decrypt(encryptedValue: string, rawKey: string): string {
  const key = deriveKey(rawKey);
  const [ivHex, authTagHex, ciphertext] = encryptedValue.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return EMPTY_BASE_URL_TOKEN;

  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

export function createCredentialFingerprint(input: CredentialFingerprintInput): string {
  return createHash("sha256")
    .update(JSON.stringify([
      normalizeProvider(input.provider),
      normalizeBaseUrl(input.baseUrl),
      input.secretValue,
    ]))
    .digest("hex");
}
