export const EA_REPLAY_ADAPTER_TYPE = "ea-runtime";
export const EA_REPLAY_MESSAGE_LIMIT_KEY = "thread_replay_message_limit";
export const DEFAULT_EA_REPLAY_MESSAGE_LIMIT = 80;
export const MIN_EA_REPLAY_MESSAGE_LIMIT = 1;
export const MAX_EA_REPLAY_MESSAGE_LIMIT = 500;

export function asEaReplayMessageLimit(
  value: unknown,
  fallback = DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  if (
    !Number.isInteger(n) ||
    n < MIN_EA_REPLAY_MESSAGE_LIMIT ||
    n > MAX_EA_REPLAY_MESSAGE_LIMIT
  ) {
    return fallback;
  }

  return n;
}
