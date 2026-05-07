import { requireApiAuth } from "../_lib/auth";
import { jsonOk } from "../_lib/responses";
import { detectOpenClawConfig } from "@/adapters/openclaw-config";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  const config = detectOpenClawConfig();
  return jsonOk({
    installed: config.installed,
    endpoint: config.endpoint,
    // Never expose the full token to the browser — just confirm it exists
    hasAuthToken: !!config.authToken,
  });
}
