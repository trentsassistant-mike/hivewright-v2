import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { storeCredential } from "@/credentials/manager";
import { canonicalConnectorPayloadHash, executeApprovedConnectorAction, invokeConnector, loadConnectorInstall } from "@/connectors/runtime";
import { setHttpWebhookDnsLookupForTests } from "@/connectors/http-webhook-safety";

const BIZ = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${BIZ}, 'ctest-biz', 'Connector Test', 'digital')
  `;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

afterEach(() => {
  setHttpWebhookDnsLookupForTests(null);
  vi.restoreAllMocks();
});

async function createApprovedExternalActionRequest(input: {
  installId: string;
  connector: string;
  operation: string;
  args?: Record<string, unknown>;
  actor?: string;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO external_action_requests (
      hive_id, connector, operation, role_slug, state, request_payload_hash,
      request_payload, policy_snapshot, execution_metadata, requested_by
    )
    VALUES (
      ${BIZ}::uuid, ${input.connector}, ${input.operation}, ${null},
      'approved', ${canonicalConnectorPayloadHash(input.args ?? {})},
      ${sql.json(JSON.parse(JSON.stringify({ args: input.args ?? {} })))}, ${sql.json({ approvedForTest: true })},
      ${sql.json({ installId: input.installId })}, ${input.actor ?? "agent-test"}
    )
    RETURNING id
  `;
  return row.id;
}

async function invokeApprovedConnector(input: {
  installId: string;
  connector: string;
  operation: string;
  args?: Record<string, unknown>;
  actor?: string;
}) {
  const requestId = await createApprovedExternalActionRequest(input);
  return executeApprovedConnectorAction(sql, {
    installId: input.installId,
    operation: input.operation,
    args: input.args,
    actor: input.actor,
    approvedExternalActionRequestId: requestId,
  });
}

describe("invokeConnector(discord-webhook, send_message)", () => {
  async function installDiscord(webhookUrl: string): Promise<string> {
    const cred = await storeCredential(sql, {
      hiveId: BIZ,
      name: "Discord webhook: test",
      key: `connector:discord-webhook:${Date.now()}`,
      value: JSON.stringify({ webhookUrl }),
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id, granted_scopes)
      VALUES (${BIZ}::uuid, 'discord-webhook', 'Test webhook',
              ${sql.json({ defaultUsername: "HiveWright QA" })},
              ${cred.id},
              ${sql.json(["discord-webhook:test_connection", "discord-webhook:send_message"])})
      RETURNING id
    `;
    return row.id;
  }

  it("calls the webhook URL and logs a success event", async () => {
    const installId = await installDiscord("https://discord.test/webhooks/xyz");

    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const directResult = await invokeConnector(sql, {
      installId,
      operation: "send_message",
      args: { content: "hello world" },
      actor: "owner-test",
    });
    expect(directResult.success).toBe(false);
    expect(directResult.error).toMatch(/requires an approved external action request/);
    expect(fetchMock).not.toHaveBeenCalled();

    const result = await invokeApprovedConnector({
      installId,
      connector: "discord-webhook",
      operation: "send_message",
      args: { content: "hello world" },
      actor: "owner-test",
    });

    if (!result.success) {
      // Surface the real error so the test output is useful.
      throw new Error(`invokeConnector failed: ${result.error}`);
    }
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.test/webhooks/xyz");
    const body = JSON.parse(init.body as string);
    expect(body.content).toBe("hello world");
    expect(body.username).toBe("HiveWright QA");

    const [evt] = await sql`
      SELECT status, operation, actor FROM connector_events
      WHERE install_id = ${installId} ORDER BY id DESC LIMIT 1
    `;
    expect(evt.status).toBe("success");
    expect(evt.operation).toBe("send_message");
    expect(evt.actor).toBe("owner-test");

    const auditEvents = await sql<{ event_type: string; metadata_text: string }[]>`
      SELECT event_type, metadata::text AS metadata_text
      FROM agent_audit_events
      WHERE target_type = 'connector_install'
        AND target_id = ${installId}
      ORDER BY created_at ASC
    `;
    expect(auditEvents.map((event) => event.event_type)).toContain("connector.token_used");
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).toContain("discord-webhook");
    expect(serializedAudit).not.toContain("https://discord.test/webhooks/xyz");
    expect(serializedAudit).not.toContain(TEST_ENCRYPTION_KEY);
  });

  it("blocks operations when the install has not granted the operation scope", async () => {
    const installId = await installDiscord("https://discord.test/webhooks/no-scope");
    await sql`
      UPDATE connector_installs
      SET granted_scopes = ${sql.json(["discord-webhook:test_connection"])}
      WHERE id = ${installId}
    `;

    const requestId = await createApprovedExternalActionRequest({
      installId,
      connector: "discord-webhook",
      operation: "send_message",
      args: { content: "hello" },
    });

    const result = await executeApprovedConnectorAction(sql, {
      installId,
      operation: "send_message",
      args: { content: "hello" },
      approvedExternalActionRequestId: requestId,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ungranted connector scope/);
  });

  it("hashes sensitive payload fields so approved actions cannot swap them after approval", () => {
    const approved = canonicalConnectorPayloadHash({ content: "hello", authHeader: "Bearer one" });
    const tampered = canonicalConnectorPayloadHash({ content: "hello", authHeader: "Bearer two" });
    expect(tampered).not.toBe(approved);
    expect(canonicalConnectorPayloadHash({ _accessToken: "one", content: "hello" })).toBe(
      canonicalConnectorPayloadHash({ _accessToken: "two", content: "hello" }),
    );
  });

  it("audits direct connector secret loads without logging secret material", async () => {
    const webhookUrl = "https://discord.test/webhooks/direct-load";
    const installId = await installDiscord(webhookUrl);

    const install = await loadConnectorInstall(sql, BIZ, "discord-webhook", {
      actor: { type: "service", id: "voice-token-route" },
      requestId: "req-direct-load",
    });

    expect(install?.installId).toBe(installId);
    expect(install?.secrets.webhookUrl).toBe(webhookUrl);

    const auditEvents = await sql<{ event_type: string; metadata_text: string }[]>`
      SELECT event_type, metadata::text AS metadata_text
      FROM agent_audit_events
      WHERE target_id = ${installId}
      ORDER BY created_at ASC
    `;
    expect(auditEvents.map((event) => event.event_type)).toEqual([
      "connector.token_used",
    ]);
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).toContain("discord-webhook");
    expect(serializedAudit).toContain("[REDACTED]");
    expect(serializedAudit).not.toContain(webhookUrl);
    expect(serializedAudit).not.toContain(TEST_ENCRYPTION_KEY);
  });

  it("records an error event when the webhook returns non-2xx", async () => {
    const installId = await installDiscord("https://discord.test/webhooks/bad");

    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "discord-webhook",
      operation: "send_message",
      args: { content: "hi" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/404/);

    const [evt] = await sql`
      SELECT status, error_text FROM connector_events
      WHERE install_id = ${installId} ORDER BY id DESC LIMIT 1
    `;
    expect(evt.status).toBe("error");
    expect(evt.error_text as string).toMatch(/404/);
  });

  it("returns a structured error for an unknown install id", async () => {
    const result = await invokeConnector(sql, {
      installId: "00000000-0000-0000-0000-000000000000",
      operation: "send_message",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("returns error for unsupported operations on a real install", async () => {
    const installId = await installDiscord("https://discord.test/webhooks/x");
    const result = await invokeConnector(sql, {
      installId,
      operation: "no-such-op",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not supported/);

    const [evt] = await sql`
      SELECT status FROM connector_events
      WHERE install_id = ${installId} ORDER BY id DESC LIMIT 1
    `;
    expect(evt.status).toBe("error");
  });
});

describe("invokeConnector(http-webhook, post_json)", () => {
  async function installHttpWebhook(input: {
    url: string;
    allowedHostnames?: string;
    authHeader?: string;
  }): Promise<string> {
    const secretValues: Record<string, string> = { url: input.url };
    if (input.authHeader) secretValues.authHeader = input.authHeader;

    const cred = await storeCredential(sql, {
      hiveId: BIZ,
      name: "HTTP webhook: test",
      key: `connector:http-webhook:${Date.now()}`,
      value: JSON.stringify(secretValues),
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id, granted_scopes)
      VALUES (${BIZ}::uuid, 'http-webhook', 'Test HTTP webhook',
              ${sql.json({ allowedHostnames: input.allowedHostnames ?? "" })},
              ${cred.id},
              ${sql.json(["http-webhook:test_connection", "http-webhook:post_json"])})
      RETURNING id
    `;
    return row.id;
  }

  function mockDns(addresses: string[]) {
    const lookupMock = vi.fn(async () =>
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
    setHttpWebhookDnsLookupForTests(lookupMock);
    return lookupMock;
  }

  async function latestHttpWebhookAudit() {
    const [event] = await sql<{
      event_type: string;
      actor_type: string;
      actor_id: string;
      target_id: string;
      outcome: string;
      metadata: { error?: string };
    }[]>`
      SELECT event_type, actor_type, actor_id, target_id, outcome, metadata
      FROM agent_audit_events
      WHERE event_type = 'http_webhook_post'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return event;
  }

  it("blocks before DNS or fetch when Allowed hostnames is empty", async () => {
    const installId = await installHttpWebhook({ url: "https://hooks.example.com/path" });
    const lookupMock = mockDns(["93.184.216.34"]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{\"ok\":true}" },
      actor: "agent-test",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disabled until Allowed hostnames/i);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const audit = await latestHttpWebhookAudit();
    expect(audit.outcome).toBe("blocked");
    expect(audit.actor_type).toBe("agent");
    expect(audit.actor_id).toBe("agent-test");
    expect(audit.target_id).toBe("https://hooks.example.com/path");
  });

  it("blocks unallowlisted hostnames before DNS or fetch", async () => {
    const installId = await installHttpWebhook({
      url: "https://evil.example/hook",
      allowedHostnames: "hooks.example.com",
    });
    const lookupMock = mockDns(["93.184.216.34"]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{}" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in Allowed hostnames/);
    expect(lookupMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await latestHttpWebhookAudit()).outcome).toBe("blocked");
  });

  it.each([
    ["IPv4 loopback", "127.0.0.1"],
    ["RFC1918 10/8", "10.1.2.3"],
    ["RFC1918 172.16/12", "172.16.4.5"],
    ["RFC1918 192.168/16", "192.168.1.10"],
    ["link-local IPv4", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped IPv6 loopback", "::ffff:127.0.0.1"],
  ])("blocks %s DNS answers", async (_label, address) => {
    const installId = await installHttpWebhook({
      url: "https://hooks.example.com/hook",
      allowedHostnames: "hooks.example.com",
    });
    mockDns([address]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{}" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unsafe address/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await latestHttpWebhookAudit()).outcome).toBe("blocked");
  });

  it("blocks mixed DNS results when any address is unsafe", async () => {
    const installId = await installHttpWebhook({
      url: "https://hooks.example.com/hook",
      allowedHostnames: "hooks.example.com",
    });
    mockDns(["93.184.216.34", "10.0.0.7"]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{}" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/10\.0\.0\.7/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses redirects so redirect targets cannot bypass checks", async () => {
    const installId = await installHttpWebhook({
      url: "https://hooks.example.com/hook",
      allowedHostnames: "hooks.example.com",
    });
    mockDns(["93.184.216.34"]);
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/admin" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{}" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/redirects are not allowed/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0][1]).toEqual(expect.objectContaining({ redirect: "manual" }));
    expect((await latestHttpWebhookAudit()).outcome).toBe("error");
  });

  it("posts to an allowlisted public destination and audits success", async () => {
    const installId = await installHttpWebhook({
      url: "https://hooks.example.com/hook",
      allowedHostnames: "HOOKS.EXAMPLE.COM",
      authHeader: "Bearer test",
    });
    mockDns(["93.184.216.34"]);
    const fetchMock = vi.fn(async () => Response.json({ delivered: true }, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{\"message\":\"hello\"}" },
      actor: "agent-test",
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/hook");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test",
    });
    expect(init.body).toBe("{\"message\":\"hello\"}");
    expect(init.redirect).toBe("manual");
    const audit = await latestHttpWebhookAudit();
    expect(audit.event_type).toBe("http_webhook_post");
    expect(audit.outcome).toBe("success");
    expect(audit.target_id).toBe("https://hooks.example.com/hook");
  });

  it("audits error outcomes after a public allowlisted request fails", async () => {
    const installId = await installHttpWebhook({
      url: "https://hooks.example.com/hook",
      allowedHostnames: "hooks.example.com",
    });
    mockDns(["93.184.216.34"]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));

    const result = await invokeApprovedConnector({
      installId,
      connector: "http-webhook",
      operation: "post_json",
      args: { body: "{}" },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
    const audit = await latestHttpWebhookAudit();
    expect(audit.outcome).toBe("error");
    expect(audit.target_id).toBe("https://hooks.example.com/hook");
  });
});
