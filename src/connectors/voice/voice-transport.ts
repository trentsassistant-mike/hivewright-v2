/**
 * Carrier-agnostic transport for the Voice EA runtime.
 *
 * The runtime speaks PCM16 mono natively: 16 kHz inbound (mic) and 24 kHz
 * outbound (Kokoro TTS). Each carrier — Twilio Media Streams, direct
 * PCM-over-WebSocket — wraps its own framing/encoding around these PCM
 * boundaries by implementing this interface.
 *
 * Adding a new carrier means writing one of these. The runtime never
 * needs to learn about it.
 */
export interface VoiceTransport {
  /**
   * Send a PCM16 mono 24 kHz buffer to the client. The transport is
   * responsible for any carrier-specific encoding (Twilio: μ-law @ 8 kHz
   * with base64-JSON framing; direct-WS: raw bytes).
   */
  sendTtsAudio(pcm24k: Buffer): void;

  /**
   * Close the underlying connection cleanly. Idempotent — calling twice is
   * a no-op.
   */
  close(): void;
}
