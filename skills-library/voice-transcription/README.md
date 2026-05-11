# Voice Transcription Skill

Transcribes audio files to text using the [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text).

## Prerequisites

- `curl` installed
- `jq` installed
- `OPENAI_API_KEY` environment variable set

## Usage

```bash
bash skills/voice-transcription/transcribe.sh <audio-file-path>
```

The transcription is printed to stdout. Errors go to stderr.

### Examples

```bash
# Transcribe a Discord voice message
bash skills/voice-transcription/transcribe.sh ~/Downloads/voice-message.ogg

# Capture transcription in a variable
text=$(bash skills/voice-transcription/transcribe.sh ~/recordings/meeting.mp3)
echo "$text"

# Transcribe and save to file
bash skills/voice-transcription/transcribe.sh ~/recordings/interview.wav > transcript.txt
```

## Supported Formats

`flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `opus`, `wav`, `webm`

Maximum file size: 25MB (Whisper API limit).

## Discord Integration

Discord voice messages are saved as `.ogg` files. Download the attachment and pass the path directly:

```bash
bash skills/voice-transcription/transcribe.sh voice-message.ogg
```

## Cost

Whisper API pricing: **$0.006 per minute** of audio.

Typical costs:
- 30-second voice message: ~$0.003
- 5-minute recording: ~$0.030
- 1-hour meeting: ~$0.360

Every call is logged to `$HOME/hivewright/logs/voice-transcription-cost.log`.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `OPENAI_API_KEY environment variable is not set` | Missing API key | Export `OPENAI_API_KEY` |
| `File not found` | Path does not exist | Check the file path |
| `Unsupported file format` | Extension not in supported list | Convert file to a supported format |
| `curl is not installed` | Missing dependency | `sudo apt install curl` or equivalent |
| `jq is not installed` | Missing dependency | `sudo apt install jq` or equivalent |
| `Whisper API error (HTTP 401)` | Invalid API key | Check `OPENAI_API_KEY` value |
| `Whisper API error (HTTP 413)` | File too large | Ensure file is under 25MB |
| `Empty or null transcription returned` | Silent audio or API issue | Verify audio contains speech |

## Log Location

`$HOME/hivewright/logs/voice-transcription-cost.log`

Format: `YYYY-MM-DD HH:MM:SS | file=<basename> | size=<bytes>B | model=whisper-1 | cost=~$0.001-0.006`
