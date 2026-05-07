import { describe, it, expect, vi } from "vitest";
import type { WebSocket } from "ws";
import { __testables } from "@/connectors/voice/gpu-clients";

describe("toWsBase", () => {
  it("rewrites http to ws", () => {
    expect(__testables.toWsBase("http://gpu.example.com:8790")).toBe("ws://gpu.example.com:8790");
  });
  it("rewrites https to wss", () => {
    expect(__testables.toWsBase("https://gpu.example.com")).toBe("wss://gpu.example.com");
  });
  it("strips trailing slash", () => {
    expect(__testables.toWsBase("http://gpu.example.com:8790/")).toBe("ws://gpu.example.com:8790");
  });
});

describe("waitOpen", () => {
  it("rejects and terminates when the socket errors", async () => {
    const terminate = vi.fn();
    const listeners: Record<string, (arg?: Error) => void> = {};
    const ws = {
      once: (ev: string, cb: (arg?: Error) => void) => {
        listeners[ev] = cb;
      },
      removeListener: (ev: string) => {
        delete listeners[ev];
      },
      terminate,
    } as unknown as WebSocket;
    const p = __testables.waitOpen(ws, 1000);
    listeners.error?.(new Error("econnrefused"));
    await expect(p).rejects.toThrow("econnrefused");
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("rejects and terminates on timeout", async () => {
    vi.useFakeTimers();
    try {
      const terminate = vi.fn();
      const ws = {
        once: () => {},
        removeListener: () => {},
        terminate,
      } as unknown as WebSocket;
      const p = __testables.waitOpen(ws, 50);
      vi.advanceTimersByTime(60);
      await expect(p).rejects.toThrow(/timed out/);
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
