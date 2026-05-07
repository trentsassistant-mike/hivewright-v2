import type { ProvisionStatus } from "./types";

export const CACHE_TTL_MS = 60_000;

interface Entry {
  status: ProvisionStatus;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

export function getCachedStatus(slug: string): ProvisionStatus | undefined {
  const entry = cache.get(slug);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(slug);
    return undefined;
  }
  return entry.status;
}

export function setCachedStatus(slug: string, status: ProvisionStatus): void {
  cache.set(slug, { status, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function invalidate(slug: string): void {
  cache.delete(slug);
}

export function invalidateAll(): void {
  cache.clear();
}
