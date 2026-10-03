# ElevenLabs API Specification Brief (2026)

## 1. Realtime Speech-to-Text (STT): Scribe Realtime

### Endpoint URL
- Primary: `wss://api.elevenlabs.io/v1/speech-to-text/realtime`
- Regional US: `wss://api.us.elevenlabs.io/v1/speech-to-text/realtime`
- Regional EU: `wss://api.eu.residency.elevenlabs.io/v1/speech-to-text/realtime`
- Source: [ElevenLabs Realtime STT API Reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)

### Authentication
Two methods supported:
1. Header: `xi-api-key: <ELEVENLABS_API_KEY>` (supported server-side / Node).
2. Query param: `?token=<SINGLE_USE_TOKEN>` created via `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe`. Token expires in 15 minutes, consumed on connect.
- Source: [Create Single Use Token](https://elevenlabs.io/docs/api-reference/tokens/create)

### Query Parameters
- `model_id`: Model ID. Must use `scribe_v2_realtime` (`scribe_v1` deprecated/removed mid-2026; source: [Changelog 2026/6/8](https://elevenlabs.io/docs/changelog/2026/6/8)).
- `audio_format`: Audio encoding format. Default `pcm_16000`. Options: `pcm_8000`, `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_44100`, `pcm_48000`, `ulaw_8000`.
- `language_code`: ISO 639-1 or 639-3 code (e.g. `eng`). Default `null` (auto-detect).
- `secondary_languages`: List of expected languages for multi-language detection.
- `commit_strategy`: `"manual"` (default) or `"vad"`.
- `vad_threshold`: Float `0.1` to `0.9` (default `0.4`, lower = more sensitive).
- `vad_silence_threshold_secs`: Float `0.3` to `3.0` (default `1.5` seconds silence to commit).
- `min_speech_duration_ms`: Integer `50` to `2000` (default `100`).
- `min_silence_duration_ms`: Integer `50` to `2000` (default `100`).
- `include_timestamps`: Boolean (default `false`). When `true`, returns word-level timestamps.
- `keyterms`: Array of strings (up to 1000 terms, <50 chars each) to bias ASR (+20% cost surcharge).
- `entity_detection`: Enable entity extraction (+30% cost surcharge).

### Audio Format Requirements
- Raw PCM signed 16-bit little-endian (`pcm_s16le`), mono, 16000 Hz (matching `pcm_16000`).
- Chunk size: Recommended 8 KB chunks (~250ms of audio at 16kHz 16-bit mono).
- Chunks encoded as base64 strings in `audio_base_64`.

### Message Protocol

#### Client -> Server: `InputAudioChunk`
Source: [ElevenLabs Realtime STT API Reference](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
```json
{
  "message_type": "input_audio_chunk",
  "audio_base_64": "UklGRi...",
  "commit": false,
  "sample_rate": 16000,
  "previous_text": "Optional context for first chunk only"
}
```
*Note: `previous_text` allowed only on first chunk; sending on subsequent chunks throws error.*

#### Server -> Client: `SessionStarted`
```json
{
  "message_type": "session_started",
  "session_id": "sess_01j7xyz...",
  "config": {
    "sample_rate": 16000,
    "audio_format": "pcm_16000",
    "language_code": "eng",
    "commit_strategy": "vad",
    "vad_silence_threshold_secs": 1.5,
    "vad_threshold": 0.4,
    "min_speech_duration_ms": 100,
    "min_silence_duration_ms": 100,
    "model_id": "scribe_v2_realtime"
  }
}
```

#### Server -> Client: `PartialTranscript`
```json
{
  "message_type": "partial_transcript",
  "text": "what is the status"
}
```

#### Server -> Client: `CommittedTranscript`
```json
{
  "message_type": "committed_transcript",
  "text": "What is the status of the build?"
}
```

#### Server -> Client: `CommittedTranscriptWithTimestamps` (when `include_timestamps=true`)
```json
{
  "message_type": "committed_transcript_with_timestamps",
  "text": "What is the status",
  "words": [
    {
      "text": "What",
      "start": 0.12,
      "end": 0.35,
      "type": "word"
    },
    {
      "text": "is",
      "start": 0.36,
      "end": 0.45,
      "type": "word"
    }
  ]
}
```

#### Server -> Client Error Types
- Message types: `scribe_error`, `scribe_auth_error`, `scribe_quota_exceeded_error`, `scribe_throttled_error`, `scribe_rate_limited_error`, `scribe_queue_overflow_error`, `scribe_input_error`, `scribe_invalid_request_error`.

### Pricing & Limits
- Scribe v2 Realtime: $0.39 per hour ($0.0065/min). Billed per second of audio.
- Limits: In manual commit mode, engine auto-commits every ~36s if client does not commit. Minimum 2s audio before initial transcript emits.
- Source: [ElevenLabs Pricing](https://elevenlabs.io/pricing/api) & [Transcripts and Commit Strategies Guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies.mdx)

### Batch STT Fallback
- Endpoint: `POST https://api.elevenlabs.io/v1/speech-to-text`
- Headers: `xi-api-key: <KEY>`
- Body: `multipart/form-data`:
  - `model_id`: `"scribe_v2"`
  - `file`: binary audio file (min 100ms, max 5GB)
  - `language_code`: optional ISO code
- Price: $0.22 per hour.
- Source: [Create Transcript Reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert)

---

## 2. Streaming Text-to-Speech (TTS) for LLM Output

### WebSocket Endpoints
- Single-context: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input`
- Multi-context: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input`
- Source: [TTS Stream Input WebSocket](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input) & [Multi-Context WebSocket](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input)

### Handshake & Query Parameters
- `model_id`: Low latency recommendation is `eleven_flash_v2_5` (~75ms latency) or `eleven_turbo_v2_5`.
  *CRITICAL WARNING:* Official docs explicitly state `eleven_v3` is **NOT supported** on `/v1/text-to-speech/{voice_id}/stream-input`. Eleven v3 over WebSocket requires Text-to-Dialogue endpoint `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input` or HTTP streaming.
  Source: [Realtime TTS Guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts) & [TTS vs TTD WebSockets](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets).
- `output_format`: Default `mp3_44100_128`. Latency-optimal raw options: `pcm_16000`, `pcm_22050`, `pcm_24000`, `pcm_44100` (Pro+ tier required for pcm_44100), `ulaw_8000`.
- `auto_mode`: Boolean (optional). Enables automatic generation triggering.
- `inactivity_timeout`: Integer seconds (up to 180s, default 20s) before socket disconnects on idle.

### Single-Context Protocol (`/stream-input`)

#### 1. Initial Handshake Message (`InitializeConnection`)
Must start with blank space `" "`. Voice settings and chunk schedule configured here:
```json
{
  "text": " ",
  "voice_settings": {
    "stability": 0.5,
    "similarity_boost": 0.8,
    "use_speaker_boost": false
  },
  "generation_config": {
    "chunk_length_schedule": [120, 160, 250, 290]
  },
  "xi_api_key": "<ELEVENLABS_API_KEY>"
}
```
*Note: `xi_api_key` can be sent in first message body if header not supplied.*

#### 2. Streaming Text Message (`SendText`)
Each chunk must end with space `" "`:
```json
{
  "text": "The compilation finished with zero errors. ",
  "try_trigger_generation": false,
  "flush": false
}
```
- `chunk_length_schedule`: Buffer triggers generation at character count steps (default: 120, 160, 250, 290 chars).
- `flush: true`: Forces immediate generation of buffered text without closing connection (use at end of LLM response sentence/turn).
- `try_trigger_generation: true`: Advanced flag; overrides schedule only if buffer exceeds minimum character threshold.

#### 3. Close Message (`CloseConnection`)
```json
{
  "text": ""
}
```
Empty string `""` signals end of text stream; server generates remaining audio and closes socket.

#### 4. Server -> Client Audio Message (`AudioOutput`)
```json
{
  "audio": "SUQzBAAAAA...",
  "isFinal": false,
  "normalizedAlignment": null,
  "alignment": null
}
```
When `isFinal: true`, all audio generated.

### Multi-Context Protocol (`/multi-stream-input`)
Allows up to 5 concurrent independent streams over 1 socket (ideal for user barge-in / interruptions).
- Initial message:
```json
{
  "text": " ",
  "context_id": "turn_1",
  "voice_settings": { "stability": 0.5, "similarity_boost": 0.8 }
}
```
- Streaming chunks: `{"text": "Hello world ", "context_id": "turn_1"}`
- Flush context: `{"context_id": "turn_1", "flush": true}`
- Handle barge-in: `{"context_id": "turn_1", "close_context": true}`, then send new response with `context_id: "turn_2"`.
- Close whole socket: `{"close_socket": true}`
- Source: [Multi-Context WebSocket Guide](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket)

### HTTP Streaming Alternative
- Endpoint: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128`
- Supports `eleven_v3`, `eleven_multilingual_v2`, and `eleven_flash_v2_5`.
- Audio returned directly as chunked transfer encoding stream (`Transfer-Encoding: chunked`).
- Source: [Stream Speech API Reference](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)

---

## 3. Voices API & Validation

### Endpoints
- Preferred/Current: `GET https://api.elevenlabs.io/v2/voices` (supports search, pagination, filtering; source: [Changelog](https://elevenlabs.io/docs/changelog)).
- Legacy: `GET https://api.elevenlabs.io/v1/voices` (hard capped at 500 voices; source: [List Voices Legacy](https://elevenlabs.io/docs/api-reference/legacy/voices/get-all)).
- Specific voice: `GET https://api.elevenlabs.io/v1/voices/{voice_id}`.

### Voice Object Fields
Key response fields from `GET /v2/voices` or `GET /v1/voices`:
```json
{
  "voices": [
    {
      "voice_id": "21m00Tcm4TlvDq8ikWAM",
      "name": "Rachel",
      "category": "premade",
      "labels": {
        "accent": "american",
        "gender": "female",
        "use_case": "conversational"
      },
      "preview_url": "https://storage.googleapis.com/..."
    }
  ]
}
```

### Commonly Used Premade Voice IDs
- **Rachel**: `21m00Tcm4TlvDq8ikWAM` (Calm, conversational female)
- **George**: `JBFqnCBsd6RMkjVDRZzb` (Warm, British male - standard ElevenLabs demo voice)
- *2026 deprecation note:* Official ElevenLabs docs state original Default premade voices will be retired after December 31, 2026; library-cloned / community / modern premade voices persist. Source: [Voices Capabilities Overview](https://elevenlabs.io/docs/overview/capabilities/voices).

### API Key Validation
- Endpoint: `GET https://api.elevenlabs.io/v1/user`
- Headers: `xi-api-key: <KEY>`
- Success (HTTP 200):
```json
{
  "user_id": "usr_...",
  "subscription": {
    "tier": "starter",
    "status": "active",
    "character_count": 12500,
    "character_limit": 30000
  },
  "is_onboarding_completed": true
}
```
- Invalid key (HTTP 401): Returns status code 401 with `{ "detail": { "status": "invalid_api_key", "message": "Invalid API key" } }`.
- Source: [Get User Reference](https://elevenlabs.io/docs/api-reference/user/get)

---

## 4. Wake-Word / Keyword Spotting Feature

- **Result:** ElevenLabs **DOES NOT** provide wake-word or keyword spotting APIs.
- Official ElevenLabs tutorial for Raspberry Pi voice assistants ([Raspberry Pi Voice Assistant Guide](https://elevenlabs.io/docs/eleven-agents/guides/integrations/raspberry-pi-voice-assistant)) instructs developers to use open-source local keyword detectors (`eff_word_net` / EfficientWord-Net, openWakeWord, or Porcupine).
- Tutorial uses ElevenLabs only to generate synthetic audio samples via TTS to train local hotword models.
- **Action for Pi extension:** Must implement local wake-word engine in Node/macOS (e.g. Porcupine node SDK, `@picovoice/porcupine-node`, or local ONNX openWakeWord runner) rather than calling ElevenLabs.

---

## 5. Official SDK vs Raw `ws` / `fetch` in Node 25

### Node 25 Global `WebSocket` vs Headers
- Node 22+ includes global `WebSocket` backed by Undici.
- WHATWG standard specifies `new WebSocket(url, protocols)` where protocols is string or array.
- Undici implements custom extension: `new WebSocket(url, { headers: { 'xi-api-key': key } })`.
- However, WHATWG compatibility flags and standard browser compliance can strip or reject options in strict environments.

### ElevenLabs Fallback Auth Options if Headers Unavailable
1. **Scribe Realtime STT:**
   - Call `POST https://api.elevenlabs.io/v1/single-use-token/realtime_scribe` with header `xi-api-key: <KEY>`.
   - Receive `{ "token": "sutkn_..." }`.
   - Connect: `new WebSocket("wss://api.elevenlabs.io/v1/speech-to-text/realtime?token=" + token)`.
2. **TTS Stream Input WebSocket:**
   - Include API key directly in first JSON payload (`"xi_api_key": "<KEY>"` inside `InitializeConnection` message).
   - Alternatively: use `POST https://api.elevenlabs.io/v1/single-use-token/tts_websocket` and connect with `?single_use_token=${token}`.

### SDK vs Raw Recommendation
- **Recommendation:** Use standard npm package `ws` (or raw WebSocket with single-use tokens) for Realtime STT and Streaming TTS.
- **Reasons:**
  1. `@elevenlabs/elevenlabs-js` is primarily designed for REST endpoints and HTTP chunked streams (`client.textToSpeech.stream(...)`, `client.user.get()`, `client.voices.getAll()`).
  2. For bidirectional full-duplex WebSockets with PCM buffer piping from macOS microphone and streaming back to `ffplay` audio output, raw WebSocket (`ws` or Node global) gives zero-overhead control over chunk boundaries, backpressure, and VAD commits.
  3. REST operations (`GET /v1/user`, `GET /v2/voices`, `POST /v1/speech-to-text`) run reliably with native Node 25 `fetch` without requiring the heavy SDK bundle.