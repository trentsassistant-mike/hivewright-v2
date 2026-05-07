/**
 * Pure parser for the buffered JSON envelope emitted by `openclaw agent --json`.
 *
 * Used by the openclaw adapter to convert the trailing JSON blob into clean
 * assistant text + token usage, suppressing the surrounding telemetry
 * (runId, status, summary, meta, etc) that would otherwise leak into the
 * live agent card.
 */

export interface CleanResult {
  text: string;
  tokensInput?: number;
  tokensOutput?: number;
  modelUsed?: string;
}

interface OpenClawEnvelope {
  result?: string | {
    payloads?: { text?: string }[];
    meta?: { agentMeta?: { usage?: { input?: number; output?: number }; model?: string } };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export function extractCleanResult(stdout: string): CleanResult | null {
  if (!stdout.trim()) return null;

  let parsed: OpenClawEnvelope;
  try {
    parsed = JSON.parse(stdout) as OpenClawEnvelope;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  let text: string | null = null;
  let tokensInput: number | undefined;
  let tokensOutput: number | undefined;
  let modelUsed: string | undefined;

  if (typeof parsed.result === "string") {
    text = parsed.result;
  } else if (parsed.result && typeof parsed.result === "object") {
    const payloads = parsed.result.payloads;
    if (Array.isArray(payloads)) {
      const joined = payloads
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter((t) => t.length > 0)
        .join("\n\n");
      if (joined) text = joined;
    }
    const agentMeta = parsed.result.meta?.agentMeta;
    if (agentMeta) {
      tokensInput = agentMeta.usage?.input;
      tokensOutput = agentMeta.usage?.output;
      modelUsed = agentMeta.model;
    }
  }

  if (tokensInput === undefined) tokensInput = parsed.usage?.input_tokens;
  if (tokensOutput === undefined) tokensOutput = parsed.usage?.output_tokens;
  if (modelUsed === undefined) modelUsed = parsed.model;

  if (text === null) return null;
  return { text, tokensInput, tokensOutput, modelUsed };
}
