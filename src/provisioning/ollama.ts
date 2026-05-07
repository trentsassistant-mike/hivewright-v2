import type { Provisioner, ProvisionProgress, ProvisionStatus, ProvisionerInput } from "./types";

function endpoint(): string {
  return process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
}

/** Strip an `ollama/` prefix from recommendedModel (convention in role.yaml). */
function normaliseModel(m: string): string {
  return m.startsWith("ollama/") ? m.slice("ollama/".length) : m;
}

export class OllamaProvisioner implements Provisioner {
  async check({ recommendedModel }: ProvisionerInput): Promise<ProvisionStatus> {
    const model = normaliseModel(recommendedModel);
    try {
      const res = await fetch(`${endpoint()}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return { satisfied: false, fixable: false, reason: `ollama server returned HTTP ${res.status}` };
      }
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const present = (body.models ?? []).some((m) => m.name === model);
      return present
        ? { satisfied: true, fixable: true }
        : { satisfied: false, fixable: true, reason: `model '${model}' not pulled on GPU` };
    } catch {
      return { satisfied: false, fixable: false, reason: "ollama server is unreachable (GPU offline)" };
    }
  }

  async *provision({ recommendedModel }: ProvisionerInput): AsyncGenerator<ProvisionProgress> {
    const model = normaliseModel(recommendedModel);
    yield { phase: "checking", message: `Starting pull of ${model}` };

    let res: Response;
    try {
      res = await fetch(`${endpoint()}/api/pull`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: model, stream: true }),
      });
    } catch (e) {
      yield { phase: "done", status: { satisfied: false, fixable: false, reason: `ollama unreachable: ${(e as Error).message}` } };
      return;
    }

    if (!res.ok || !res.body) {
      yield { phase: "done", status: { satisfied: false, fixable: true, reason: `pull failed: HTTP ${res.status}` } };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let lastPercent: number | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (frame.error) {
            yield { phase: "done", status: { satisfied: false, fixable: true, reason: `pull error: ${frame.error}` } };
            return;
          }
          const pct = frame.total && frame.completed ? Math.floor((frame.completed / frame.total) * 100) : undefined;
          if (pct !== undefined && pct !== lastPercent) {
            lastPercent = pct;
            yield { phase: "pulling", message: frame.status ?? "pulling", percentComplete: pct };
          } else if (frame.status) {
            yield { phase: "pulling", message: frame.status };
          }
        } catch {
          /* tolerate non-JSON noise */
        }
      }
    }

    yield { phase: "done", status: { satisfied: true, fixable: true } };
  }
}
