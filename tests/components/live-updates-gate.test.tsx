// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveUpdatesGate } from "../../src/components/live-updates-gate";

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

vi.mock("@/components/hive-context", () => ({
  useHiveContext: vi.fn(),
}));

import { useHiveContext } from "@/components/hive-context";

describe("<LiveUpdatesGate>", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    (globalThis as unknown as { EventSource: typeof MockEventSource }).EventSource = MockEventSource;
  });
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    vi.clearAllMocks();
  });

  it("does not open a live connection when no hive is selected", () => {
    vi.mocked(useHiveContext).mockReturnValue({ selected: null, loading: false, hives: [], selectHive: () => {} });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesGate>
          <div />
        </LiveUpdatesGate>
      </QueryClientProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("opens a live connection scoped to the selected hive", () => {
    vi.mocked(useHiveContext).mockReturnValue({
      selected: { id: "biz-gate", slug: "biz-gate", name: "Biz Gate", type: "test" },
      loading: false,
      hives: [],
      selectHive: () => {},
    });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LiveUpdatesGate>
          <div />
        </LiveUpdatesGate>
      </QueryClientProvider>,
    );
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe("/api/events?hiveId=biz-gate");
  });
});
