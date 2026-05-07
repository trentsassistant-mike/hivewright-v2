"""
GPU-host test for the voiceprint embedder.

This test requires:
  * CUDA-capable GPU on the host,
  * The pyannote `wespeaker-voxceleb-resnet34-LM` model downloaded and
    accessible (first-run auto-download needs a HuggingFace token and
    accepted licence on the Hub),
  * `torchaudio` + the pyannote/torch dependencies installed via
    `uv sync` in `gpu-services/voice/`.

It is NOT run in CI. Execute manually on the GPU host after deploy:

    cd gpu-services/voice
    uv run pytest tests/test_voiceprint.py

The fixture WAV (`tests/fixtures/sample-16k.wav`) is generated at test
time as 1 second of 16 kHz mono silence so we do not commit binary
audio to the repo. The embedding is non-zero even for silence (the model
always outputs a 192-d vector) which is enough to exercise the shape
contract end-to-end.
"""
from __future__ import annotations

import struct
import wave
from pathlib import Path

from fastapi.testclient import TestClient

FIXTURES_DIR = Path(__file__).parent / "fixtures"
FIXTURE = FIXTURES_DIR / "sample-16k.wav"


def _ensure_fixture() -> None:
    """Create 1 s of 16 kHz mono silence if the fixture is missing."""
    if FIXTURE.exists():
        return
    FIXTURES_DIR.mkdir(exist_ok=True)
    with wave.open(str(FIXTURE), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)  # 16-bit PCM
        w.setframerate(16000)
        # 1 second of silence = 16000 samples * 2 bytes/sample.
        w.writeframes(b"\x00" * 16000 * 2)


def test_voiceprint_embed_returns_192d_vector() -> None:
    """
    POST a WAV to /voiceprint/embed and assert the response is a 192-d
    list of floats. Requires CUDA + pyannote model — skip by not invoking
    pytest on machines without them.
    """
    _ensure_fixture()

    # Imported lazily so failed model imports (missing torch/pyannote in
    # minimal envs) show up as test errors, not collection errors.
    from voice_services.server import app

    with TestClient(app) as client:
        with FIXTURE.open("rb") as f:
            wav_bytes = f.read()
        response = client.post(
            "/voiceprint/embed",
            content=wav_bytes,
            headers={"Content-Type": "audio/wav"},
        )

    assert response.status_code == 200
    body = response.json()
    assert "embedding" in body
    embedding = body["embedding"]
    assert isinstance(embedding, list)
    assert len(embedding) == 192
    assert all(isinstance(v, float) for v in embedding)
