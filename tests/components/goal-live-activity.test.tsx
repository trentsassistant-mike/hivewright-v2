// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalLiveActivity } from "../../src/components/goal-live-activity";

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

function emitLine(id: number, chunk: string) {
  MockEventSource.instances[0].emit({
    goalId: "goal-1",
    taskId: "task-1",
    chunk,
    type: "stdout",
    id,
    timestamp: `2026-05-01T00:00:${String(id).padStart(2, "0")}.000Z`,
  });
}

function setScrollMetrics(
  element: HTMLElement,
  {
    scrollHeight,
    clientHeight,
    scrollTop,
  }: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  },
) {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  element.scrollTop = scrollTop;
}

describe("<GoalLiveActivity>", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource =
      MockEventSource;
  });

  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    vi.restoreAllMocks();
  });

  it("does not move the page or force panel scroll when the reader has scrolled up", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 240,
    });

    render(
      <GoalLiveActivity
        goalId="goal-1"
        taskTitles={{ "task-1": "Investigate live output" }}
      />,
    );

    expect(MockEventSource.instances[0].url).toBe("/api/goals/goal-1/stream");

    act(() => {
      MockEventSource.instances[0].emit({
        type: "connected",
        timestamp: "2026-05-01T00:00:00.000Z",
      });
      emitLine(1, "first line");
      emitLine(2, "second line");
    });

    const output = screen.getByTestId("goal-task-output-task-1");

    setScrollMetrics(output, {
      scrollHeight: 1200,
      clientHeight: 200,
      scrollTop: 200,
    });

    act(() => {
      emitLine(3, "new line while reader is reviewing earlier output");
    });

    expect(window.scrollY).toBe(240);
    expect(output.scrollTop).toBe(200);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      screen.getByText("new line while reader is reviewing earlier output"),
    ).toBeTruthy();
  });
});
