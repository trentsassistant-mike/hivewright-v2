import { requireApiAuth } from "../_lib/auth";
import { jsonOk } from "../_lib/responses";
import { CONNECTOR_REGISTRY, toPublicConnector } from "@/connectors/registry";

/**
 * GET /api/connectors — the public catalog (metadata only, never handlers
 * or secrets). Powers the connector browser on /setup/connectors.
 */
export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  return jsonOk(CONNECTOR_REGISTRY.map(toPublicConnector));
}
