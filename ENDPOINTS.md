# Reel Server — API Endpoints

Base URL: `http://localhost:4000` (or ngrok URL when live)

---

## Sessions

### `POST /session`
Start a new conversation session. Returns a `sessionId`.
```json
Response: { "sessionId": "uuid" }
```

### `POST /session/:id/message`
Send a message to Gemini to collect video context (type, energy, music, etc.).
```json
Body:    { "text": "make a motivational founder reel, high energy" }
Response: { "reply": "...", "context": {...}, "ready": true/false }
```
When `ready: true`, you can submit a project.

### `GET /session/:id`
Check current session state.
```json
Response: { "sessionId": "...", "context": {...}, "ready": bool, "messageCount": 2 }
```

---

## Projects / Jobs

### `POST /project`
Upload video clips and kick off a render job. Accepts `multipart/form-data`.

| Field | Type | Description |
|-------|------|-------------|
| `videos` | File[] | One or more video clips |
| `sessionId` | string (optional) | Session ID for Gemini style config |
| `musicId` | string (optional) | Music track ID from `POST /music` |
| `script` | string (optional) | Custom voiceover script → triggers Rumic TTS |
| `descriptions` | JSON string array (optional) | Per-clip descriptions |

**Motivational mode**: If the session message contained the word `"motivational"`, the pipeline auto-generates a motivational script and uses Rumic TTS — no extra params needed.

```bash
# Quick example
SESSION=$(curl -s -X POST http://localhost:4000/session | jq -r '.sessionId')
curl -s -X POST http://localhost:4000/session/$SESSION/message \
  -H "Content-Type: application/json" \
  -d '{"text":"motivational founder reel, high energy bold captions"}'
curl -s -X POST http://localhost:4000/project \
  -F "videos=@/path/to/clip.mp4" \
  -F "sessionId=$SESSION"
```

```json
Response: { "jobId": "uuid", "status": "pending" }
```

### `GET /project/:id`
Poll job status.
```json
Response: { "jobId": "uuid", "status": "pending|transcribing|rendering|done|error", "error": null }
```

### `GET /project/:id/download`
Stream the final MP4 once status is `done`.
```bash
curl http://localhost:4000/project/<jobId>/download -o output.mp4
```

---

## Music

### `POST /music`
Upload a background music track. Returns a `musicId` to use in `POST /project`.
```bash
curl -X POST http://localhost:4000/music -F "audio=@track.mp3"
```
```json
Response: { "musicId": "uuid", "filename": "uuid.mp3" }
```

---

## Voice (stub — Phase 4)

### `POST /voice`
Raw audio upload endpoint (reserved for future Telegram/WhatsApp voice note forwarding).
