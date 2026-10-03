# pi-voice

Voice wake-word input + speech output for Pi (macOS). Say **"hey pi"** or
**"hi pi"**, speak a prompt, and hear the assistant reply.

## What it does

- **Local wake detection** (Sherpa ONNX keyword spotter, offline). The mic
  only streams to the network after the wake word fires.
- **Speech-to-text** via ElevenLabs Scribe realtime with manual commits:
  post-wake audio becomes a Pi prompt. While Pi is busy the transcript queues
  as a follow-up.
- **Text-to-speech** (optional, `/voice tts on`): assistant prose streams to
  ElevenLabs and plays locally. Code, URLs, and link destinations are never
  spoken. Saying the wake word (or typing) barges in and cancels playback.
- One `/voice` slash command with subcommand completions; footer status
  (`🎙 listening`, live partials, `🎙 transcribing…`, `🔊 speaking`, `voice off`).

## After "hey pi"

1. The mic streams to Scribe; local Silero VAD watches for end-of-speech.
2. ~0.8 s of silence ends the turn: the utterance is committed manually and the
   transcript follows, typically ~0.3 s later.
3. Say "hey pi" / "hi pi" during TTS playback (or type) to barge in: playback
   stops and a new capture starts.

## Send modes (`/voice send auto|review`)

- `auto` (default): the transcript submits as a Pi prompt immediately.
- `review`: dictation lands in the Pi editor instead. Submit it with Enter,
  by saying "send to pi", by saying "hey pi, send" (also "send it", "submit"),
  or by ending a dictation with "…send to pi".
- Standalone "send to pi" is a keyword-spotter command: it fires without STT,
  is usually caught right after a dictation, but is missed fairly often after a
  long silence (local spotter limitation). "hey pi, send" goes through STT and
  is the dependable path.

## Privacy and cost

- Wake detection runs fully on-device; no audio leaves the machine until the
  wake word fires. An accidental wake can still submit overheard room audio
  as a prompt — keep the mic off when not in use.
- After the wake word, microphone audio goes to ElevenLabs (Scribe). With
  TTS on, the assistant's prose goes to ElevenLabs (TTS). Both are billable
  ElevenLabs usage.
- The API key comes only from `ELEVENLABS_API_KEY`. It is never stored,
  logged, or shown (status shows the last 4 characters only).
- Preferences (voice, wake phrase, sensitivity, mic, autostart, TTS, TTS
  model, send mode) live in `~/Library/Application Support/pi-voice/state.json`.
  No transcripts, audio, or keys are persisted there.

## Install

```sh
pi install ~/pi-voice
# add to ~/.zshrc, then restart the shell / Pi:
export ELEVENLABS_API_KEY="..."
```

Then inside Pi:

```
/voice setup   # checks ffmpeg/ffplay, provisions the wake model, mic help
/voice on      # enable the mic for this session
/voice tts on  # needs a selected voice: /voice <voice-id>
```

## Command reference

| Input | Behavior |
|---|---|
| `/voice`, `/voice status` | Mic state, wake mode, device, TTS state, voice, key suffix |
| `/voice on`, `/voice off` | Start/stop wake listening for this session |
| `/voice setup` | Check binaries/env, provision the wake-word and VAD models, mic-permission guidance. Does not enable the mic |
| `/voice tts on\|off` | Session speech toggle (saved); `on` needs key + voice |
| `/voice list` | List ElevenLabs voices (needs key) |
| `/voice <voice-id>` | Select the TTS voice by id (saved, no key needed) |
| `/voice id <id>` | Select the TTS voice by id (explicit form) |
| `/voice model [id]` | List or select the TTS model (default `eleven_v4_turbo`) |
| `/voice wake hey-pi\|hi-pi\|both` | Which phrases the local spotter listens for |
| `/voice sensitivity low\|normal\|high` | Detection strictness (default `normal`) |
| `/voice mic list\|default\|<name>` | Pick by AVFoundation device name; quote names with spaces (`"iPhone Microphone"`). A missing saved mic falls back to default with a notice |
| `/voice autostart on\|off` | Auto-listen at session start when the model is cached and the key is present (default on; never downloads at startup) |
| `/voice send auto\|review` | `auto` submits transcripts immediately; `review` stages them in the Pi editor. Bare `/voice send` shows the current mode |
| `/voice test mic\|wake\|stt\|tts` | `mic`: 2 s capture with input level; `wake`: ~10 s offline listen (nothing submitted); `stt`: 8 s live capture reporting commit→transcript latency; `tts`: billable spoken test phrase |
| `/voice help` | This summary in-session |

## iPhone as mic, barge-in

- An iPhone with Continuity Camera/mic appears as an AVFoundation device;
  select it with `/voice mic "iPhone Microphone"`. Remote/phone-call audio
  beyond the local device list is out of scope.
- There is no acoustic echo cancellation: speaker playback can re-trigger
  the wake word. A **headset is recommended** for reliable barge-in. After
  playback the pipeline applies a short cooldown and resets the detector.

## Feedback

- `🎙 didn't catch that`: speech ended but produced no transcript. `🎙 didn't hear
  anything`: 5 s of capture with no speech at all. Both play an error cue and
  return to listening; nothing is submitted.
- Retryable failures (network errors, rate limits): warning notification plus
  error cue, then back to listening.
- Fatal failures (bad credentials, quota/terms, mic errors): voice stops with
  an error notification. Fix the cause, then re-run `/voice setup` or `/voice on`.
- Mic stalls auto-restart with backoff (1 s, 2 s, 4 s) before giving up and
  switching off. Permission denial stops immediately with macOS guidance.
- Pure digital silence from the mic triggers a warning that the terminal app
  is likely denied microphone access.

## Troubleshooting

- **Mic permission denied:** grant the terminal app Microphone access in
  System Settings → Privacy & Security → Microphone, then restart Pi.
- **`Export ELEVENLABS_API_KEY and restart Pi`:** the key is read at session
  start; exporting it mid-session is not enough.
- **`/voice test tts` fails:** needs key + selected voice (`/voice list` to browse).
- **No wake word heard:** try `/voice sensitivity high`, or
  `/voice test wake` to check detection without submitting anything.
- **STT issues:** run `/voice test stt` and speak; it reports the transcript
  and commit→transcript latency, or the failure cause.
- **Pipeline trace:** `PI_VOICE_DEBUG=1` writes a redacted JSONL log to
  `~/Library/Application Support/pi-voice/debug.jsonl` (keys and secret-like
  values redacted, 1 MB rotation). Restart Pi after exporting it.

## Manual live smoke checklist

1. `/voice setup` → model provisioned, binaries found.
2. `/voice on` → footer shows `🎙 listening`.
3. Say "hey pi", speak a short request → transcript submits once; status
   shows the level meter plus partial text mid-utterance, then `🎙 transcribing…`.
4. While Pi streams a reply with TTS on → footer shows `🔊 speaking`;
   say "hey pi" → speech stops (barge-in).
5. `/voice off` → `voice off`, mic process gone (`pgrep ffmpeg` empty).
6. Restart Pi with autostart on → listening resumes without downloading.
