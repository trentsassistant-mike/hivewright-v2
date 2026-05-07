import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from voice_services.server import app

FIXTURE = Path(__file__).parent / "fixtures" / "sample-16k.wav"


def _frames_from_wav(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wf:
        assert wf.getframerate() == 16000
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        return wf.readframes(wf.getnframes())


@pytest.mark.skipif(
    not FIXTURE.exists(),
    reason=(
        "STT integration test requires tests/fixtures/sample-16k.wav; record on "
        "the GPU host with: arecord -f S16_LE -r 16000 -c 1 -d 3 "
        "gpu-services/voice/tests/fixtures/sample-16k.wav (say 'hello world testing')"
    ),
)
def test_stt_stream_returns_final_transcript() -> None:
    audio = _frames_from_wav(FIXTURE)
    chunk_size = 16_000 * 2  # 1s of 16-bit mono PCM

    with TestClient(app) as client:
        with client.websocket_connect("/stt/stream?session_id=test") as ws:
            for i in range(0, len(audio), chunk_size):
                ws.send_bytes(audio[i : i + chunk_size])
            ws.send_bytes(b"")  # EOF sentinel
            finals: list[dict] = []
            while True:
                msg = ws.receive_json(timeout=30)
                if msg.get("type") == "final":
                    finals.append(msg)
                if msg.get("type") == "end":
                    break

    assert finals, "expected at least one final transcript"
    combined = " ".join(f["text"] for f in finals).lower()
    assert "hello" in combined or "testing" in combined
