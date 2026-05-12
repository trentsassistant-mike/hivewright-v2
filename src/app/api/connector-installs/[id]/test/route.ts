import { jsonError, jsonOk } from "../../../_lib/responses";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { requestExternalAction } from "@/actions/external-actions";
import { getConnectorDefinition } from "@/connectors/registry";
import { canMutateHive } from "@/auth/users";

/**
 * POST /api/connector-installs/:id/test
 * Body: { operation: string, args?: Record<string, unknown> }
 *
 * If `operation` is omitted, runs the connector's first declared operation
 * with a sensible default payload so owners can click "Test" without
 * crafting a body. For `discord-webhook.send_message` the default is a
 * "hello from HiveWright" ping.
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

    const operation = body.operation ?? def.operations[0]?.slug;
    if (!operation) return jsonError("no operation specified", 400);

    const args = body.args ?? defaultTestArgs(def.slug, operation);

    const result = await requestExternalAction(sql, {
      hiveId: install.hiveId as string,
      installId: id,
      operation,
      args,
      actor: "owner-test",
    });

    return jsonOk(result);
  } catch (err) {
    console.error("[api/connector-installs/:id/test]", err);
    return jsonError("Test failed", 500);
  }
}

function defaultTestArgs(
  connectorSlug: string,
  operation: string,
): Record<string, unknown> {
  if (connectorSlug === "discord-webhook" && operation === "send_message") {
    return {
      content: "👋 Test ping from HiveWright — your connector is wired up.",
    };
  }
  return {};
}
