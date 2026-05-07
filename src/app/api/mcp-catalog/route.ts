import { requireApiAuth } from "../_lib/auth";
import { jsonOk } from "../_lib/responses";
import { MCP_CATALOG } from "../../../tools/mcp-catalog";

/**
 * Expose the static MCP catalog so the dashboard can render the per-role
 * tool-picker without hard-coding the list in two places.
 */
export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  return jsonOk(
    MCP_CATALOG.map((e) => ({
      slug: e.slug,
      label: e.label,
      description: e.description,
      requiredEnv: e.requiredEnv ?? [],
      requiredEnvPresent: (e.requiredEnv ?? []).every((k) => process.env[k]),
    })),
  );
}
