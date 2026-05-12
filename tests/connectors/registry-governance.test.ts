import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY, toPublicConnector } from "@/connectors/registry";

describe("connector operation governance metadata", () => {
  it("declares governance metadata for every operation", () => {
    for (const connector of CONNECTOR_REGISTRY) {
      for (const operation of connector.operations) {
        expect(operation.governance, `${connector.slug}.${operation.slug}`).toEqual({
          effectType: expect.any(String),
          defaultDecision: expect.any(String),
          summary: expect.any(String),
        });
        expect(["read", "notify", "write", "financial", "destructive", "system"]).toContain(
          operation.governance.effectType,
        );
        expect(["allow", "require_approval", "block"]).toContain(
          operation.governance.defaultDecision,
        );
      }
    }
  });

  it("sets initial governance defaults by connector operation", () => {
    const governanceByOperation = Object.fromEntries(
      CONNECTOR_REGISTRY.flatMap((connector) =>
        connector.operations.map((operation) => [
          `${connector.slug}.${operation.slug}`,
          operation.governance,
        ]),
      ),
    );

    expect(governanceByOperation).toMatchObject({
      "discord-webhook.send_message": {
        effectType: "notify",
        defaultDecision: "require_approval",
      },
      "slack-webhook.send_message": {
        effectType: "notify",
        defaultDecision: "require_approval",
      },
      "http-webhook.post_json": {
        effectType: "write",
        defaultDecision: "require_approval",
      },
      "smtp-email.send_email": {
        effectType: "notify",
        defaultDecision: "require_approval",
      },
      "github-pat.list_issues": {
        effectType: "read",
        defaultDecision: "allow",
      },
      "stripe.list_recent_charges": {
        effectType: "financial",
        defaultDecision: "allow",
      },
      "twilio-sms.send_sms": {
        effectType: "notify",
        defaultDecision: "require_approval",
      },
      "voice-ea.test_connection": {
        effectType: "system",
        defaultDecision: "allow",
      },
      "gmail.list_threads": {
        effectType: "read",
        defaultDecision: "allow",
      },
      "gmail.send_email": {
        effectType: "notify",
        defaultDecision: "require_approval",
      },
      "ea-discord.self_test": {
        effectType: "system",
        defaultDecision: "allow",
      },
      "ea-discord.send_channel": {
        effectType: "notify",
        defaultDecision: "require_approval",
      },
    });
  });

  it("includes governance metadata in public connector output", () => {
    const publicConnectors = CONNECTOR_REGISTRY.map(toPublicConnector);

    for (const connector of publicConnectors) {
      for (const operation of connector.operations) {
        expect(operation.governance, `${connector.slug}.${operation.slug}`).toEqual({
          effectType: expect.any(String),
          defaultDecision: expect.any(String),
          summary: expect.any(String),
        });
      }
    }
  });
});
