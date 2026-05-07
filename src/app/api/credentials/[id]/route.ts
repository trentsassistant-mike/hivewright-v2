import { sql } from "../../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../../_lib/auth";
import { deleteCredential } from "@/credentials/manager";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
} from "@/audit/agent-events";

/**
 * Hard-delete a credential. Default behaviour: refuse with 409 Conflict if
 * any connector_install row references this credential, returning the
 * blocking installs in the response body so the dashboard can show the
 * owner exactly what's in the way.
 *
 * Pass `?force=true` to delete anyway. The connector_install rows survive
 * but the FK is ON DELETE SET NULL, so they lose their credential pointer
 * and become inert (the connector runtime will refuse to fire when
 * loadCredentials returns nothing). This matches the "Disconnect ≠ Delete"
 * stance from the security review.
 */
// Per-handler authorization (audit d20f7b46): deletion destroys system
// secrets and (under ?force=true) orphans connector installs, so session
// presence alone is insufficient. requireApiAuth() is retained as
// defense-in-depth on top of src/proxy.ts; requireSystemOwner() adds the
// privileged-role gate so only owners can tear down credentials.
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const { id } = await ctx.params;
    if (!id) return jsonError("id is required", 400);

    const params = parseSearchParams(request.url);
    const force = params.get("force") === "true";

    // Confirm the credential exists before doing anything else so we return
    // the right status code (404 vs 409 vs 200).
    const [exists] = await sql`SELECT id, hive_id, name, key FROM credentials WHERE id = ${id}`;
    if (!exists) return jsonError("Credential not found", 404);

    if (!force) {
      const installs = await sql`
        SELECT id, connector_slug AS "connectorSlug", display_name AS "displayName", hive_id AS "hiveId"
        FROM connector_installs
        WHERE credential_id = ${id}
      `;
      if (installs.length > 0) {
        return new Response(
          JSON.stringify({
            error: "Credential is in use by connector installs",
            blockedBy: installs,
            hint: "Remove the listed connector installs first, or DELETE again with ?force=true to orphan them.",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
    }

    const { deleted } = await deleteCredential(sql, id);
    if (!deleted) return jsonError("Credential not found", 404);

    await recordAgentAuditEventBestEffort(sql, {
      actor: { type: "owner", id: authz.user.id, label: authz.user.email },
      eventType: AGENT_AUDIT_EVENTS.credentialRevokedByOwner,
      hiveId: (exists.hive_id as string | null) ?? null,
      targetType: "credential",
      targetId: id,
      outcome: "success",
      metadata: {
        credentialKey: exists.key,
        credentialName: exists.name,
        force,
      },
    });
    return jsonOk({ deleted: true, id, force });
  } catch (err) {
    console.error("[api/credentials DELETE]", err);
    return jsonError("Failed to delete credential", 500);
  }
}
