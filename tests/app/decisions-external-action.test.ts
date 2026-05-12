import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestExternalAction } from "@/actions/external-actions";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import { executeApprovedConnectorAction } from "@/connectors/runtime";
import { testSql as sql, truncateAll } from "../_lib/test-db";

vi.mock("@/connectors/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/connectors/runtime")>();
  return {
    ...actual,
    executeApprovedConnectorAction: vi.fn(),
  };
});

const HIVE = "10000000-0000-4000-8000-000000000001";
const INSTALL = "10000000-0000-4000-8000-000000000002";

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = "external-action-decision-test-key";
  vi.mocked(executeApprovedConnectorAction).mockReset();
  vi.mocked(executeApprovedConnectorAction).mockResolvedValue({
    success: true,
    data: { ok: true, confirmation: "sent", apiKey: "should-redact" },
    durationMs: 4,
  } as never);

  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'external-action-decisions', 'External Action Decisions', 'digital')
  `;
  await sql`
    INSERT INTO connector_installs (id, hive_id, connector_slug, display_name, config, status)
    VALUES (${INSTALL}, ${HIVE}::uuid, 'http-webhook', 'Test webhook', ${sql.json({ url: "https://example.test/webhook" })}, 'active')
  `;
});

function respondReq(decisionId: string, body: object) {
  return respondToDecision(
    new Request(`http://localhost/api/decisions/${decisionId}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: decisionId }) },
  );
}

async function createApprovalRequest() {
  const requested = await requestExternalAction(sql, {
    hiveId: HIVE,
    installId: INSTALL,
    operation: "post_json",
    args: { payload: { message: "hello" } },
    actor: { type: "role", id: "dev-agent", roleSlug: "dev-agent" },
  });
  expect(requested.status).toBe("awaiting_approval");
  expect(requested.decisionId).toBeTruthy();
  return requested as typeof requested & { decisionId: string };
}

describe("POST /api/decisions/[id]/respond — external action approvals", () => {
  it("executes the linked external action once when the approve option resolves the decision", async () => {
    const requested = await createApprovalRequest();

    const res = await respondReq(requested.decisionId, { selectedOptionKey: "approve" });

    expect(res.status).toBe(200);
    expect(executeApprovedConnectorAction).toHaveBeenCalledTimes(1);
    const connectorCall = vi.mocked(executeApprovedConnectorAction).mock.calls[0];
    expect(connectorCall[1]).toMatchObject({
      installId: INSTALL,
      operation: "post_json",
      args: { payload: { message: "hello" } },
      actor: "test-user",
    });

    const [action] = await sql<{ state: string; response_payload: Record<string, unknown>; reviewed_by: string | null }[]>`
      SELECT state, response_payload, reviewed_by
      FROM external_action_requests
      WHERE id = ${requested.requestId}
    `;
    expect(action.state).toBe("succeeded");
    expect(action.reviewed_by).toBe("test-user");
    expect(action.response_payload).toEqual({ ok: true, confirmation: "sent", apiKey: "[REDACTED]" });

    const again = await respondReq(requested.decisionId, { selectedOptionKey: "approve" });
    expect(again.status).toBe(200);
    const againBody = await again.json();
    expect(againBody.data.externalActionResult).toMatchObject({ requestId: requested.requestId, status: "succeeded" });
    expect(executeApprovedConnectorAction).toHaveBeenCalledTimes(1);
  });

  it("marks the linked external action rejected when the reject option resolves the decision", async () => {
    const requested = await createApprovalRequest();

    const res = await respondReq(requested.decisionId, { selectedOptionKey: "reject" });

    expect(res.status).toBe(200);
    expect(executeApprovedConnectorAction).not.toHaveBeenCalled();
    const [action] = await sql<{ state: string; reviewed_by: string | null }[]>`
      SELECT state, reviewed_by
      FROM external_action_requests
      WHERE id = ${requested.requestId}
    `;
    expect(action).toMatchObject({ state: "rejected", reviewed_by: "test-user" });
  });

  it("rejects mismatched approve option and rejected response without resolving the action", async () => {
    const requested = await createApprovalRequest();

    const res = await respondReq(requested.decisionId, {
      selectedOptionKey: "approve",
      response: "rejected",
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("must match selectedOptionKey");
    expect(executeApprovedConnectorAction).not.toHaveBeenCalled();
    const [action] = await sql<{ state: string }[]>`
      SELECT state
      FROM external_action_requests
      WHERE id = ${requested.requestId}
    `;
    const [decision] = await sql<{ status: string }[]>`
      SELECT status
      FROM decisions
      WHERE id = ${requested.decisionId}
    `;
    expect(action.state).toBe("awaiting_approval");
    expect(decision.status).toBe("pending");
  });

  it("rejects mismatched reject option and approved response without resolving the action", async () => {
    const requested = await createApprovalRequest();

    const res = await respondReq(requested.decisionId, {
      selectedOptionKey: "reject",
      response: "approved",
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("must match selectedOptionKey");
    expect(executeApprovedConnectorAction).not.toHaveBeenCalled();
    const [action] = await sql<{ state: string }[]>`
      SELECT state
      FROM external_action_requests
      WHERE id = ${requested.requestId}
    `;
    const [decision] = await sql<{ status: string }[]>`
      SELECT status
      FROM decisions
      WHERE id = ${requested.decisionId}
    `;
    expect(action.state).toBe("awaiting_approval");
    expect(decision.status).toBe("pending");
  });

  it("rejects external approval options that alias approval by label instead of exact key", async () => {
    const requested = await createApprovalRequest();
    await sql`
      UPDATE decisions
      SET options = ${sql.json([{ key: "foo", label: "Approve" }, { key: "reject", label: "Reject" }])}
      WHERE id = ${requested.decisionId}
    `;

    const res = await respondReq(requested.decisionId, { selectedOptionKey: "foo" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("must match selectedOptionKey");
    expect(executeApprovedConnectorAction).not.toHaveBeenCalled();
    const [action] = await sql<{ state: string }[]>`
      SELECT state
      FROM external_action_requests
      WHERE id = ${requested.requestId}
    `;
    const [decision] = await sql<{ status: string }[]>`
      SELECT status
      FROM decisions
      WHERE id = ${requested.decisionId}
    `;
    expect(action.state).toBe("awaiting_approval");
    expect(decision.status).toBe("pending");
  });

  it("rejects external approval options that use mixed-case approval keys", async () => {
    const requested = await createApprovalRequest();
    await sql`
      UPDATE decisions
      SET options = ${sql.json([{ key: "Approve", label: "Approve" }, { key: "reject", label: "Reject" }])}
      WHERE id = ${requested.decisionId}
    `;

    const res = await respondReq(requested.decisionId, { selectedOptionKey: "Approve" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("must match selectedOptionKey");
    expect(executeApprovedConnectorAction).not.toHaveBeenCalled();
    const [action] = await sql<{ state: string }[]>`
      SELECT state
      FROM external_action_requests
      WHERE id = ${requested.requestId}
    `;
    const [decision] = await sql<{ status: string }[]>`
      SELECT status
      FROM decisions
      WHERE id = ${requested.decisionId}
    `;
    expect(action.state).toBe("awaiting_approval");
    expect(decision.status).toBe("pending");
  });

  it("returns a clear error without resolving when an approval decision has no valid linked action id", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, title, context, recommendation, options,
        priority, status, kind, route_metadata
      ) VALUES (
        ${HIVE},
        'Approve missing action?',
        'This fixture lacks an external action request id.',
        null,
        ${sql.json([{ key: "approve", label: "Approve" }, { key: "reject", label: "Reject" }])},
        'normal',
        'pending',
        'external_action_approval',
        ${sql.json({ externalActionRequestId: "not-a-uuid" })}
      )
      RETURNING id
    `;

    const res = await respondReq(decision.id, { selectedOptionKey: "approve" });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("external action request");
    expect(executeApprovedConnectorAction).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string }[]>`SELECT status FROM decisions WHERE id = ${decision.id}`;
    expect(row.status).toBe("pending");
  });
});
