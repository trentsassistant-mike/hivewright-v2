import { WebSocket } from "ws";

/**
 * Open a WebSocket to the GPU host's STT service. `baseUrl` is the
 * `voiceServicesUrl` config value from the installed `twilio-voice`
 * connector (e.g. `http://gpu.my-tailnet.ts.net:8790`). HTTP schemes are
 * rewritten to `ws://`; HTTPS becomes `wss://`.
 */
export async function openSttClient(baseUrl: string, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(
    `${toWsBase(baseUrl)}/stt/stream?session_id=${encodeURIComponent(sessionId)}`,
  );
  await waitOpen(ws);
  return ws;
}

/**
 * Open a WebSocket to the GPU host's TTS service. `baseUrl` is the
 * `voiceServicesUrl` config value from the installed `twilio-voice`
 * connector. HTTP schemes are rewritten to `ws://`; HTTPS becomes `wss://`.
 */
export async function openTtsClient(baseUrl: string): Promise<WebSocket> {
  const ws = new WebSocket(`${toWsBase(baseUrl)}/tts/stream`);
  await waitOpen(ws);
  return ws;
}

function toWsBase(url: string): string {
  // http -> ws, https -> wss. Trim trailing slash.
  return url.replace(/^http(s?):/i, (_m, s) => `ws${s}:`).replace(/\/$/, "");
}

function waitOpen(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore: socket may already be closed
      }
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        // ignore: socket may already be closed
      }
      reject(new Error(`voice-services websocket open timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
    }
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

export const __testables = { toWsBase, waitOpen };
