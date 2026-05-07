from fastapi import FastAPI, Request, WebSocket

from voice_services.stt import stream_stt
from voice_services.tts import stream_tts
from voice_services.voiceprint import embed_wav

app = FastAPI(title="HiveWright Voice Services")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/stt/stream")
async def stt_stream(websocket: WebSocket, session_id: str = "") -> None:
    await websocket.accept()
    await stream_stt(websocket, session_id)
    await websocket.close()


@app.websocket("/tts/stream")
async def tts_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    await stream_tts(websocket)
    await websocket.close()


@app.post("/voiceprint/embed")
async def voiceprint_embed(request: Request) -> dict:
    """
    Compute a Pyannote speaker embedding for a WAV upload.

    Accepts raw WAV bytes in the request body (no multipart); returns
    ``{"embedding": [192 floats]}``. The dashboard's
    `/api/voice/voiceprint/enroll` route forwards uploads here during
    voiceprint enrolment (Task 16) and during live-call verification
    (Task 17).
    """
    body = await request.body()
    return {"embedding": embed_wav(body)}
