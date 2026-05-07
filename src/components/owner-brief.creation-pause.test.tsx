// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HiveCreationPauseButton } from "./hive-creation-pause-button";

function renderButton() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <HiveCreationPauseButton hiveId="hive-1" />
    </QueryClientProvider>,
  );
}

function pausePayload(paused = true) {
  return {
    paused,
    reason: paused ? "Manual recovery lock" : null,
    pausedBy: "owner",
    updatedAt: new Date().toISOString(),
  };
}

describe("HiveCreationPauseButton", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ data: pausePayload() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows resume work when the hive is paused", async () => {
    renderButton();

    expect(await screen.findByRole("button", { name: /Resume work/i })).toBeTruthy();
  });

  it("lets the owner pause the hive from the header button", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/hives/hive-1/creation-pause" && !init) {
        return new Response(JSON.stringify({ data: pausePayload(false) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/hives/hive-1/creation-pause" && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          data: {
            paused: true,
            reason: "Paused from dashboard",
            pausedBy: "owner",
            updatedAt: new Date().toISOString(),
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderButton();

    fireEvent.click(await screen.findByRole("button", { name: /Pause Hive/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/hives/hive-1/creation-pause",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            paused: true,
            reason: "Paused from dashboard",
          }),
        }),
      );
    });
  });
});
