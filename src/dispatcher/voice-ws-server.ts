import { WebSocketServer } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import type { Sql } from "postgres";
import { mountDirectWsHandler } from "@/connectors/voice/direct-ws";

/**
 * Dispatcher-hosted WebSocket server for the Voice EA.
 *
 * Single upgrade path: `/api/voice/direct/ws` carries PCM16 mono 16 kHz
 * audio frames from the PWA, and PCM16 mono 24 kHz frames back. Auth is
 * a short-lived HMAC-signed token minted by `POST /api/voice/direct` on
 * the dashboard (see `src/lib/voice-session-token.ts`).
 *
 * The pre-2026-05-07 Twilio Media Streams path (`/api/voice/ws`) was
 * removed in Phase 5 of the WebSocket cutover plan; nothing left in this
 * server is Twilio-aware.
 */

export interface VoiceWsHandle {
  /** Underlying HTTP server. Tests use this for `.address()` and `.once('listening')`. */
  server: HttpServer;
  wss: WebSocketServer;
  shutdown(): Promise<void>;
}

const DIRECT_PATH = "/api/voice/direct/ws";

export function startVoiceWsServer(sql: Sql, port: number): VoiceWsHandle {
  // noServer mode so we can route on URL path before deciding to upgrade.
  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((_req, res) => {
    res.statusCode = 426;
    res.end("upgrade required");
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === DIRECT_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        void mountDirectWsHandler(sql, ws, req);
      });
      return;
    }
    socket.destroy();
  });
  server.listen(port);

  wss.on("error", (err) => {
    console.error("[voice-ws] server error:", err);
  });

  return {
    server,
    wss,
    async shutdown() {
      for (const client of wss.clients) {
        try {
          client.close(1001, "shutting down");
        } catch { /* ignore */ }
      }
      return new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => resolve());
        });
      });
    },
  };
}
