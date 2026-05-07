/**
 * Shaping helper for live agent output chunks. Agent stderr in particular
 * can be enormous — OpenClaw's gateway dumps the full session meta (tool
 * schemas, prompt, memory, usage) as a single 20-30 KB JSON blob when a
 * session times out. Rendering that verbatim floods the dashboard.
 *
 * This helper collapses huge blobs into a single-line summary and truncates
 * ordinary long chunks so the live view stays readable. Raw bytes are still
 * available in the task_logs table for investigation.
 */

const MAX_PLAIN_LINE_CHARS = 800;
const SESSION_META_KEYS = [
  '"livenessState"',
  '"finalPromptText"',
  '"replayInvalid"',
  '"agentMeta"',
  '"propertiesCount"',
];

export interface ShapedChunk {
  /** Human-readable text to render. May be short even if the original chunk was huge. */
  display: string;
  /** Original length of the chunk in bytes (informational). */
  originalBytes: number;
  /** True when the chunk was collapsed/summarised rather than shown verbatim. */
  summarised: boolean;
}

export function shapeAgentChunk(raw: string): ShapedChunk {
  const len = raw.length;

  // Session-meta dumps: huge JSON blobs emitted on OpenClaw timeout / error.
  // These are diagnostic for the backend, noise for the UI.
  if (len > 2000 && SESSION_META_KEYS.some((k) => raw.includes(k))) {
    const kb = Math.round(len / 1024);
    const firstLine = raw.split("\n")[0].slice(0, 120).trimEnd();
    const hint = firstLine.startsWith("{") ? "session diagnostic" : firstLine;
    return {
      display: `[${hint} — ${kb} KB collapsed; see task_logs for full payload]`,
      originalBytes: len,
      summarised: true,
    };
  }

  // Ordinary long lines: truncate with a byte count so the user knows more
  // is available.
  if (len > MAX_PLAIN_LINE_CHARS) {
    const head = raw.slice(0, MAX_PLAIN_LINE_CHARS);
    const kb = Math.round(len / 1024);
    return {
      display: `${head}\n[… ${kb} KB truncated]`,
      originalBytes: len,
      summarised: true,
    };
  }

  // Short chunks stream through unchanged so streaming partials concat
  // naturally ("hello" + " world" → "hello world").
  return {
    display: raw,
    originalBytes: len,
    summarised: false,
  };
}
