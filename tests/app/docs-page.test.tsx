// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import DocsPage from "../../src/app/(dashboard)/docs/page";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

describe("DocsPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/connectors")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                slug: "smtp",
                name: "SMTP email",
                category: "notifications",
                description: "Send outbound email.",
                icon: "📧",
                authType: "api_key",
                operations: [{ slug: "send_email", label: "Send email" }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/roles")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                slug: "doctor",
                name: "Doctor",
                department: "system",
                type: "system",
                recommendedModel: "claude-sonnet-4-6",
                adapterType: "claude-code",
                skills: ["hivewright-ops"],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders inside dashboard shell — page title and section headings visible", async () => {
    render(<DocsPage />);
    expect(screen.getByText("HiveWright docs")).toBeTruthy();
    expect(screen.getByText("Quick start")).toBeTruthy();
    expect(screen.getByText("Built-in connectors")).toBeTruthy();
    expect(screen.getByText("Role library")).toBeTruthy();
    expect(screen.getByText("How the pieces fit")).toBeTruthy();
  });

  it("renders connector cards fetched from /api/connectors", async () => {
    render(<DocsPage />);
    await waitFor(() => expect(screen.getByText("📧 SMTP email")).toBeTruthy());
  });

  it("renders role rows fetched from /api/roles", async () => {
    render(<DocsPage />);
    await waitFor(() => expect(screen.getByText("Doctor")).toBeTruthy());
  });

  it("is located at src/app/(dashboard)/docs/page.tsx — inherits DashboardLayout", () => {
    // Structural check: the import above resolves from the (dashboard) route
    // group, confirming the route is wrapped by DashboardLayout (HiveProvider +
    // LiveUpdatesGate + DashboardShell). If the file were still at
    // src/app/docs/page.tsx this import would fail to resolve.
    expect(DocsPage).toBeDefined();
    expect(typeof DocsPage).toBe("function");
  });
});
