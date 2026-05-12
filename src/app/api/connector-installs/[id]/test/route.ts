import { jsonError, jsonOk } from "../../../_lib/responses";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { getConnectorDefinition } from "@/connectors/registry";
import { invokeConnectorReadOnlyOrSystem } from "@/connectors/runtime";
import { canMutateHive } from "@/auth/users";

/**
 * POST /api/connector-installs/:id/test
 * Body is intentionally ignored for operation selection. This endpoint only
 * runs the connector's safe system test operation.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      operation?: string;
      args?: Record<string, unknown>;
    };

    const [install] = await sql`
      SELECT connector_slug, hive_id AS "hiveId" FROM connector_installs WHERE id = ${id}
    `;
    if (!install) return jsonError("install not found", 404);

    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, install.hiveId as string);
      if (!canMutate) return jsonError("Forbidden: caller cannot mutate this hive", 403);
    }

    const def = getConnectorDefinition(install.connector_slug as string);
    if (!def) return jsonError(`unknown connector ${install.connector_slug}`, 400);

    void body;

    const testOperation = def.operations.find((operation) =>
      ["test_connection", "self_test"].includes(operation.slug) &&
      operation.governance.effectType === "system" &&
      operation.governance.defaultDecision === "allow" &&
      operation.governance.riskTier === "low"
    );
    if (!testOperation) return jsonError("connector has no safe test operation", 400);

    const result = await invokeConnectorReadOnlyOrSystem(sql, {
      installId: id,
      operation: testOperation.slug,
      args: {},
      actor: "owner-test",
    });

    return jsonOk(result);
  } catch (err) {
    console.error("[api/connector-installs/:id/test]", err);
    return jsonError("Test failed", 500);
  }
}
