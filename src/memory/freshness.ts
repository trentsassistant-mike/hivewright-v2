import type { FreshnessLevel } from "./types";

const FRESH_DAYS = 30;
const AGING_DAYS = 90;

export function computeFreshness(updatedAt: Date): FreshnessLevel {
  const now = new Date();
  const daysSinceUpdate = Math.floor(
    (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (daysSinceUpdate <= FRESH_DAYS) return "fresh";
  if (daysSinceUpdate <= AGING_DAYS) return "aging";
  return "stale";
}

export function formatWithFreshness(content: string, updatedAt: Date): string {
  const freshness = computeFreshness(updatedAt);
  const daysSinceUpdate = Math.floor(
    (new Date().getTime() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)
  );
  switch (freshness) {
    case "fresh":
      return content;
    case "aging":
      return `${content} (last updated ${daysSinceUpdate} days ago)`;
    case "stale":
      return `${content} (potentially outdated — last updated ${daysSinceUpdate} days ago)`;
  }
}
