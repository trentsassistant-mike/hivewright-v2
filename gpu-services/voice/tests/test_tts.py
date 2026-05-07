import pytest
from fastapi.testclient import TestClient

# Kokoro/CUDA deps won't import on the dev box; skip the whole module if missing
pytest.importorskip("kokoro_onnx")

from voice_services.server import app


def test_tts_stream_emits_audio_chunks() -> None:
    with TestClient(app) as client:
        with client.websocket_connect("/tts/stream") as ws:
            ws.send_json({"type": "text", "text": "Hello, this is a test."})
            ws.send_json({"type": "eof"})

            total_bytes = 0
            while True:
                msg = ws.receive()
                t = msg.get("type")
                if t == "websocket.receive" and "bytes" in msg:
                    total_bytes += len(msg["bytes"])
                elif t == "websocket.receive" and "text" in msg:
                    # JSON control frame (e.g. final {type:"end"}); ignore
                    pass
                elif t == "websocket.disconnect":
                    break

    # "Hello, this is a test." is >1s @ 24kHz int16 mono ≈ ~48KB
    assert total_bytes > 20_000
