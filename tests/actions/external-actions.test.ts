import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeApprovedExternalAction,
  rejectExternalAction,
  requestExternalAction,
} from "@/actions/external-actions";
import { invokeConnector, type InvokeResult } from "@/connectors/runtime";
import type { ExternalActionSql } from "@/actions/external-actions";

vi.mock("@/connectors/runtime", () => ({
  invokeConnector: vi.fn(),
}));

type RequestRow = Record<string, unknown>;
type DecisionRow = Record<string, unknown>;
type PolicyRow = Record<string, unknown>;

class FakeSql {
  installs = new Map<string, RequestRow>();
  policies: PolicyRow[] = [];
  requests = new Map<string, RequestRow>();
  decisions = new Map<string, DecisionRow>();
  nextRequest = 1;
  nextDecision = 1;

  tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();

    if (query.includes("FROM connector_installs") && query.includes("WHERE id = ?")) {
      const row = this.installs.get(String(values[0]));
      return row ? [row] : [];
    }

    if (query.includes("FROM action_policies")) {
      const hiveId = values[0];
      return this.policies.filter((policy) => policy.hive_id === hiveId || policy.hiveId === hiveId);
    }

    if (query.includes("FROM external_action_requests") && query.includes("idempotency_key")) {
      const [hiveId, key] = values;
      return Array.from(this.requests.values()).filter((row) => row.hive_id === hiveId && row.idempotency_key === key).slice(0, 1);
    }

    if (query.startsWith("INSERT INTO external_action_requests")) {
      const id = `request-${this.nextRequest++}`;
      const row = {
        id,
        hive_id: values[0],
        task_id: values[1],
        goal_id: values[2],
        connector: values[3],
        operation: values[4],
        role_slug: values[5],
        state: values[6],
        idempotency_key: values[7],
        request_payload: values[8],
        policy_id: values[9],
        policy_snapshot: values[10],
        execution_metadata: values[11],
        encrypted_execution_payload: values[12],
        requested_by: values[13],
        decision_id: null,
        response_payload: {},
        error_message: null,
      };
      this.requests.set(id, row);
      return [row];
    }

    if (query.startsWith("INSERT INTO decisions")) {
      const id = `decision-${this.nextDecision++}`;
      const row = {
        id,
        hive_id: values[0],
        goal_id: values[1],
        task_id: values[2],
        title: values[3],
        context: values[4],
        recommendation: values[5],
        options: values[6],
        priority: values[7],
        status: values[8],
        kind: values[9],
        route_metadata: values[10],
      };
      this.decisions.set(id, row);
      return [row];
    }

    if (query.startsWith("UPDATE external_action_requests") && query.includes("SET decision_id = ?")) {
      const [decisionId, state, requestId] = values;
      const row = this.requests.get(String(requestId));
      if (!row) return [];
      row.decision_id = decisionId;
      row.state = state;
      return [row];
    }

    if (query.startsWith("UPDATE external_action_requests") && query.includes("state = ?") && query.includes("response_payload = ?")) {
      const [state, responsePayload, errorMessage, requestId] = values;
      const row = this.requests.get(String(requestId));
      if (!row) return [];
      row.state = state;
      row.response_payload = responsePayload;
      row.error_message = errorMessage;
      return [row];
    }

    if (query.includes("FROM external_action_requests") && query.includes("WHERE id = ?")) {
      const row = this.requests.get(String(values[0]));
      return row ? [row] : [];
    }

    if (query.includes("FROM decisions") && query.includes("WHERE id = ?")) {
      const row = this.decisions.get(String(values[0]));
      return row ? [row] : [];
    }

    if (query.startsWith("UPDATE external_action_requests") && query.includes("state = 'executing'")) {
      const row = this.requests.get(String(values[1]));
      if (!row || !["awaiting_approval", "approved"].includes(String(row.state))) return [];
      row.state = "executing";
      row.reviewed_by = values[0];
      return [row];
    }

    if (query.startsWith("UPDATE external_action_requests") && query.includes("state = 'rejected'")) {
      const row = this.requests.get(String(values[1]));
      if (!row) return [];
      if (["succeeded", "failed", "executing"].includes(String(row.state))) return [row];
      row.state = "rejected";
      row.reviewed_by = values[0];
      return [row];
    }

    throw new Error(`Unhandled SQL: ${query}`);
  };

  begin = async <T>(fn: (tx: typeof this.tag) => Promise<T>): Promise<T> => fn(this.tag);
}

const hiveId = "00000000-0000-0000-0000-000000000001";
const installId = "00000000-0000-0000-0000-000000000002";

function makeSql() {
  const fake = new FakeSql();
  (fake.tag as typeof fake.tag & { json: (value: unknown) => unknown }).json = (value: unknown) => value;
  fake.installs.set(installId, {
    id: installId,
    hive_id: hiveId,
    connector_slug: "http-webhook",
    status: "active",
  });
  return fake;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    hiveId,
    installId,
    operation: "post_json",
    args: { payload: { message: "hello", token: "secret-token" }, authHeader: "Bearer secret" },
    actor: { type: "role", id: "researcher", roleSlug: "researcher" },
    ...overrides,
  };
}

describe("external action service", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = "external-action-test-key";
    vi.mocked(invokeConnector).mockReset();
    vi.mocked(invokeConnector).mockResolvedValue({ success: true, data: { ok: true, secret: "hide" }, durationMs: 5 });
  });

  it("blocks requests without invoking the connector and records redacted payloads", async () => {
    const fake = makeSql();
    fake.policies.push({ id: "policy-block", hive_id: hiveId, connector: "http-webhook", operation: "post_json", effect: "block", role_slug: null });

    const result = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput());

    expect(result.status).toBe("blocked");
    expect(invokeConnector).not.toHaveBeenCalled();
    const row = fake.requests.get(result.requestId)!;
    expect(row.state).toBe("blocked");
    const requestPayload = row.request_payload as { args: Record<string, unknown> };
    expect(requestPayload.args).toEqual({
      payload: { message: "hello", token: "[REDACTED]" },
      authHeader: "[REDACTED]",
    });
  });

  it("creates an approval decision and does not invoke while awaiting approval", async () => {
    const fake = makeSql();

    const result = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput());

    expect(result.status).toBe("awaiting_approval");
    expect(invokeConnector).not.toHaveBeenCalled();
    expect(result.decisionId).toBe("decision-1");
    expect(fake.decisions.get("decision-1")?.kind).toBe("external_action_approval");
    const routeMetadata = fake.decisions.get("decision-1")?.route_metadata as { externalActionRequestId: string };
    expect(routeMetadata.externalActionRequestId).toBe(result.requestId);
    expect(fake.requests.get(result.requestId)?.decision_id).toBe("decision-1");
    const row = fake.requests.get(result.requestId)!;
    expect(row.policy_id).toBeNull();
    expect(row.encrypted_execution_payload).toEqual(expect.any(String));
    expect((row.request_payload as { args: Record<string, unknown> }).args.authHeader).toBe("[REDACTED]");
  });

  it("executes allowed requests immediately once and records redacted response", async () => {
    const fake = makeSql();
    fake.policies.push({ id: "policy-allow", hive_id: hiveId, connector: "http-webhook", operation: "post_json", effect: "allow", role_slug: "researcher" });

    const result = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput({ idempotencyKey: "once" }));

    expect(result.status).toBe("succeeded");
    expect(invokeConnector).toHaveBeenCalledTimes(1);
    expect(invokeConnector).toHaveBeenCalledWith(fake.tag, expect.objectContaining({
      installId,
      operation: "post_json",
      args: { payload: { message: "hello", token: "secret-token" }, authHeader: "Bearer secret" },
    }));
    expect(fake.requests.get(result.requestId)?.response_payload).toEqual({ ok: true, secret: "[REDACTED]" });

    const again = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput({ idempotencyKey: "once" }));
    expect(again.requestId).toBe(result.requestId);
    expect(invokeConnector).toHaveBeenCalledTimes(1);
  });

  it("executes an approved request once even when called twice", async () => {
    const fake = makeSql();
    const requested = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput());
    const decision = fake.decisions.get(requested.decisionId!)!;
    decision.status = "resolved";
    decision.selected_option_key = "approve";

    const first = await executeApprovedExternalAction(fake.tag as unknown as ExternalActionSql, { requestId: requested.requestId, actor: "owner" });
    const second = await executeApprovedExternalAction(fake.tag as unknown as ExternalActionSql, { requestId: requested.requestId, actor: "owner" });

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(invokeConnector).toHaveBeenCalledTimes(1);
    expect(invokeConnector).toHaveBeenCalledWith(fake.tag, expect.objectContaining({
      installId,
      operation: "post_json",
      args: { payload: { message: "hello", token: "secret-token" }, authHeader: "Bearer secret" },
    }));
  });

  it("does not execute an approval selected on a non-final decision", async () => {
    const fake = makeSql();
    const requested = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput());
    const decision = fake.decisions.get(requested.decisionId!)!;
    decision.status = "pending";
    decision.selected_option_key = "approve";

    await expect(executeApprovedExternalAction(fake.tag as unknown as ExternalActionSql, { requestId: requested.requestId, actor: "owner" }))
      .rejects.toThrow("is not approved");
    expect(invokeConnector).not.toHaveBeenCalled();
  });

  it("records failed executions with error and redacted response payload", async () => {
    const fake = makeSql();
    fake.policies.push({ id: "policy-allow", hive_id: hiveId, connector: "http-webhook", operation: "post_json", effect: "allow", role_slug: null });
    vi.mocked(invokeConnector).mockResolvedValue({ success: false, error: "api token=secret-token bad", data: { apiKey: "secret" }, durationMs: 3 } satisfies InvokeResult);

    const result = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput());

    expect(result.status).toBe("failed");
    const row = fake.requests.get(result.requestId)!;
    expect(row.error_message).toBe("api token=[REDACTED] bad");
    expect(row.response_payload).toEqual({ error: "api token=[REDACTED] bad", data: { apiKey: "[REDACTED]" } });
  });

  it("rejects an approval request idempotently without invoking", async () => {
    const fake = makeSql();
    const requested = await requestExternalAction(fake.tag as unknown as ExternalActionSql, baseInput());

    await rejectExternalAction(fake.tag as unknown as ExternalActionSql, { requestId: requested.requestId, actor: "owner" });
    await rejectExternalAction(fake.tag as unknown as ExternalActionSql, { requestId: requested.requestId, actor: "owner" });

    expect(fake.requests.get(requested.requestId)?.state).toBe("rejected");
    expect(invokeConnector).not.toHaveBeenCalled();
  });
});
