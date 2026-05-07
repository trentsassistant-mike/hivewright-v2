import type { Adapter, AdapterProbeCredential, AdapterResult, ChunkCallback, ProbeResult, SessionContext } from "./types";
import { getProviderEndpoint } from "./provider-config";
import { SseChunker } from "./sse-parser";
import { healthyProbeResult, probeResultFromBoundaryError, unhealthyProbeResult } from "./probe-classifier";
import { renderSessionPrompt } from "./context-renderer";

export class OllamaAdapter implements Adapter {
  supportsPersistence = false;

  async probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult> {
    const startedAt = Date.now();
    const endpoint = (credential.baseUrl ?? credential.secrets.OLLAMA_ENDPOINT ?? getProviderEndpoint("ollama") ?? "").replace(/\/+$/, "");
    const modelName = this.extractModelName(modelId);

    try {
      const response = await fetch(`${endpoint}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(30_000),
      });
      const latencyMs = Date.now() - startedAt;
      const raw = await response.text();
      if (!response.ok) {
        return probeResultFromBoundaryError({ statusCode: response.status, message: raw, latencyMs });
      }
      const payload = JSON.parse(raw) as { models?: Array<{ name?: string; model?: string }> };
      const modelLoaded = payload.models?.some((model) => model.name === modelName || model.model === modelName) ?? false;
      if (!modelLoaded) {
        return unhealthyProbeResult({
          failureClass: "unavailable",
          reason: {
            code: "ollama_model_not_loaded",
            message: `Ollama model '${modelName}' is not loaded on ${endpoint}.`,
            retryable: true,
          },
          latencyMs,
          costEstimateUsd: 0,
        });
      }
      return healthyProbeResult({ latencyMs, costEstimateUsd: 0 });
    } catch (err) {
      return probeResultFromBoundaryError({
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  translate(ctx: SessionContext): string {
    return renderSessionPrompt(ctx);
  }

  extractModelName(model: string): string {
    // Strip ollama/ prefix: "ollama/qwen3:32b" → "qwen3:32b"
    return model.startsWith("ollama/") ? model.slice(7) : model.includes("/") ? model.split("/")[1] : model;
  }

  async execute(ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult> {
    const systemPrompt = this.translate(ctx);
    const modelName = this.extractModelName(ctx.model);
    const endpoint = getProviderEndpoint("ollama")!;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 600_000);

      const response = await fetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Execute the task: ${ctx.task.title}\n\n${ctx.task.brief}` },
          ],
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timeout);
        const errText = await response.text();
        if (response.status === 404 || errText.includes("model")) {
          return { success: false, output: "", failureReason: `Model not found: ${modelName}. Ensure it's pulled on the Ollama server.` };
        }
        return { success: false, output: "", failureReason: `Ollama API error: ${response.status} ${errText}` };
      }

      if (!response.body) {
        clearTimeout(timeout);
        return { success: false, output: "", failureReason: "Ollama returned no response body" };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const chunker = new SseChunker();
      const collected: string[] = [];
      const chunkPromises: Promise<void>[] = [];
      let lastUsage: { tokensInput?: number; tokensOutput?: number } | null = null;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const out = chunker.feed(text);
          for (const t of out.texts) {
            collected.push(t);
            if (onChunk) {
              chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
            }
          }
          if (out.usage) lastUsage = out.usage;
          if (out.done) break;
        }
        // Flush any trailing bytes the streaming decoder is still holding
        // (multi-byte UTF-8 codepoint at the very end of the body). Mirrors
        // the claude-code adapter fix in commit 4ed135f.
        const tail = decoder.decode();
        if (tail) {
          const out = chunker.feed(tail);
          for (const t of out.texts) {
            collected.push(t);
            if (onChunk) {
              chunkPromises.push(onChunk({ text: t, type: "stdout" }).catch(() => {}));
            }
          }
          if (out.usage) lastUsage = out.usage;
        }
      } finally {
        clearTimeout(timeout);
        await Promise.allSettled(chunkPromises);
      }

      return {
        success: true,
        output: collected.join(""),
        tokensInput: lastUsage?.tokensInput,
        tokensOutput: lastUsage?.tokensOutput,
        modelUsed: `ollama/${modelName}`,
      };
    } catch (err) {
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          return { success: false, output: "", failureReason: "Ollama request timed out after 10 minutes" };
        }
        if (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed")) {
          return { success: false, output: "", failureReason: `Cannot connect to Ollama at ${endpoint}. Is it running?` };
        }
        return { success: false, output: "", failureReason: `Ollama error: ${err.message}` };
      }
      return { success: false, output: "", failureReason: "Unknown Ollama error" };
    }
  }
}
