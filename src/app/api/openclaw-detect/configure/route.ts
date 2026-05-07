import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { detectOpenClawConfig } from "@/adapters/openclaw-config";

export async function POST() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const config = detectOpenClawConfig();
  if (!config.installed) return jsonError("OpenClaw not detected", 404);

  const configJson = {
    apiEndpoint: config.endpoint,
    apiKey: config.authToken,
    sessionTimeoutSecs: "0",
  };

  // Upsert
  const existing = await sql`SELECT id FROM adapter_config WHERE adapter_type = 'openclaw'`;
  if (existing.length > 0) {
    await sql`UPDATE adapter_config SET config = ${sql.json(configJson)}, updated_at = NOW() WHERE id = ${existing[0].id}`;
  } else {
    await sql`INSERT INTO adapter_config (adapter_type, config) VALUES ('openclaw', ${sql.json(configJson)})`;
  }

  return jsonOk({ configured: true, endpoint: config.endpoint });
}
