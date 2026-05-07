// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { AgentCard } from "../../src/components/agent-card";

type Handler = ((ev: MessageEvent) => void) | null;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: Handler = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe("<AgentCard>", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
  });
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it("renders role + title and opens SSE to /api/tasks/:id/stream", () => {
    render(<AgentCard taskId="t-1" assignedTo="dev-agent" title="Build X" />);
    expect(screen.getByText("dev-agent")).toBeTruthy();
    expect(screen.getByText("Build X")).toBeTruthy();
    expect(MockEventSource.instances[0].url).toBe("/api/tasks/t-1/stream");
  });

  it("wraps the card in a link to /tasks/:id for clickthrough", () => {
    render(<AgentCard taskId="t-abc" assignedTo="dev-agent" title="Build X" />);
    const link = screen.getByTestId("agent-card-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/tasks/t-abc");
    expect(link.getAttribute("aria-label")).toBe("Open task: Build X");
  });

  it("renders the runtime model label with the provider prefix stripped", () => {
    render(
      <AgentCard
        taskId="t-1"
        assignedTo="dev-agent"
        title="Build X"
        modelUsed="anthropic/claude-sonnet-4-6"
      />,
    );
    const badge = screen.getByTestId("agent-card-model");
    expect(badge.textContent).toBe("claude-sonnet-4-6");
    expect(badge.getAttribute("title")).toBe("anthropic/claude-sonnet-4-6");
  });

  it("falls back to 'model pending' when modelUsed is absent", () => {
    render(<AgentCard taskId="t-1" assignedTo="dev-agent" title="Build X" />);
    expect(screen.getByTestId("agent-card-model").textContent).toBe("model pending");
  });

  it("shows 'Waiting for output…' until the first chunk arrives", () => {
    render(<AgentCard taskId="t-2" assignedTo="dev-agent" title="A" />);
    expect(screen.getByText(/Waiting for output/)).toBeTruthy();
  });

  it("appends stdout/stderr chunks and drops the placeholder", () => {
    render(<AgentCard taskId="t-3" assignedTo="dev-agent" title="A" />);
    act(() => {
      MockEventSource.instances[0].emit({
        taskId: "t-3",
        chunk: "hello",
        type: "stdout",
        id: 1,
        timestamp: "2026-04-15T00:00:00.000Z",
      });
      MockEventSource.instances[0].emit({
        taskId: "t-3",
        chunk: " world",
        type: "stdout",
        id: 2,
        timestamp: "2026-04-15T00:00:01.000Z",
      });
    });
    expect(screen.queryByText(/Waiting for output/)).toBeNull();
    expect(screen.getByTestId("agent-card-output").textContent).toContain("hello world");
  });

  it("closes SSE on unmount", () => {
    const { unmount } = render(<AgentCard taskId="t-4" assignedTo="dev-agent" title="A" />);
    expect(MockEventSource.instances[0].closed).toBe(false);
    unmount();
    expect(MockEventSource.instances[0].closed).toBe(true);
  });
});
