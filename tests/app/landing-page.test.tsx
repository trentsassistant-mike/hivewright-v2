// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingPage from "../../src/app/landing/page";

describe("LandingPage", () => {
  it("shows preview status before the primary control", () => {
    render(<LandingPage />);

    const preview = screen.getByText("PREVIEW / NON-PUBLIC");
    const primaryControl = screen.getByRole("button", { name: /internal preview only/i });

    expect(preview.compareDocumentPosition(primaryControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not render a live-looking commercial CTA", () => {
    render(<LandingPage />);

    expect(screen.queryByRole("link", { name: /talk to the team/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /talk to the team/i })).toBeNull();
    expect(screen.getByRole("button", { name: /internal preview only/i }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/No public handoff channel is connected/i)).toBeTruthy();
  });
});
