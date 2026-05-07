export interface EmbeddingReembedProgress {
  processed: number;
  total: number;
  failed: number;
  cursor: string | null;
}

export interface ObservedReembedProgress extends EmbeddingReembedProgress {
  observedAt: number;
}

export function estimateEtaSeconds(
  current: ObservedReembedProgress | null,
  previous: ObservedReembedProgress | null,
): number | null {
  if (!current) return null;
  const remaining = Math.max(current.total - current.processed, 0);
  if (remaining === 0) return 0;
  if (!previous) return null;

  const processedDelta = current.processed - previous.processed;
  const secondsDelta = (current.observedAt - previous.observedAt) / 1000;
  if (processedDelta <= 0 || secondsDelta <= 0) return null;

  return Math.ceil((remaining / processedDelta) * secondsDelta);
}

export function formatEta(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds <= 0) return "under a second";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
