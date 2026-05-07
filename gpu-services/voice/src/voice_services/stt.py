from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import numpy as np
from faster_whisper import WhisperModel
from fastapi import WebSocket

logger = logging.getLogger(__name__)

_MODEL: WhisperModel | None = None


def _model() -> WhisperModel:
    """
    Lazy-load the Whisper model. CPU mode with the `small` variant for the v1
    soft-launch — the GPU host's CUDA libraries (libcublas.so.12) are not on
    LD_LIBRARY_PATH yet, so float16 GPU inference fails at runtime. `small`
    on CPU/int8 transcribes a 2 s chunk in ~1-2 s on a modern CPU; acceptable
    for the first end-to-end test. Switch back to ("large-v3", "cuda",
    "float16") once CUDA toolkit (cuBLAS + cuDNN) is set up on the GPU host.
    """
    global _MODEL
    if _MODEL is None:
        _MODEL = WhisperModel(
            "small",
            device="cpu",
            compute_type="int8",
        )
    return _MODEL


async def stream_stt(ws: WebSocket, session_id: str) -> None:
    """
    Consume 16kHz mono 16-bit PCM from the client; emit JSON:
      {type:"final", text, duration_ms}   every CHUNK_TRIGGER bytes and on EOF
      {type:"end"}                        when the stream closes

    v1 has no real VAD/end-of-utterance detection — every ~2 seconds of buffered
    audio becomes one "final" turn, the buffer is cleared, and the next window
    starts fresh. The dispatcher's runtime.ts only acts on "final" frames (see
    wireSttTranscripts), so emitting "partial" mid-call meant the EA never ran
    until the caller hung up. Real VAD-driven utterance boundaries land in v1.5.
    """
    buffer = bytearray()
    CHUNK_TRIGGER = 16_000 * 2 * 2  # 2 seconds of 16-bit mono at 16kHz

    async def flush_final() -> None:
        if not buffer:
            return
        text = await _transcribe(bytes(buffer))
        duration_ms = int((len(buffer) / 2) / 16)  # bytes -> samples -> ms (at 16kHz)
        buffer.clear()
        if text:
            await ws.send_json({
                "type": "final",
                "text": text,
                "duration_ms": duration_ms,
            })

    while True:
        data = await ws.receive_bytes()
        if data == b"":
            break
        buffer.extend(data)
        if len(buffer) >= CHUNK_TRIGGER:
            await flush_final()

    await flush_final()
    await ws.send_json({"type": "end"})


async def _transcribe(pcm: bytes) -> str:
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    loop = asyncio.get_event_loop()
    segments, _ = await loop.run_in_executor(
        None,
        # vad_filter=True drops silent regions before Whisper sees them — kills
        # the "Thank you." hallucination loop that small-model + sample-doubled
        # 8 kHz audio produces on near-silent or noise-only chunks.
        # condition_on_previous_text=False prevents prior hallucinations from
        # priming the next chunk's prediction. Higher no_speech_threshold and
        # compression_ratio_threshold filter out repeat-token hallucination
        # passes without hurting clean-audio recall noticeably.
        lambda: _model().transcribe(
            audio,
            language="en",
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            compression_ratio_threshold=2.4,
        ),
    )
    text = " ".join(seg.text for seg in segments).strip()
    # Belt-and-braces: drop the canonical Whisper hallucinations even if VAD
    # let them through. These are the strings the model emits when it has
    # high confidence on garbage — much more aggressive than just hurting
    # legitimate one-word turns.
    if text.lower().rstrip(".!? ") in {
        "thank you",
        "you",
        "thanks for watching",
        "thanks",
        "bye",
    }:
        return ""
    return text
