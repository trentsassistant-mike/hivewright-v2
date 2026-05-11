---
name: voice-transcription
description: "Transcribe audio files (e.g. Discord .ogg voice messages) using the OpenAI Whisper API. Use when: a voice message or audio attachment needs to be converted to text. NOT for: real-time streaming audio, files >25MB."
homepage: https://platform.openai.com/docs/guides/speech-to-text
metadata: { "openclaw": { "emoji": "🎙️", "requires": { "bins": ["curl", "jq"], "env": ["OPENAI_API_KEY"] } } }
---

# Voice Transcription Skill

Transcribe audio files to text using the OpenAI Whisper API.

## When to Use

**USE this skill when:**

- A voice message (e.g. Discord .ogg) needs to be read as text
- An audio recording needs to be converted to text
- A meeting or interview recording needs a transcript
- Any supported audio file needs speech-to-text conversion

## When NOT to Use

**DON'T use this skill when:**

- Real-time or streaming audio transcription is needed
- Audio file is larger than 25MB (Whisper API limit)
- No `OPENAI_API_KEY` is available
- Format is not in the supported list below

## Command Syntax

```bash
bash skills/voice-transcription/transcribe.sh <audio-file-path>
```

The transcription is printed to stdout. All errors go to stderr.

## Supported Formats

`flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `opus`, `wav`, `webm`

## Cost

Whisper API pricing: **$0.006 per minute** of audio.

Every call is logged to `$HOME/hivewright/logs/voice-transcription-cost.log`.

## Error Codes

| Exit Code | Cause |
|-----------|-------|
| 1 | No file path argument provided |
| 1 | File not found at given path |
| 1 | Unsupported file format |
| 1 | `curl` or `jq` not installed |
| 1 | `OPENAI_API_KEY` not set |
| 1 | Whisper API returned non-200 response |
| 1 | Empty or null transcription returned |

## Log Location

`$HOME/hivewright/logs/voice-transcription-cost.log`

Each line: `YYYY-MM-DD HH:MM:SS | file=<basename> | size=<bytes>B | model=whisper-1 | cost=~$0.001-0.006`
