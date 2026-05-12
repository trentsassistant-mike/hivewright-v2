/**
 * In-code catalog of connectors HiveWright ships with. Each connector
 * declares:
 *   - metadata for the dashboard ("what is this? what does it do?")
 *   - `setupFields` — what the owner has to fill in to install it
 *   - `secretFields` — which of those fields are secrets (encrypted +
 *     stored in credentials; never echoed back to the dashboard)
 *   - `operations` — the typed calls an agent can make; each operation
 *     has a handler that receives (config, secrets, args) and returns the
 *     response. All handlers must throw on error so the runtime can record
 *     a failed event.
 *
 * Start set is intentionally tiny — one outbound messenger (Discord
 * webhook) to prove the whole plumbing end-to-end. Gmail / Xero / Stripe /
 * Meta Ads / Twilio / NewBook / Slack follow in the same shape.
 */

import { validateHttpWebhookDestination } from "./http-webhook-safety";

export type ConnectorAuthType = "api_key" | "oauth2" | "webhook" | "none";
export type ConnectorEffectType = "read" | "notify" | "write" | "financial" | "destructive" | "system";
export type ConnectorApprovalDefault = "allow" | "require_approval" | "block";
export type ConnectorRiskTier = "low" | "medium" | "high" | "critical";
export type ConnectorScopeKind = "read" | "write" | "send" | "admin" | "financial" | "pii";

export interface ConnectorScopeDeclaration {
  key: string;
  label: string;
  kind: ConnectorScopeKind;
  required: boolean;
  description?: string;
}

export interface ConnectorOperationInputSchema {
  type: "object";
  required?: string[];
  properties: Record<string, {
    type: "string" | "number" | "boolean" | "object" | "array";
    description?: string;
    enum?: string[];
    format?: string;
  }>;
}

export interface ConnectorOperationGovernance {
  effectType: ConnectorEffectType;
  defaultDecision: ConnectorApprovalDefault;
  riskTier: ConnectorRiskTier;
  scopes?: string[];
  summary?: string;
  dryRunSupported?: boolean;
  externalSideEffect?: boolean;
}

/**
 * OAuth2 tokens persisted per-install in the credentials table. Stored as
 * JSON in the encrypted `value` field. `expiresAt` is ISO 8601.
 */
export interface OAuth2TokenBundle {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  scope?: string;
}

export interface ConnectorSetupField {
  key: string;
  label: string;
  placeholder?: string;
  helpText?: string;
  type?: "text" | "url" | "password" | "textarea";
  required?: boolean;
}

export interface ConnectorOperation {
  slug: string;
  label: string;
  /** JSON-schema-ish argument spec for dashboard "Test" forms. */
  args?: ConnectorSetupField[];
  inputSchema: ConnectorOperationInputSchema;
  outputSummary: string;
  governance: ConnectorOperationGovernance;
  handler: (ctx: ConnectorInvocationContext) => Promise<unknown>;
}

/**
 * OAuth2 provider config. Present only on connectors where authType is
 * "oauth2". The client id/secret live in env (not the registry file) so
 * we can open-source the catalog without leaking credentials.
 */
export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Extra params appended to the authorize URL (e.g. access_type=offline for Google). */
  extraAuthorizeParams?: Record<string, string>;
}

export interface ConnectorDefinition {
  slug: string;
  name: string;
  category: "messaging" | "email" | "calendar" | "finance" | "crm" | "ads" | "payments" | "ops" | "ea" | "other";
  description: string;
  icon?: string; // emoji for now; real SVGs later
  authType: ConnectorAuthType;
  setupFields: ConnectorSetupField[];
  secretFields: string[];
  scopes: ConnectorScopeDeclaration[];
  operations: ConnectorOperation[];
  oauth?: OAuth2Config;
  testConnection?: (ctx: ConnectorInvocationContext) => Promise<unknown>;
  /**
   * Connectors that open a persistent listener inside the dispatcher
   * (e.g. the Discord-hosted EA) need a dispatcher restart before a
   * new install takes effect. Dashboard surfaces an "Activate" button
   * after successful install-and-test when this is true.
   */
  requiresDispatcherRestart?: boolean;
}

type ConnectorDefinitionDraft = Omit<ConnectorDefinition, "scopes" | "operations"> & {
  scopes?: ConnectorScopeDeclaration[];
  operations: ConnectorOperation[];
};

/**
 * Passed to every operation handler. `config` is the non-secret install
 * config, `secrets` holds decrypted credential values keyed the same way
 * as secretFields, `args` is the operation-specific payload.
 */
export interface ConnectorInvocationContext {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Discord webhook — outbound messaging. Pure URL + POST JSON. Zero OAuth
// setup; proves the runtime plumbing on something real.
// ---------------------------------------------------------------------
const discordWebhook: ConnectorDefinitionDraft = {
  slug: "discord-webhook",
  name: "Discord webhook",
  category: "messaging",
  description:
    "Send messages into a Discord channel using an incoming webhook URL. No bot, no OAuth — paste the webhook URL from Discord channel settings.",
  icon: "💬",
  authType: "webhook",
  setupFields: [
    {
      key: "webhookUrl",
      label: "Webhook URL",
      type: "password",
      placeholder: "https://discord.com/api/webhooks/...",
      helpText:
        "Channel Settings → Integrations → Webhooks → New Webhook → Copy URL",
      required: true,
    },
    {
      key: "defaultUsername",
      label: "Sender name (optional)",
      type: "text",
      placeholder: "HiveWright",
    },
  ],
  secretFields: ["webhookUrl"],
  operations: [
    {
      slug: "send_message",
      label: "Send a message",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string", description: "Message text" },
        },
      },
      outputSummary: "Posts a message to the configured Discord webhook channel.",
      governance: {
        effectType: "notify",
        defaultDecision: "require_approval",
        riskTier: "low",
        summary: "Posts a message to the configured Discord webhook channel.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "content", label: "Message text", type: "textarea", required: true },
      ],
      handler: async ({ secrets, config, args }) => {
        const url = secrets.webhookUrl;
        if (!url) throw new Error("webhookUrl missing — reinstall the connector");
        const content = typeof args.content === "string" ? args.content : "";
        if (!content) throw new Error("content is required");
        const body: Record<string, unknown> = { content };
        if (typeof config.defaultUsername === "string" && config.defaultUsername) {
          body.username = config.defaultUsername;
        }
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`Discord webhook returned ${res.status} ${res.statusText}`);
        }
        return { delivered: true, status: res.status };
      },
    },
  ],
};

// ---------------------------------------------------------------------
// Slack incoming webhook — identical shape to Discord. Separate connector
// so owners don't have to remember "post Slack via the Discord connector."
// ---------------------------------------------------------------------
const slackWebhook: ConnectorDefinitionDraft = {
  slug: "slack-webhook",
  name: "Slack webhook",
  category: "messaging",
  description:
    "Post messages to a Slack channel via a Slack Incoming Webhook URL. No OAuth — just paste the URL from your Slack app config.",
  icon: "💼",
  authType: "webhook",
  setupFields: [
    {
      key: "webhookUrl",
      label: "Webhook URL",
      type: "password",
      placeholder: "https://hooks.slack.com/services/...",
      required: true,
    },
    {
      key: "defaultChannel",
      label: "Channel override (optional)",
      type: "text",
      placeholder: "#hivewright",
    },
  ],
  secretFields: ["webhookUrl"],
  operations: [
    {
      slug: "send_message",
      label: "Send a message",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "Text" },
        },
      },
      outputSummary: "Posts a message to the configured Slack webhook channel.",
      governance: {
        effectType: "notify",
        defaultDecision: "require_approval",
        riskTier: "low",
        summary: "Posts a message to the configured Slack webhook channel.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "text", label: "Text", type: "textarea", required: true },
      ],
      handler: async ({ secrets, config, args }) => {
        const url = secrets.webhookUrl;
        if (!url) throw new Error("webhookUrl missing");
        const text = typeof args.text === "string" ? args.text : "";
        if (!text) throw new Error("text is required");
        const body: Record<string, unknown> = { text };
        if (typeof config.defaultChannel === "string" && config.defaultChannel) {
          body.channel = config.defaultChannel;
        }
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          throw new Error(`Slack webhook returned ${res.status} ${res.statusText}`);
        }
        return { delivered: true, status: res.status };
      },
    },
  ],
};

// ---------------------------------------------------------------------
// Generic HTTP webhook — for any outbound POST that expects a JSON body.
// Useful as a fallback when we don't have a dedicated connector for a
// service yet. Also lets agents hit internal webhooks (Zapier-like).
// ---------------------------------------------------------------------
const httpWebhook: ConnectorDefinitionDraft = {
  slug: "http-webhook",
  name: "Generic HTTP webhook",
  category: "other",
  description:
    "Send a JSON POST to any URL. Fallback for services that don't yet have a first-class connector.",
  icon: "🔗",
  authType: "webhook",
  setupFields: [
    { key: "url", label: "Target URL", type: "url", required: true },
    {
      key: "allowedHostnames",
      label: "Allowed hostnames",
      type: "textarea",
      placeholder: "hooks.zapier.com\napi.example.com",
      helpText:
        "Exact hostnames this hive may POST to. Leave empty to disable this connector.",
    },
    {
      key: "authHeader",
      label: "Authorization header (optional)",
      type: "password",
      placeholder: "Bearer xxxxx",
      helpText: "Sent as the Authorization header on every call.",
    },
  ],
  secretFields: ["url", "authHeader"],
  operations: [
    {
      slug: "post_json",
      label: "POST JSON",
      inputSchema: {
        type: "object",
        required: ["body"],
        properties: {
          body: { type: "object", description: "Body (JSON)" },
        },
      },
      outputSummary: "Sends a JSON POST to the configured HTTP endpoint.",
      governance: {
        effectType: "write",
        defaultDecision: "require_approval",
        riskTier: "medium",
        summary: "Sends a JSON POST to the configured HTTP endpoint.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "body", label: "Body (JSON)", type: "textarea", required: true },
      ],
      handler: async ({ config, secrets, args }) => {
        const url = secrets.url;
        if (!url) throw new Error("url missing");
        const destination = await validateHttpWebhookDestination(
          url,
          config.allowedHostnames,
        );
        const raw = typeof args.body === "string" ? args.body : "{}";
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("body must be valid JSON");
        }
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (secrets.authHeader) headers["Authorization"] = secrets.authHeader;
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(parsed),
          redirect: "manual",
        });
        if (res.status >= 300 && res.status < 400) {
          throw new Error("Webhook redirects are not allowed");
        }
        if (!res.ok) {
          throw new Error(`Webhook returned ${res.status} ${res.statusText}`);
        }
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          // non-JSON response is fine
        }
        return { status: res.status, data, hostname: destination.hostname };
      },
    },
  ],
};

// ---------------------------------------------------------------------
// SMTP email — outbound only. Uses the owner's own SMTP creds (Gmail,
// Outlook, Mailgun, SendGrid SMTP bridge, etc.) so we don't need OAuth.
// ---------------------------------------------------------------------
const smtpEmail: ConnectorDefinitionDraft = {
  slug: "smtp-email",
  name: "SMTP email",
  category: "email",
  description:
    "Send outbound email via any SMTP server (Gmail app password, Mailgun, SendGrid, Postmark…). App-password auth — no OAuth setup.",
  icon: "✉️",
  authType: "api_key",
  setupFields: [
    { key: "host", label: "SMTP host", type: "text", placeholder: "smtp.gmail.com", required: true },
    { key: "port", label: "Port", type: "text", placeholder: "465", required: true },
    { key: "secure", label: "Use TLS (true/false)", type: "text", placeholder: "true" },
    { key: "user", label: "Username", type: "text", required: true },
    { key: "password", label: "Password / app-password", type: "password", required: true },
    { key: "defaultFrom", label: "Default From: address", type: "text", placeholder: "ops@example.com", required: true },
  ],
  secretFields: ["password"],
  operations: [
    {
      slug: "send_email",
      label: "Send email",
      inputSchema: {
        type: "object",
        required: ["to", "subject", "body"],
        properties: {
          to: { type: "string", description: "To" },
          subject: { type: "string", description: "Subject" },
          body: { type: "object", description: "Body (plain text or HTML)" },
        },
      },
      outputSummary: "Sends an outbound email via the configured SMTP account.",
      governance: {
        effectType: "notify",
        defaultDecision: "require_approval",
        riskTier: "low",
        summary: "Sends an outbound email via the configured SMTP account.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "to", label: "To", type: "text", required: true },
        { key: "subject", label: "Subject", type: "text", required: true },
        { key: "body", label: "Body (plain text or HTML)", type: "textarea", required: true },
      ],
      handler: async ({ config, secrets, args }) => {
        const to = typeof args.to === "string" ? args.to : "";
        const subject = typeof args.subject === "string" ? args.subject : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!to || !subject || !body) {
          throw new Error("to, subject and body are required");
        }
        const host = String(config.host ?? "");
        const port = Number(config.port ?? 465);
        const secure = String(config.secure ?? "true").toLowerCase() !== "false";
        const user = String(config.user ?? "");
        const from = String(config.defaultFrom ?? user);
        const password = secrets.password;

        // Lazy-load nodemailer so the connectors module stays test-friendly
        // for unit tests that don't need real SMTP.
        const { default: nodemailer } = await import("nodemailer");
        const transporter = nodemailer.createTransport({
          host,
          port,
          secure,
          auth: { user, pass: password },
        });
        const info = await transporter.sendMail({
          from,
          to,
          subject,
          text: body.includes("<") ? undefined : body,
          html: body.includes("<") ? body : undefined,
        });
        return { messageId: info.messageId, accepted: info.accepted };
      },
    },
  ],
};

// ---------------------------------------------------------------------
// GitHub personal access token — for Cabin-Connect-style dev workflows.
// Read-only operations first so agents can summarise issues/PRs without
// write scope. Write operations (comment, create-issue) later.
// ---------------------------------------------------------------------
const githubPat: ConnectorDefinitionDraft = {
  slug: "github-pat",
  name: "GitHub (PAT)",
  category: "ops",
  description:
    "Read-only GitHub access via a personal access token. Lets dev/QA roles summarise issues and pull requests. Write ops will be added once permissions model is worked out.",
  icon: "🐙",
  authType: "api_key",
  setupFields: [
    { key: "token", label: "Personal access token", type: "password", required: true },
    { key: "defaultOwner", label: "Default org/user", type: "text", placeholder: "trentw" },
    { key: "defaultRepo", label: "Default repo", type: "text", placeholder: "cabin-connect" },
  ],
  secretFields: ["token"],
  operations: [
    {
      slug: "list_issues",
      label: "List open issues",
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          owner: { type: "string", description: "Owner" },
          repo: { type: "string", description: "Repo" },
          limit: { type: "number", description: "Limit (default 20)" },
        },
      },
      outputSummary: "Reads open issue metadata from the configured GitHub repository.",
      governance: {
        effectType: "read",
        defaultDecision: "allow",
        riskTier: "low",
        summary: "Reads open issue metadata from the configured GitHub repository.",
        dryRunSupported: false,
        externalSideEffect: false,
      },
      args: [
        { key: "owner", label: "Owner", type: "text" },
        { key: "repo", label: "Repo", type: "text" },
        { key: "limit", label: "Limit (default 20)", type: "text" },
      ],
      handler: async ({ config, secrets, args }) => {
        const owner = String(args.owner ?? config.defaultOwner ?? "");
        const repo = String(args.repo ?? config.defaultRepo ?? "");
        const limit = Number(args.limit ?? 20);
        if (!owner || !repo) throw new Error("owner and repo are required");
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${limit}`,
          {
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${secrets.token}`,
            },
          },
        );
        if (!res.ok) {
          throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as Array<{ number: number; title: string; html_url: string; user?: { login: string } }>;
        return data.map((i) => ({
          number: i.number,
          title: i.title,
          url: i.html_url,
          author: i.user?.login ?? null,
        }));
      },
    },
  ],
};

// ---------------------------------------------------------------------
// Stripe API key — read-only listings first. Payments/charges will be a
// separate write-scope operation with explicit owner decision.
// ---------------------------------------------------------------------
const stripe: ConnectorDefinitionDraft = {
  slug: "stripe",
  name: "Stripe",
  category: "payments",
  description:
    "Read-only Stripe access via secret key. Agents can list recent charges/customers; charge-creation is behind a separate owner decision.",
  icon: "💳",
  authType: "api_key",
  setupFields: [
    { key: "secretKey", label: "Stripe secret key", type: "password", placeholder: "sk_live_…", required: true },
  ],
  secretFields: ["secretKey"],
  operations: [
    {
      slug: "list_recent_charges",
      label: "List recent charges",
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          limit: { type: "number", description: "Limit (default 10)" },
        },
      },
      outputSummary: "Reads recent Stripe charge metadata without creating or modifying payments.",
      governance: {
        effectType: "financial",
        defaultDecision: "require_approval",
        riskTier: "high",
        summary: "Reads recent Stripe charge metadata without creating or modifying payments.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [{ key: "limit", label: "Limit (default 10)", type: "text" }],
      handler: async ({ secrets, args }) => {
        const limit = Number(args.limit ?? 10);
        const res = await fetch(
          `https://api.stripe.com/v1/charges?limit=${limit}`,
          { headers: { Authorization: `Bearer ${secrets.secretKey}` } },
        );
        if (!res.ok) {
          throw new Error(`Stripe returned ${res.status} ${res.statusText}`);
        }
        const body = (await res.json()) as {
          data: Array<{ id: string; amount: number; currency: string; status: string; created: number; description: string | null }>;
        };
        return body.data.map((c) => ({
          id: c.id,
          amount: c.amount,
          currency: c.currency,
          status: c.status,
          description: c.description,
          createdAt: new Date(c.created * 1000).toISOString(),
        }));
      },
    },
  ],
};

// ---------------------------------------------------------------------
// Twilio SMS — outbound text messages for customer comms / pager alerts.
// ---------------------------------------------------------------------
const twilioSms: ConnectorDefinitionDraft = {
  slug: "twilio-sms",
  name: "Twilio SMS",
  category: "messaging",
  description: "Send outbound SMS via Twilio using Account SID + Auth Token.",
  icon: "📱",
  authType: "api_key",
  setupFields: [
    { key: "accountSid", label: "Account SID", type: "password", required: true },
    { key: "authToken", label: "Auth Token", type: "password", required: true },
    { key: "fromNumber", label: "From number (E.164)", type: "text", placeholder: "+61400000000", required: true },
  ],
  secretFields: ["accountSid", "authToken"],
  operations: [
    {
      slug: "send_sms",
      label: "Send SMS",
      inputSchema: {
        type: "object",
        required: ["to", "body"],
        properties: {
          to: { type: "string", description: "To (E.164)" },
          body: { type: "object", description: "Message" },
        },
      },
      outputSummary: "Sends an outbound SMS via the configured Twilio account.",
      governance: {
        effectType: "notify",
        defaultDecision: "require_approval",
        riskTier: "low",
        summary: "Sends an outbound SMS via the configured Twilio account.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "to", label: "To (E.164)", type: "text", required: true },
        { key: "body", label: "Message", type: "textarea", required: true },
      ],
      handler: async ({ config, secrets, args }) => {
        const to = typeof args.to === "string" ? args.to : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!to || !body) throw new Error("to and body are required");
        const from = String(config.fromNumber ?? "");
        if (!from) throw new Error("fromNumber is not configured");
        const sid = secrets.accountSid;
        const token = secrets.authToken;
        const basic = Buffer.from(`${sid}:${token}`).toString("base64");
        const form = new URLSearchParams({ From: from, To: to, Body: body });
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${basic}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
        );
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Twilio returned ${res.status}: ${err.slice(0, 200)}`);
        }
        const data = (await res.json()) as { sid: string; status: string };
        return { sid: data.sid, status: data.status };
      },
    },
  ],
};

// ---------------------------------------------------------------------
// Voice EA — direct PCM-over-WebSocket from the PWA to the dispatcher,
// dispatcher to the GPU host for STT/TTS. Replaces the v1 `twilio-voice`
// connector (which carried Twilio Voice SDK credentials in addition to
// the GPU URL). The owner's existing install row keeps the same hive
// scope; migration `0097_voice_ea_connector_rename.sql` renames its slug
// and strips the orphaned Twilio fields.
// ---------------------------------------------------------------------
const voiceEa: ConnectorDefinitionDraft = {
  slug: "voice-ea",
  name: "Voice EA",
  category: "ea",
  description:
    "Voice interface for the EA. Captures mic in the PWA, streams PCM directly to the dispatcher and the GPU voice services. Tailnet-only — no Twilio, no public surface.",
  icon: "🎙️",
  authType: "api_key",
  setupFields: [
    {
      key: "voiceServicesUrl",
      label: "Voice services URL",
      type: "text",
      placeholder: "http://<gpu-ip>:8790",
      required: true,
      helpText:
        "Base URL of the GPU-hosted voice services (faster-whisper STT + Kokoro TTS + Pyannote voiceprint). Hostname:port; no trailing slash. Reachable over the tailnet from the dispatcher.",
    },
    {
      key: "maxMonthlyLlmCents",
      label: "Max monthly LLM spend (cents)",
      type: "text",
      placeholder: "0",
      helpText:
        "Optional safety cap for voice-call LLM spend. 0 or blank = no cap. When set, the EA verbally warns at 80%, downgrades to Sonnet at 100%, and hangs up at 120%.",
    },
  ],
  secretFields: [],
  operations: [
    {
      slug: "test_connection",
      label: "Test connection",
      inputSchema: {
        type: "object",
        required: [],
        properties: {},
      },
      outputSummary: "Checks connectivity to the configured voice services health endpoint.",
      governance: {
        effectType: "system",
        defaultDecision: "allow",
        riskTier: "low",
        summary: "Checks connectivity to the configured voice services health endpoint.",
        dryRunSupported: false,
        externalSideEffect: false,
      },
      args: [],
      handler: async ({ config }) => {
        const url = String(config.voiceServicesUrl ?? "").replace(/\/$/, "");
        if (!url) throw new Error("voiceServicesUrl is required");
        try {
          const res = await fetch(`${url}/health`);
          return {
            voiceServices: res.ok ? "ok" : `unreachable: ${res.status}`,
          };
        } catch (err) {
          throw new Error(
            `voice services unreachable: ${(err as Error).message}`,
          );
        }
      },
    },
  ],
};

// ---------------------------------------------------------------------
// Gmail (OAuth 2.0). Needs GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env vars
// from the Google Cloud Console OAuth credentials. Scopes cover sending
// email and reading thread metadata + message bodies. Refresh tokens are
// persisted so the connector keeps working past the hour-long access
// token lifetime.
// ---------------------------------------------------------------------
const gmail: ConnectorDefinitionDraft = {
  slug: "gmail",
  name: "Gmail",
  category: "email",
  description:
    "Send and read email as your Gmail account via OAuth. No app passwords; standard Google login flow.",
  icon: "📧",
  authType: "oauth2",
  setupFields: [],
  secretFields: [],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    clientIdEnv: "GMAIL_CLIENT_ID",
    clientSecretEnv: "GMAIL_CLIENT_SECRET",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  operations: [
    {
      slug: "list_threads",
      label: "List recent threads",
      inputSchema: {
        type: "object",
        required: [],
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "string", description: "Max results (default 10)" },
        },
      },
      outputSummary: "Reads recent Gmail thread metadata using the OAuth readonly scope.",
      governance: {
        effectType: "read",
        defaultDecision: "allow",
        riskTier: "low",
        summary: "Reads recent Gmail thread metadata using the OAuth readonly scope.",
        dryRunSupported: false,
        externalSideEffect: false,
      },
      args: [
        { key: "query", label: "Search query", type: "text", placeholder: "is:unread" },
        { key: "maxResults", label: "Max results (default 10)", type: "text" },
      ],
      handler: async ({ args }) => {
        // `args` has a `_accessToken` injected by the runtime when the
        // install is oauth2 (see connectors/runtime.ts).
        const token = String(args._accessToken ?? "");
        if (!token) throw new Error("access token unavailable");
        const q = typeof args.query === "string" ? args.query : "";
        const maxResults = Number(args.maxResults ?? 10);
        const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads");
        if (q) url.searchParams.set("q", q);
        url.searchParams.set("maxResults", String(maxResults));
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error(`gmail list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
        return await res.json();
      },
    },
    {
      slug: "send_email",
      label: "Send an email",
      inputSchema: {
        type: "object",
        required: ["to", "subject", "body"],
        properties: {
          to: { type: "string", description: "To" },
          subject: { type: "string", description: "Subject" },
          body: { type: "object", description: "Body" },
        },
      },
      outputSummary: "Sends an outbound email from the connected Gmail account.",
      governance: {
        effectType: "notify",
        defaultDecision: "require_approval",
        riskTier: "low",
        summary: "Sends an outbound email from the connected Gmail account.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "to", label: "To", type: "text", required: true },
        { key: "subject", label: "Subject", type: "text", required: true },
        { key: "body", label: "Body", type: "textarea", required: true },
      ],
      handler: async ({ args }) => {
        const token = String(args._accessToken ?? "");
        if (!token) throw new Error("access token unavailable");
        const to = typeof args.to === "string" ? args.to : "";
        const subject = typeof args.subject === "string" ? args.subject : "";
        const body = typeof args.body === "string" ? args.body : "";
        if (!to || !subject || !body) throw new Error("to, subject and body are required");

        const isHtml = body.includes("<");
        const raw = [
          `To: ${to}`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=utf-8`,
          "",
          body,
        ].join("\r\n");
        const encoded = Buffer.from(raw, "utf8")
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const res = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ raw: encoded }),
          },
        );
        if (!res.ok) {
          throw new Error(`gmail send failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
        }
        return await res.json();
      },
    },
  ],
};

// ---------------------------------------------------------------------
// HiveWright EA (Discord). Unlike the other connectors, this one is an
// *inbound* listener — the dispatcher opens a persistent gateway
// connection using the bot token and handles /status, /new, and
// free-form DMs/channel messages as the EA. Operations here are
// self-tests so the dashboard "Test connection" button can verify the
// bot credentials resolve before the owner walks away. The actual
// chat loop runs in src/ea/native/ (started by the dispatcher at
// startup, one handle per active install of this connector).
// ---------------------------------------------------------------------
const eaDiscord: ConnectorDefinitionDraft = {
  slug: "ea-discord",
  name: "HiveWright EA (Discord)",
  category: "messaging",
  description:
    "Hosts this hive's Executive Assistant on Discord. The dispatcher runs a bot that listens in the configured channel (and DMs), handles /status + /new slash commands, and replies to owner messages with full shell + HiveWright API access. Replaces the OpenClaw-gateway EA.",
  icon: "🐝",
  authType: "api_key",
  setupFields: [
    {
      key: "applicationId",
      label: "Discord Application ID",
      type: "text",
      placeholder: "1234567890...",
      helpText:
        "From the Discord developer portal → your app → General Information → Application ID.",
      required: true,
    },
    {
      key: "channelId",
      label: "Discord channel ID",
      type: "text",
      placeholder: "1234567890...",
      helpText:
        "Right-click the channel in Discord with Developer Mode on → Copy Channel ID.",
      required: true,
    },
    {
      key: "botToken",
      label: "Bot token",
      type: "password",
      placeholder: "MTA…",
      helpText:
        "From the bot's page in the Discord developer portal → Bot → Reset Token. Intents required: Message Content Intent.",
      required: true,
    },
    {
      key: "guildId",
      label: "Guild (server) ID — optional",
      type: "text",
      placeholder: "1234567890…",
      helpText:
        "If set, slash commands register to that guild only and propagate instantly. Unset = global registration (~1 hour propagation).",
    },
    {
      key: "model",
      label: "Model — optional",
      type: "text",
      placeholder: "openai-codex/<model-id>",
      helpText: "Optional runtime model override. Leave blank to use the configured runtime default.",
    },
  ],
  secretFields: ["botToken"],
  requiresDispatcherRestart: true,
  operations: [
    {
      slug: "self_test",
      label: "Test connection",
      inputSchema: {
        type: "object",
        required: [],
        properties: {},
      },
      outputSummary: "Verifies the Discord bot token and returns configured EA connection details.",
      governance: {
        effectType: "system",
        defaultDecision: "allow",
        riskTier: "low",
        summary: "Verifies the Discord bot token and returns configured EA connection details.",
        dryRunSupported: false,
        externalSideEffect: false,
      },
      args: [],
      handler: async ({ config, secrets }) => {
        const token = secrets.botToken;
        if (!token) throw new Error("botToken missing");
        const res = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${token}` },
        });
        if (!res.ok) {
          throw new Error(`Discord /users/@me returned ${res.status} ${res.statusText}`);
        }
        const me = (await res.json()) as { id: string; username: string };
        return {
          botId: me.id,
          botUsername: me.username,
          applicationId: config.applicationId,
          channelId: config.channelId,
          note: "After saving, restart the dispatcher to take the EA online. The dispatcher auto-registers /status and /new on startup.",
        };
      },
    },
    {
      slug: "send_channel",
      label: "Send Discord channel message",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: {
          content: { type: "string", description: "Message text" },
        },
      },
      outputSummary: "Posts a system/EA notification to the configured Discord channel through the EA bot.",
      governance: {
        effectType: "notify",
        defaultDecision: "require_approval",
        riskTier: "low",
        summary: "Posts a system/EA notification to the configured Discord channel through the EA bot.",
        dryRunSupported: false,
        externalSideEffect: true,
      },
      args: [
        { key: "content", label: "Message text", type: "textarea", required: true },
      ],
      handler: async ({ config, secrets, args }) => {
        const token = secrets.botToken;
        if (!token) throw new Error("botToken missing");
        const channelId = config.channelId;
        if (typeof channelId !== "string" || !channelId) throw new Error("channelId missing");
        const content = typeof args.content === "string" ? args.content : "";
        if (!content.trim()) throw new Error("content missing");
        const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`Discord returned ${res.status} ${res.statusText} ${detail}`.trim());
        }
        return { ok: true, channelId };
      },
    },
  ],
};

function defaultScopeKind(effectType: ConnectorEffectType): ConnectorScopeKind {
  if (effectType === "read" || effectType === "system") return "read";
  if (effectType === "notify") return "send";
  if (effectType === "financial") return "financial";
  if (effectType === "destructive") return "admin";
  return "write";
}

function normalizeConnector(connector: ConnectorDefinitionDraft): ConnectorDefinition {
  const generatedTestOperation: ConnectorOperation = {
    slug: "test_connection",
    label: "Test connection",
    args: [],
    inputSchema: { type: "object", properties: {} },
    outputSummary: "Returns connector installation health without performing external side effects.",
    governance: {
      effectType: "system",
      defaultDecision: "allow",
      riskTier: "low",
      summary: "Checks that the connector install is present and can be invoked by the health/test route.",
      dryRunSupported: false,
      externalSideEffect: false,
    },
    handler: connector.testConnection ?? (async () => ({ ok: true })),
  };
  const baseOperations: ConnectorOperation[] = connector.operations.some((op) => ["test_connection", "self_test"].includes(op.slug))
    ? connector.operations
    : [generatedTestOperation, ...connector.operations];
  const operationScopes = baseOperations.map((op) => ({
    key: `${connector.slug}:${op.slug}`,
    label: op.label,
    kind: defaultScopeKind(op.governance.effectType),
    required: op.governance.effectType === "read" || op.governance.effectType === "system",
    description: op.governance.summary,
  } satisfies ConnectorScopeDeclaration));
  const scopes = connector.scopes && connector.scopes.length > 0 ? connector.scopes : operationScopes;
  return {
    ...connector,
    scopes,
    operations: baseOperations.map((op) => {
      const scopeKey = `${connector.slug}:${op.slug}`;
      return {
        ...op,
        governance: {
          ...op.governance,
          scopes: op.governance.scopes ?? [scopeKey],
        },
      };
    }),
  };
}

export const CONNECTOR_REGISTRY: ConnectorDefinition[] = [
  discordWebhook,
  slackWebhook,
  httpWebhook,
  smtpEmail,
  githubPat,
  stripe,
  twilioSms,
  voiceEa,
  gmail,
  eaDiscord,
].map(normalizeConnector);

export function getConnectorDefinition(slug: string): ConnectorDefinition | undefined {
  return CONNECTOR_REGISTRY.find((c) => c.slug === slug);
}

/**
 * Dashboard-safe view of a connector: metadata only, never the handlers.
 * Drops `handler` functions from each operation so it can be sent over
 * JSON without blowing up.
 */
export function toPublicConnector(c: ConnectorDefinition) {
  const secretFields = new Set(c.secretFields);
  return {
    slug: c.slug,
    name: c.name,
    category: c.category,
    description: c.description,
    icon: c.icon ?? null,
    authType: c.authType,
    setupFields: c.setupFields.map((field) => ({
      ...field,
      type: secretFields.has(field.key) ? "password" as const : field.type,
      placeholder: secretFields.has(field.key) ? "[REDACTED]" : field.placeholder,
    })),
    scopes: c.scopes ?? [],
    operations: c.operations.map((op) => ({
      slug: op.slug,
      label: op.label,
      governance: op.governance,
      args: op.args ?? [],
      inputSchema: op.inputSchema,
      outputSummary: op.outputSummary,
    })),
    requiresDispatcherRestart: c.requiresDispatcherRestart ?? false,
  };
}
