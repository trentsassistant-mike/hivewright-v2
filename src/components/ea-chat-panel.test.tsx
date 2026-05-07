// @vitest-environment jsdom

import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EaChatEntryButton, EaChatPanel } from "./ea-chat-panel";
import { queryKeys } from "@/lib/query-keys";

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "HiveWright",
      slug: "hivewright",
      type: "digital",
    },
    loading: false,
    hives: [],
    selectHive: vi.fn(),
  }),
}));

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <EaChatPanel open onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function emptyThreadResponse() {
  return jsonResponse({
    data: {
      thread: {
        id: "thread-1",
        hiveId: "11111111-1111-4111-8111-111111111111",
        channelId: "dashboard:user",
        status: "active",
        createdAt: new Date().toISOString(),
      },
      messages: [],
      hasMore: false,
    },
  });
}

function createStreamingResponse() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    async pushDelta(delta: string) {
      await act(async () => {
        controller?.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "delta", delta })}\n\n`),
        );
        await Promise.resolve();
      });
    },
    async close() {
      await act(async () => {
        controller?.close();
        await Promise.resolve();
      });
    },
  };
}

function setListScrollMetrics(
  list: HTMLElement,
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
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: clientHeight,
  });
  list.scrollTop = scrollTop;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn((file: File) => `blob:${file.name}`),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EaChatPanel", () => {
  it("labels the entry point with the selected hive context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          data: {
            thread: {
              id: "thread-1",
              hiveId: "11111111-1111-4111-8111-111111111111",
              channelId: "dashboard:user",
              status: "active",
              createdAt: new Date().toISOString(),
            },
            messages: [],
            hasMore: false,
          },
        }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <EaChatEntryButton open={false} onToggle={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("button", {
      name: /Open Executive Assistant chat for HiveWright, ready/i,
    })).toBeTruthy();
    expect(screen.getByText("HiveWright · Ready")).toBeTruthy();
  });

  it("renders the empty thread state from persisted backend history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        jsonResponse({
          data: {
            thread: {
              id: "thread-1",
              hiveId: "11111111-1111-4111-8111-111111111111",
              channelId: "dashboard:user",
              status: "active",
              createdAt: new Date().toISOString(),
            },
            messages: [],
            hasMore: false,
          },
        }),
      ),
    );

    renderPanel();

    expect(await screen.findByText("No messages in this thread")).toBeTruthy();
    expect(screen.getByText("HiveWright · active thread")).toBeTruthy();
    expect(screen.getByLabelText("Message Executive Assistant")).toBeTruthy();
  });

  it("optimistically shows a sending message and posts the composed content", async () => {
    let resolveSend: ((value: Response) => void) | undefined;
    const pendingSend = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({
          data: {
            thread: {
              id: "thread-1",
              hiveId: "11111111-1111-4111-8111-111111111111",
              channelId: "dashboard:user",
              status: "active",
              createdAt: new Date().toISOString(),
            },
            messages: [],
            hasMore: false,
          },
        }),
      )
      .mockImplementationOnce(() => pendingSend)
      .mockImplementation(() =>
        jsonResponse({
          data: {
            thread: {
              id: "thread-1",
              hiveId: "11111111-1111-4111-8111-111111111111",
              channelId: "dashboard:user",
              status: "active",
              createdAt: new Date().toISOString(),
            },
            messages: [
              {
                id: "owner-1",
                threadId: "thread-1",
                role: "owner",
                content: "What needs my attention?",
                source: "dashboard",
                status: "sent",
                error: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: "assistant-1",
                threadId: "thread-1",
                role: "assistant",
                content: "Nothing needs your attention.",
                source: "dashboard",
                status: "sent",
                error: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
            hasMore: false,
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    const composer = await screen.findByLabelText("Message Executive Assistant");
    fireEvent.change(composer, { target: { value: "What needs my attention?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByLabelText(/Owner message, queued/)).toBeTruthy();
    expect(screen.getByText("What needs my attention?")).toBeTruthy();
    expect(screen.getByText("EA is thinking...")).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/ea/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          hiveId: "11111111-1111-4111-8111-111111111111",
          content: "What needs my attention?",
        }),
      }),
    ));

    resolveSend?.(
      new Response(
        JSON.stringify({
          data: {
            threadId: "thread-1",
            ownerMessage: { id: "owner-1", status: "sent" },
            assistantMessage: {
              id: "assistant-1",
              status: "sent",
              content: "Nothing needs your attention.",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  });

  it("shows attachment previews, allows removal, and sends multipart form data", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => emptyThreadResponse())
      .mockImplementationOnce(() =>
        jsonResponse({
          data: {
            threadId: "thread-1",
            ownerMessage: { id: "owner-1", status: "sent" },
            assistantMessage: {
              id: "assistant-1",
              status: "sent",
              content: "Reviewed.",
            },
          },
        }, 201),
      )
      .mockImplementation(() => emptyThreadResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderPanel();
    await screen.findByText("No messages in this thread");
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = new File([new Uint8Array([1])], "screen.png", { type: "image/png" });
    const pdf = new File([new Uint8Array([2])], "brief.pdf", { type: "application/pdf" });

    fireEvent.change(input, { target: { files: [image, pdf] } });

    expect(await screen.findByAltText("screen.png")).toBeTruthy();
    expect(screen.getByText("brief.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove brief.pdf" }));
    expect(screen.queryByText("brief.pdf")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "POST")).toBe(true),
    );
    const postCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "POST",
    );
    const requestInit = postCall?.[1] as RequestInit;
    expect(requestInit.headers).toEqual({ "Accept": "text/event-stream" });
    expect(requestInit.body).toBeInstanceOf(FormData);
    const formData = requestInit.body as FormData;
    expect(formData.get("hiveId")).toBe("11111111-1111-4111-8111-111111111111");
    expect(formData.get("content")).toBe("");
    expect(formData.getAll("files")).toEqual([image]);
  });

  it("rejects oversized dropped files with a clear error", async () => {
    vi.stubGlobal("fetch", vi.fn(() => emptyThreadResponse()));

    renderPanel();
    await screen.findByText("No messages in this thread");
    const panel = screen.getByRole("complementary");
    const oversized = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.pdf", {
      type: "application/pdf",
    });

    fireEvent.drop(panel, { dataTransfer: { files: [oversized] } });

    expect((await screen.findByRole("alert")).textContent).toContain(
      'File "huge.pdf" exceeds the 25 MB size limit.',
    );
    expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  });

  it("dedupes the optimistic owner message when the persisted copy arrives during streaming", async () => {
    const hiveId = "11111111-1111-4111-8111-111111111111";
    const content = "What needs my attention?";
    const pendingSend = new Promise<Response>(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({
          data: {
            thread: {
              id: "thread-1",
              hiveId,
              channelId: "dashboard:user",
              status: "active",
              createdAt: new Date().toISOString(),
            },
            messages: [],
            hasMore: false,
          },
        }),
      )
      .mockImplementationOnce(() => pendingSend);
    vi.stubGlobal("fetch", fetchMock);

    const { queryClient } = renderPanel();
    const composer = await screen.findByLabelText("Message Executive Assistant");
    fireEvent.change(composer, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByLabelText(/Owner message, queued/)).toBeTruthy();
    expect(screen.getAllByLabelText(/Owner message/)).toHaveLength(1);

    act(() => {
      const now = new Date().toISOString();
      queryClient.setQueryData(queryKeys.eaChat.active(hiveId), {
        thread: {
          id: "thread-1",
          hiveId,
          channelId: "dashboard:user",
          status: "active",
          createdAt: now,
        },
        messages: [
          {
            id: "owner-1",
            threadId: "thread-1",
            role: "owner",
            content,
            source: "dashboard",
            status: "sent",
            error: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "assistant-1",
            threadId: "thread-1",
            role: "assistant",
            content: "",
            source: "dashboard",
            status: "streaming",
            error: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        hasMore: false,
      });
    });

    await waitFor(() => expect(screen.getAllByLabelText(/Owner message/)).toHaveLength(1));
    expect(screen.queryByLabelText(/Owner message, queued/)).toBeNull();
    expect(screen.getByLabelText(/Owner message, sent/)).toBeTruthy();
    expect(screen.getByText(content)).toBeTruthy();
  });

  it("scrolls as streaming assistant content grows", async () => {
    const streaming = createStreamingResponse();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => emptyThreadResponse())
      .mockImplementationOnce(() => Promise.resolve(streaming.response));
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    const composer = await screen.findByLabelText("Message Executive Assistant");
    const list = screen.getByRole("region", { name: "EA conversation" });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      list.scrollTop = Number(top);
    });
    Object.defineProperty(list, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    setListScrollMetrics(list, { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });
    fireEvent.change(composer, { target: { value: "Stream the update" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByLabelText(/Assistant message, streaming/);
    scrollTo.mockClear();

    setListScrollMetrics(list, { scrollHeight: 1100, clientHeight: 500, scrollTop: 500 });
    await streaming.pushDelta("First streamed chunk");

    await waitFor(() =>
      expect(scrollTo).toHaveBeenCalledWith({ top: 1100, behavior: "smooth" }),
    );
    expect(list.scrollTop).toBe(1100);

    await streaming.close();
  });

  it("keeps the user's scroll position when streaming content arrives beyond the hidden-message threshold", async () => {
    const streaming = createStreamingResponse();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => emptyThreadResponse())
      .mockImplementationOnce(() => Promise.resolve(streaming.response));
    vi.stubGlobal("fetch", fetchMock);

    renderPanel();
    const composer = await screen.findByLabelText("Message Executive Assistant");
    const list = screen.getByRole("region", { name: "EA conversation" });
    const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      list.scrollTop = Number(top);
    });
    Object.defineProperty(list, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    setListScrollMetrics(list, { scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });
    fireEvent.change(composer, { target: { value: "Stream the update" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByLabelText(/Assistant message, streaming/);
    scrollTo.mockClear();

    setListScrollMetrics(list, { scrollHeight: 1100, clientHeight: 500, scrollTop: 300 });
    await streaming.pushDelta("First streamed chunk");

    await waitFor(() => expect(screen.getByRole("button", { name: "New messages" })).toBeTruthy());
    expect(scrollTo).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(300);

    await streaming.close();
  });
});
