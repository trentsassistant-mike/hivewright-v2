"""
Pyannote-based voiceprint embedder.

`embed_wav` takes raw WAV bytes (any sample rate / channel count that
torchaudio can read), resamples to 16 kHz mono, and runs the pyannote
`wespeaker-voxceleb-resnet34-LM` speaker-embedding model on it. The model
returns a 192-dimension float vector that uniquely identifies a speaker;
two embeddings for the same voice will have a cosine similarity near 1.0,
two different speakers near 0.0.

The model is loaded lazily on first use and pinned to the CUDA device for
the lifetime of the process — the voice-services FastAPI app is a single
long-lived process on the GPU host, so one load amortises across every
`/voiceprint/embed` request.

This module is imported by `voice_services.server` for the
`POST /voiceprint/embed` endpoint and tested by
`tests/test_voiceprint.py` (which requires CUDA + the pyannote model
downloaded on the GPU host — not a CI test).
"""
from __future__ import annotations

import io
import logging

import numpy as np
import torch
from pyannote.audio import Model

logger = logging.getLogger(__name__)

_MODEL: Model | None = None


def _model() -> Model:
    """Load the pyannote speaker-embedding model on first use."""
    global _MODEL
    if _MODEL is None:
        _MODEL = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM")
        _MODEL.to(torch.device("cuda"))
    return _MODEL


def embed_wav(audio_bytes: bytes) -> list[float]:
    """
    Compute a 192-d Pyannote speaker embedding for raw WAV bytes.

    The WAV is loaded via torchaudio (supports any sample rate / channel
    count the underlying decoder can read); anything other than 16 kHz
    mono is resampled. Inference runs under `torch.no_grad()` on CUDA.
    Returns a plain Python list so the caller can JSON-serialise it.
    """
    import torchaudio

    waveform, sr = torchaudio.load(io.BytesIO(audio_bytes))
    if sr != 16000:
        waveform = torchaudio.functional.resample(waveform, sr, 16000)
    with torch.no_grad():
        embedding = _model()(waveform.to("cuda"))
    return embedding.squeeze().cpu().tolist()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """
    Cosine similarity between two embedding vectors.

    Used by the verification path (Task 17) to compare a live-call
    embedding against the enrolled owner voiceprint. Same-speaker pairs
    typically score >0.7; unrelated speakers score near 0.0.
    """
    av = np.asarray(a)
    bv = np.asarray(b)
    return float(np.dot(av, bv) / (np.linalg.norm(av) * np.linalg.norm(bv)))
