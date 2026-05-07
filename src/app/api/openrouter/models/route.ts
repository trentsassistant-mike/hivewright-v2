import { sql } from "../../_lib/db";
import { requireApiAuth } from "../../_lib/auth";
import { jsonOk, jsonError, parseSearchParams } from "../../_lib/responses";
import { loadCredentials } from "@/credentials/manager";

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
}

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    const encryptionKey = process.env.ENCRYPTION_KEY || "";
    if (!encryptionKey) return jsonError("ENCRYPTION_KEY is not configured", 503);

    const creds = await loadCredentials(sql, {
      hiveId: "00000000-0000-0000-0000-000000000000",
      requiredKeys: ["OPENROUTER_API_KEY"],
      roleSlug: "work-intake",
      encryptionKey,
    });
    const key = (creds as unknown as Record<string, string>).OPENROUTER_API_KEY;
    if (!key) return jsonError("openrouter: OPENROUTER_API_KEY credential not configured", 503);

    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return jsonError(`openrouter responded with ${res.status}`, 502);

    const body = (await res.json()) as { data?: OpenRouterModel[] };
    const all = (body.data ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      free: isFreeModel(m),
      pricing: m.pricing ?? null,
    }));

    const params = parseSearchParams(request.url);
    const freeOnly = params.get("freeOnly") === "true";
    const filtered = freeOnly ? all.filter((m) => m.free) : all;

    return jsonOk({ data: filtered });
  } catch {
    return jsonError("openrouter: failed to list models", 502);
  }
}

function isFreeModel(m: OpenRouterModel): boolean {
  if (m.id.endsWith(":free")) return true;
  const p = m.pricing;
  if (!p) return false;
  const prompt = Number(p.prompt ?? "0");
  const completion = Number(p.completion ?? "0");
  return prompt === 0 && completion === 0;
}
