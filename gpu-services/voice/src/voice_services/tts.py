from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import numpy as np
from fastapi import WebSocket
from kokoro_onnx import Kokoro

logger = logging.getLogger(__name__)

_MODEL: Kokoro | None = None
VOICE = "af_sky"  # preselected for v1; revisit with auditions later
SAMPLE_RATE = 24_000


def _model() -> Kokoro:
    global _MODEL
    if _MODEL is None:
        root = Path.home() / ".cache/kokoro"
        _MODEL = Kokoro(
            model_path=str(root / "kokoro-v1.0.onnx"),
            voices_path=str(root / "voices-v1.0.bin"),
        )
    return _MODEL


async def stream_tts(ws: WebSocket) -> None:
    """
    Consume JSON frames from the client:
      {type:"text", text: "..."}   synthesize this chunk
      {type:"eof"}                 flush + end the stream

    Emit 24kHz mono int16 PCM as binary frames, then a final JSON
    {type:"end"} when done.
    """
    loop = asyncio.get_event_loop()
    while True:
        msg = await ws.receive_json()
        if msg.get("type") == "eof":
            break
        text = (msg.get("text") or "").strip()
        if not text:
            continue
        samples = await loop.run_in_executor(None, lambda: _synth(text))
        await ws.send_bytes(samples.tobytes())
    await ws.send_json({"type": "end"})


def _synth(text: str) -> np.ndarray:
    samples, _rate = _model().create(text, voice=VOICE, speed=1.0)
    return (samples * 32_767).astype(np.int16)
