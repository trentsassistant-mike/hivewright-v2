/* @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import NewHiveWizard from "./page";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  pushMock.mockReset();
  localStorage.clear();
  localStorage.setItem("hivewright.setupWelcomeDismissed", "true");
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/hives/setup") {
      return Promise.resolve(new Response(JSON.stringify({
        error: "We couldn't finish setting up one of the selected services. Please try again.",
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("NewHiveWizard setup failure handling", () => {
  it("stays on the review step and shows a retry message when setup returns a non-2xx response", async () => {
    render(<NewHiveWizard />);
    fireEvent.change(await screen.findByLabelText(/^Hive name/), { target: { value: "Test Hive" } });

    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    await screen.findByRole("button", { name: /Create Hive/ });
    fireEvent.click(screen.getByRole("button", { name: /Create Hive/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("We couldn't finish setting up one of the selected services. Please try again.");
      expect(screen.getByRole("alert").textContent).toContain("Nothing has been marked complete. You can fix the issue and try again.");
    });
    expect(screen.getByRole("heading", { name: "Review and launch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry setup" })).toBeTruthy();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
