import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

/**
 * Password hashing using Node's native scrypt. No extra deps, good enough
 * for a small-to-mid-size multi-tenant deploy. Hash format:
 *
 *     scrypt$<N>$<saltHex>$<hashHex>
 *
 * where N is the cost parameter (16384 by default).
 */

const SCRYPT_COST = 16384;
const KEY_LEN = 64;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEY_LEN, { cost: SCRYPT_COST });
  return `scrypt$${SCRYPT_COST}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [algo, costStr, saltHex, hashHex] = stored.split("$");
  if (algo !== "scrypt") return false;
  const cost = Number(costStr);
  if (!Number.isFinite(cost) || cost < 1024) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const candidate = scryptSync(plain, salt, expected.length, { cost });
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
