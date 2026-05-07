# Voice EA — Operator Runbook

The Voice EA lets you talk to your Executive Assistant over a phone-style
call instead of typing into Discord or the dashboard. A WebSocket carries
PCM audio directly from the PWA to the dispatcher; a GPU service on the
LAN handles speech-to-text and text-to-speech; the existing EA logic on
the dashboard drives the conversation. There is no Twilio, no public
Funnel, no per-minute carriage cost — everything rides the tailnet.

## Architecture

```
PWA (browser) ──Opus mic via getUserMedia──┐
       └──AudioWorklet downsample 48→16 kHz──┐
                                              │
                  PCM16 mono 16 kHz binary frames over WSS
                                              │
                                              ▼
                  dashboard :443 (Tailscale serve, tailnet only)
                  └── /api/voice/direct        — POST mints session token (NextAuth)
                  └── /api/voice/direct/ws     — WSS proxy → dispatcher :8791
                                              │
                                              ▼
                              dispatcher :8791
                  └── /api/voice/direct/ws — verifies HMAC token, mounts runtime
                                              │
                                              ▼
                              GPU host (LAN) :8790  (faster-whisper + Kokoro + Pyannote)
                  └── /stt/stream  — PCM16 mono 16 kHz in, JSON {final, text} out
                  └── /tts/stream  — JSON {text} in, PCM16 mono 24 kHz binary out
                  └── /voiceprint/embed — POST WAV → 192-d embedding
```

## GPU services contract (transport-agnostic)

The GPU voice services on the LAN don't know about the PWA. They speak
only PCM:

- `WS /stt/stream` — accepts **16-bit mono PCM @ 16 kHz** binary frames.
  Emits JSON `{type:"final", text, duration_ms}` every ~2 s of buffered
  audio and on EOF; emits `{type:"end"}` when the stream closes. No
  VAD/utterance-boundary detection in v1.
- `WS /tts/stream` — accepts JSON frames `{type:"text", text}` (synth
  this chunk) and `{type:"eof"}` (flush + end). Emits **16-bit mono PCM
  @ 24 kHz** as binary frames followed by a final `{type:"end"}` JSON.
- `POST /voiceprint/embed` — accepts a raw WAV body, returns a Pyannote
  192-dim embedding.

The dispatcher's voice runtime is the only consumer; it speaks PCM
end-to-end and never transcodes. (The pre-2026-05-07 Twilio path used
μ-law / 8 kHz / sample-doubling at this boundary — all gone.)

## Prerequisites

- **Tailscale** installed and running on the dashboard host.
- **GPU host on the LAN**, reachable from the dashboard at
  `http://<gpu-ip>:8790`. This is the voice-services FastAPI process
  (faster-whisper STT + Kokoro TTS + Pyannote voiceprint). Setup is in
  the **GPU Host Deployment** section below.
- **Phone with Tailscale on**, joined to the same tailnet as the
  dashboard. The PWA only works over tailnet — there is no public
  Funnel for voice in v2.

## Tailscale serve setup (tailnet-only — no public surface)

The dashboard sits on tailnet `:443`. Voice signaling and the WebSocket
upgrade ride the same hostname on the same port; an extra `serve` rule
proxies the WS path to the dispatcher's `:8791`.

Run on the dashboard host:

```bash
# Reset any prior funnel/serve config
sudo tailscale funnel reset
sudo tailscale serve reset

# Dashboard on :443 — tailnet only, no Funnel
sudo tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:3002

# Voice WS upgrade path on the same :443 — also tailnet only
sudo tailscale serve --bg --https=443 \
  --set-path=/api/voice/direct/ws \
  http://127.0.0.1:8791/api/voice/direct/ws

# Verify
sudo tailscale serve status
```

`tailscale serve status` should show **no Funnel rules** and only:

```
https://<host>.ts.net (tailnet only)
|-- /                         proxy http://127.0.0.1:3002
|-- /api/voice/direct/ws      proxy http://127.0.0.1:8791/api/voice/direct/ws
```

If you see a Funnel rule (anything reachable from the public internet),
**stop** — voice should never be public. Run `sudo tailscale funnel
reset` and re-apply the `serve` rules above.

## Configuration

The dashboard's **Connectors** page is the source of truth for
per-hive Voice EA config. The dispatcher reads from there at call
setup; restart isn't required for config changes.

**Voice EA connector** (slug `voice-ea`) — install once per hive:
- `voiceServicesUrl` — base URL of the GPU-hosted voice services
  (e.g. `http://<gpu-host>:8790`). Hostname:port; no trailing slash.
- `maxMonthlyLlmCents` (optional) — monthly LLM-cost cap in cents.
  Blank or `0` = no cap. When set, the EA verbally warns at 80%,
  downgrades to Sonnet at 100%, and hangs up at 120%.

The connector has a **Test connection** action that probes
`<url>/health` on the GPU host. Run it after editing.

**Env vars (dashboard + dispatcher `.env`):**
- `DATABASE_URL` — Postgres connection string.
- `ENCRYPTION_KEY` — AES-256 key for credential encryption.
- `INTERNAL_SERVICE_TOKEN` — shared bearer for trusted internal callers;
  also used as the HMAC secret for voice session handshake tokens
  (60 s TTL, signed by `/api/voice/direct`, verified by the
  dispatcher's `/api/voice/direct/ws` upgrade handler).
- `VOICE_SERVICES_URL` (optional) — fallback for the GPU URL when no
  `voice-ea` connector install exists. Useful for tests and fresh dev
  boxes; in production the connector is the source of truth.

After editing `.env` (only):

```bash
systemctl --user restart hivewright-dashboard
./scripts/deferred-restart-dispatcher.sh 10
```

## Smoke test

Run this the first time voice EA is live, and again after any
non-trivial change.

### Prerequisites

- `systemctl --user status hivewright-dashboard` is `active`.
- `systemctl --user status hivewright-dispatcher` is `active`.
- Dispatcher logs show `[dispatcher] Voice WS server listening on port
  8791.` — `journalctl --user -u hivewright-dispatcher -n 50 | grep
  -i voice`.
- `curl http://<gpu-ip>:8790/health` returns 200 from the dashboard
  host.
- `sudo tailscale serve status` shows the two rules above and **no
  Funnel rules**.

### Script

1. Open the PWA on your phone (Tailscale on). Tap **Call EA**.
2. First time only: grant mic permission.
3. UI shows **Connecting…** for ~1 s, then **End call**.
4. Speak a short phrase ("hello"). Within ~3 s the EA replies; the
   transcript fills in below the call button.
5. Mid-length test: ask "What goals do I have?" Expect a prose answer.
6. Long-running test: ask "Kick off a dev-agent to audit the ideas
   feed." Expect *"On it — I'll ping you on Discord when that's done."*
   The call ends cleanly (not an error). A Discord post-call summary
   lands within a few seconds.
7. After hangup, in Postgres:
   ```sql
   SELECT id, transport, started_at, ended_at, end_reason
   FROM voice_sessions
   ORDER BY started_at DESC LIMIT 3;
   ```
   Newest row has `transport = 'direct-ws'` and `ended_at` populated.

### Known v1 limitations (by design)

- **No silence timeout.** If you stop talking, the EA stays quiet and
  the session stays open. Tap End call to hang up.
- **No barge-in.** While the EA is speaking, your audio isn't
  transcribed. Wait for it to finish, then speak.
- **No in-browser voiceprint enrolment.** Use the curl flow below.
- **Single-owner auth.** Multi-owner / role-based voice access is
  deferred.
- **PWA only.** No PSTN ingress; no native CallKit.

## Enrolling your voiceprint

Voice EA gates active calls by comparing live audio against a known
owner voiceprint. Before your first real call, enrol a baseline sample.
Record ~10 seconds of clean speech in a quiet room, save as WAV (16 kHz
mono), then:

```bash
curl -X POST \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -F "hiveId=<your-hive-uuid>" \
  -F "sample=@your-sample.wav" \
  https://<host>.ts.net/api/voice/voiceprint/enroll
```

The endpoint forwards the WAV to the GPU `/voiceprint/embed` endpoint,
captures a 192-dim Pyannote embedding, and stores it in
`owner_voiceprints`. Re-enrol any time your voice baseline meaningfully
changes (illness recovery, new microphone, long absence).

## GPU Host Deployment

The voice-services process runs on the LAN GPU machine. This section
covers a clean bring-up.

### Prerequisites on the GPU host

- **Python 3.11+** (`python3 --version`).
- **`uv`** installed — see https://docs.astral.sh/uv/. The systemd unit
  expects the binary at `~/.local/bin/uv`.
- **CUDA 12+** with cuDNN — required by `faster-whisper` (STT),
  `kokoro-onnx` (TTS), and `pyannote.audio` (voiceprint). Confirm with
  `nvidia-smi`.
- **Model caches**:
  - **faster-whisper `large-v3`** — auto-downloads on first STT
    request (~3 GB). Cached under `~/.cache/huggingface/`.
  - **Kokoro** — `~/.cache/kokoro/kokoro-v1.0.onnx` and
    `~/.cache/kokoro/voices-v1.0.bin` must exist before the first TTS
    call; the library does not auto-download them. Grab from the
    `kokoro-onnx` GitHub releases.
  - **Pyannote** — auto-downloads on first voiceprint request, but
    requires a HuggingFace token in the environment.

### Clone + install

```bash
git clone <repo-url> ~/hivewrightv2
cd ~/hivewrightv2/gpu-services/voice
uv sync
```

### Install + start the systemd unit

```bash
mkdir -p ~/.config/systemd/user
cp systemd/voice-services.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now voice-services
loginctl enable-linger $USER
```

### Verify

```bash
systemctl --user status voice-services
curl http://localhost:8790/health
curl http://<gpu-ip>:8790/health
```

Expect a 200 with `{"status": "ok"}`. If the third command fails from
the dashboard host, the GPU host's firewall is blocking port 8790 on the
LAN interface — open it.

## Troubleshooting

- **"voice connection error" on Call EA.** The Tailscale `serve` rule
  for `/api/voice/direct/ws` is missing or pointed at the wrong port.
  `sudo tailscale serve status` should list it pointing at `:8791`.
- **Mic permission prompts every call.** iOS Safari tightens this. Add
  the dashboard hostname to "always allow" in Settings → Safari →
  Camera & Mic.
- **"audio worklet load failed".** Browser couldn't fetch
  `/voice/audio-capture-worklet.js`. Hard-refresh the PWA; if still
  broken, the dashboard build skipped the file (check Next.js build
  output and ensure `public/voice/` exists).
- **Dispatcher logs `[voice-direct-ws] connection setup failed:
  voice-ea connector not configured for this hive`.** Open the
  dashboard's Connectors page and install the **Voice EA** connector
  with the GPU `voiceServicesUrl`. (Or set `VOICE_SERVICES_URL` in
  `.env` as a fallback for fresh dev boxes that haven't run the
  installer yet.)
- **Twilio billing keeps charging.** Phase A (2026-05-07) removed all
  Twilio Voice code paths from this codebase. Cancel the Voice line in
  your Twilio Console: delete the TwiML App, delete the API Key pair
  named `hivewright-voice-ea`. The Twilio SMS connector is unaffected
  and stays.

## What changed in 2026-05-07 Phase A

- Removed: `twilio` + `@twilio/voice-sdk` npm deps, `/api/voice/twiml`,
  `/api/voice/ws` sentinel, `/api/voice/token`, `useVoiceCall` (Twilio
  JS SDK hook), `src/lib/twilio-auth.ts`, `src/lib/twilio-install.ts`,
  the `:8443` Tailscale Funnel for voice paths.
- Renamed: the `twilio-voice` connector slug → `voice-ea`, fields
  trimmed to `voiceServicesUrl` + optional `maxMonthlyLlmCents`. The
  existing install row is migrated automatically by
  `0097_voice_ea_connector_rename.sql`.
- Added: `/api/voice/direct` (token mint), `/api/voice/direct/ws`
  (dispatcher WS handler), `useVoiceCallDirect` hook,
  `public/voice/audio-capture-worklet.js` (PCM downsample + Float32→Int16
  in the browser), `src/lib/voice-services-url.ts` (per-hive connector
  loader with env fallback), `src/lib/voice-session-token.ts` (HMAC
  handshake tokens), `voice_sessions.transport` column.
- Internal implementation notes for this migration are intentionally not part
  of the public repository boundary.
