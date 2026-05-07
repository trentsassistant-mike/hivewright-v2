// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelHealthPanel } from "./model-health-panel";

function modelHealthResponse(status = "healthy") {
  return {
    data: {
      hiveId: "hive-1",
      rows: [
        {
          id: "model-1",
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5.5",
          credentialName: "OpenAI",
          enabled: true,
          fallbackPriority: 10,
          status,
          lastProbedAt: "2026-05-02T01:00:00.000Z",
          nextProbeAt: "2026-05-02T02:00:00.000Z",
          latencyMs: 1234,
          failureClass: null,
          failureMessage: null,
        },
      ],
    },
  };
}

describe("ModelHealthPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/model-health?hiveId=hive-1" && !init) {
        return new Response(JSON.stringify(modelHealthResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/model-health/probe" && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            hiveId: "hive-1",
            limit: 50,
            includeFresh: true,
            result: {
              considered: 1,
              probed: 1,
              healthy: 1,
              unhealthy: 0,
              skippedFresh: 0,
              skippedDisabled: 0,
              skippedCredentialErrors: 0,
              errors: [],
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/model-health/sync-models" && init?.method === "POST") {
        return new Response(JSON.stringify({
          data: {
            hiveId: "hive-1",
            result: {
              considered: 3,
              upserted: 2,
              skipped: 1,
              sources: {
                rolePrimary: 1,
                roleFallback: 1,
                routingCandidate: 1,
              },
            },
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows model health rows for the selected hive", async () => {
    render(<ModelHealthPanel hiveId="hive-1" hiveName="Main Hive" />);

    expect(await screen.findByText("Model Health")).toBeTruthy();
    expect(await screen.findByText("openai-codex/gpt-5.5")).toBeTruthy();
    expect(await screen.findByText("codex")).toBeTruthy();
    expect(await screen.findByText("healthy")).toBeTruthy();
    expect(await screen.findByText("1234 ms")).toBeTruthy();
  });

  it("runs manual probes and refreshes the table", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    render(<ModelHealthPanel hiveId="hive-1" hiveName="Main Hive" />);

    fireEvent.click(await screen.findByRole("button", { name: /Run health probes/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-health/probe",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            hiveId: "hive-1",
            includeFresh: true,
          }),
        }),
      );
    });
    expect(await screen.findByText("Last probe run: 1 probed, 1 healthy, 0 unhealthy")).toBeTruthy();
  });

  it("syncs configured models and refreshes the table", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

    render(<ModelHealthPanel hiveId="hive-1" hiveName="Main Hive" />);

    fireEvent.click(await screen.findByRole("button", { name: /Sync configured models/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-health/sync-models",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ hiveId: "hive-1" }),
        }),
      );
    });
    expect(await screen.findByText("Last sync: 2 models synced, 1 skipped")).toBeTruthy();
  });
});
