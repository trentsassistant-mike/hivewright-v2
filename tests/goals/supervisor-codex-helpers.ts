/**
 * Test-only helpers exposing the pure functions out of supervisor-codex.ts +
 * supervisor.ts so we can unit-test them without spawning a real codex CLI.
 *
 * These mirror the private helpers — keep them in lockstep when the real
 * implementations change.
 */

export function extractThreadIdForTest(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"type":"thread.started"')) continue;
    try {
      const ev = JSON.parse(trimmed) as { thread_id?: string };
      if (typeof ev.thread_id === "string") return ev.thread_id;
    } catch { /* keep scanning */ }
  }
  return null;
}
