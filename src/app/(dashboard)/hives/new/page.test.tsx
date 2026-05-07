/* @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import NewHiveWizard from "./page";

const fetchMock = vi.fn();

const setupOk = () => ({
  ok: true,
  json: async () => ({ data: { id: "hive-id-1" } }),
});

const emptyList = () => ({
  ok: true,
  json: async () => ({ data: [] }),
});

beforeEach(() => {
  vi.clearAllMocks();
  pushMock.mockReset();
  localStorage.clear();
  localStorage.setItem("hivewright.setupWelcomeDismissed", "true");
  fetchMock.mockReset();
  fetchMock.mockImplementation((input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/hives/setup") return Promise.resolve(setupOk());
    return Promise.resolve(emptyList());
  });
  vi.stubGlobal("fetch", fetchMock);
});

describe("NewHiveWizard hive address setup", () => {
  it("does not render a top-level Slug field on the setup form", async () => {
    render(<NewHiveWizard />);
    await screen.findByLabelText(/^Hive name/);
    expect(screen.queryByLabelText(/^slug/i)).toBeNull();
  });

  it("hides the custom hive address control behind a closed Advanced disclosure by default", async () => {
    render(<NewHiveWizard />);
    const summary = await screen.findByText("Advanced");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
  });

  it("derives the hive address from the hive name", async () => {
    render(<NewHiveWizard />);
    const nameInput = (await screen.findByLabelText(/^Hive name/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Hello World!" } });

    fireEvent.click(screen.getByText("Advanced"));
    const addressInput = (await screen.findByLabelText("Custom hive address")) as HTMLInputElement;
    expect(addressInput.value).toBe("hello-world");
  });

  it("preserves the custom hive address after subsequent name changes", async () => {
    render(<NewHiveWizard />);
    const nameInput = (await screen.findByLabelText(/^Hive name/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "First name" } });

    fireEvent.click(screen.getByText("Advanced"));
    const addressInput = (await screen.findByLabelText("Custom hive address")) as HTMLInputElement;
    expect(addressInput.value).toBe("first-name");

    fireEvent.change(addressInput, { target: { value: "my-custom-address" } });
    expect(addressInput.value).toBe("my-custom-address");

    fireEvent.change(nameInput, { target: { value: "A different name" } });
    expect(addressInput.value).toBe("my-custom-address");
  });

  it("submits the generated hive address derived from the hive name", async () => {
    render(<NewHiveWizard />);
    const nameInput = (await screen.findByLabelText(/^Hive name/)) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Owner Acme Co." } });

    const typeSelect = screen.getByLabelText(/^Type/) as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "physical" } });

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    const createButton = await screen.findByRole("button", { name: /Create Hive/ });
    fireEvent.click(createButton);

    await waitFor(() => {
      const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/hives/setup");
      expect(setupCall).toBeDefined();
    });

    const setupCall = fetchMock.mock.calls.find(([url]) => url === "/api/hives/setup")!;
    const body = JSON.parse(setupCall[1].body);
    expect(body.hive.name).toBe("Owner Acme Co.");
    expect(body.hive.slug).toBe("owner-acme-co");
  });

  it("does not display the word slug anywhere in the rendered setup or review UI", async () => {
    const { container } = render(<NewHiveWizard />);
    await screen.findByLabelText(/^Hive name/);

    const visibleText = () => (container.textContent ?? "").toLowerCase();
    expect(visibleText()).not.toContain("slug");

    fireEvent.click(screen.getByText("Advanced"));
    expect(visibleText()).not.toContain("slug");

    fireEvent.change(screen.getByLabelText(/^Hive name/), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText(/^Type/) as HTMLSelectElement, {
      target: { value: "physical" },
    });

    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
    }

    await screen.findByRole("button", { name: /Create Hive/ });
    expect(visibleText()).not.toContain("slug");
  });
});
