// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveUpdatesProvider } from "../../src/components/live-updates-provider";
import { queryKeys } from "../../src/lib/query-keys";

type Handler = ((ev: MessageEvent) => void) | null;

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: Handler = null;
  onerror: ((ev: Event) => void) | null = null;
  readyState = 1;
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

describe("LiveUpdatesProvider", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
      MockEventSource;
  });
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it("opens an SSE connection scoped to hiveId", () => {
    const qc = new QueryClient();
    const bizId = "biz-123";
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId={bizId}>
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe(`/api/events?hiveId=${bizId}`);
  });

  it("invalidates dashboard + active-tasks on task_claimed", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const bizId = "biz-xyz";
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId={bizId}>
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    act(() => {
      MockEventSource.instances[0].emit({
        type: "task_claimed",
        taskId: "t1",
        hiveId: bizId,
        timestamp: "2026-04-15T00:00:00.000Z",
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.summary(bizId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.active(bizId),
    });
  });

  it("invalidates decisions on decision_created", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const bizId = "biz-d";
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId={bizId}>
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    act(() => {
      MockEventSource.instances[0].emit({
        type: "decision_created",
        decisionId: "d1",
        hiveId: bizId,
        timestamp: "2026-04-15T00:00:00.000Z",
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.decisions.list(bizId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.summary(bizId),
    });
  });

  it("invalidates dashboard + active-tasks on task_completed", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const bizId = "biz-complete";
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId={bizId}>
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    act(() => {
      MockEventSource.instances[0].emit({
        type: "task_completed",
        taskId: "t-done",
        hiveId: bizId,
        timestamp: "2026-04-15T00:00:00.000Z",
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.summary(bizId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.active(bizId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.tasks.detail("t-done"),
    });
  });

  it("invalidates decisions + dashboard on decision_resolved", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const bizId = "biz-resolve";
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId={bizId}>
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    act(() => {
      MockEventSource.instances[0].emit({
        type: "decision_resolved",
        decisionId: "d-done",
        hiveId: bizId,
        timestamp: "2026-04-15T00:00:00.000Z",
      });
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.decisions.list(bizId),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.dashboard.summary(bizId),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["brief", bizId] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["operations-map", "critical-items", bizId],
    });
  });

  it("invalidates all dashboard panels on task_cancelled", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const bizId = "biz-cancel";
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId={bizId}>
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    act(() => {
      MockEventSource.instances[0].emit({
        type: "task_cancelled",
        taskId: "t-cancelled",
        hiveId: bizId,
        timestamp: "2026-04-15T00:00:00.000Z",
      });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.tasks.active(bizId) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["brief", bizId] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["operations-map", "active-tasks", bizId],
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["operations-map", "critical-items", bizId],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["supervisor-reports", bizId] });
  });

  it("closes the SSE connection when hiveId changes", () => {
    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId="biz-1">
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    expect(MockEventSource.instances[0].closed).toBe(false);
    rerender(
      <QueryClientProvider client={qc}>
        <LiveUpdatesProvider hiveId="biz-2">
          <div />
        </LiveUpdatesProvider>
      </QueryClientProvider>,
    );
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe("/api/events?hiveId=biz-2");
  });
});
