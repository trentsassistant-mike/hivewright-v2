// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ActiveSupervisorsPanel } from "@/components/active-supervisors-panel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ActiveSupervisorsPanel>", () => {
  it("renders goal and longer thread prefixes so near-simultaneous supervisors are distinguishable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          goalId: "11111111-aaaa-4aaa-8aaa-111111111111",
          goalShortId: "11111111",
          title: "First supervisor",
          threadId: "019ddb5c-6e1a",
          lastActivityAt: new Date().toISOString(),
          state: "running",
        },
        {
          goalId: "22222222-bbbb-4bbb-8bbb-222222222222",
          goalShortId: "22222222",
          title: "Second supervisor",
          threadId: "019ddb5c-6e1b",
          lastActivityAt: new Date().toISOString(),
          state: "running",
        },
      ],
    }), { status: 200 })));

    render(<ActiveSupervisorsPanel hiveId="hive-1" />);

    await waitFor(() => expect(screen.getByText("First supervisor")).toBeTruthy());
    expect(screen.getByText("Second supervisor")).toBeTruthy();
    expect(screen.getByText("11111111")).toBeTruthy();
    expect(screen.getByText("22222222")).toBeTruthy();
    expect(screen.getByText("019ddb5c-6e1a")).toBeTruthy();
    expect(screen.getByText("019ddb5c-6e1b")).toBeTruthy();
  });
});
