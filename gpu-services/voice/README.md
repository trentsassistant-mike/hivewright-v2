# voice-services

Python FastAPI project that hosts HiveWright's GPU-side voice stack (STT via faster-whisper, TTS via kokoro-onnx, and voiceprint enrolment/verification via pyannote.audio). The TypeScript dispatcher talks to this service over HTTP/WebSocket; nothing in the Next.js app imports from here. For the end-to-end voice EA design, deployment, and Tailscale Funnel setup, see the main runbook at [`docs/voice-ea/README.md`](../../docs/voice-ea/README.md).

## Local scaffolding only on the dev box

This project is designed to run on the GPU host. Several dependencies (`faster-whisper`, `kokoro-onnx`, `pyannote.audio`, `silero-vad`) pull in CUDA libraries and will not install cleanly on the HiveWright dev box. On the dev box we only validate that `pyproject.toml` parses; the full `uv sync` and `pytest` run happen on the GPU machine.

## GPU host setup

```bash
cd gpu-services/voice
uv sync --extra dev      # installs all runtime + dev deps
uv run pytest            # should print 1 passed (tests/test_health.py)
uv run uvicorn voice_services.server:app --host 0.0.0.0 --port 8100
```

`GET /health` returns `{"status": "ok"}` once the server is up.
