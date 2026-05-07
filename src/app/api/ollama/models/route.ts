import { requireApiAuth } from "../../_lib/auth";
import { jsonOk, jsonError } from "../../_lib/responses";
import { getProviderEndpoint } from "@/adapters/provider-config";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const endpoint = getProviderEndpoint("ollama");
  if (!endpoint) {
    return jsonOk([]);
  }

  try {
    const res = await fetch(`${endpoint}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return jsonError(`Ollama responded with ${res.status}`, 502);
    }
    const body = (await res.json()) as {
      data?: { id: string }[];
    };
    const models = (body.data ?? []).map((m) => ({
      id: `ollama/${m.id}`,
    }));
    return jsonOk(models);
  } catch {
    // Ollama not reachable — return empty list, don't error
    return jsonOk([]);
  }
}
