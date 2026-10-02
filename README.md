# pi-voice

Voice wake-word input + speech output for Pi (macOS). Say **"hey pi"** or
**"hi pi"**, speak a prompt, and hear the assistant reply.

## What it does

- **Local wake detection** (Sherpa ONNX keyword spotter, offline). The mic
  only streams to the network after the wake word fires.
- **Speech-to-text** via ElevenLabs Scribe realtime: post-wake audio becomes
  a Pi prompt. While Pi is busy the transcript queues as a follow-up.
- **Text-to-speech** (optional, `/voice tts on`): assistant prose streams to
  ElevenLabs and plays locally. Code, URLs, and link destinations are never
  spoken. Saying the wake word (or typing) barges in and cancels playback.
- One `/voice` slash command with subcommand completions; footer status
  (`🎙 listening`, `🎙 hearing: …`, `🔊 speaking`, `voice off`).

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
  model) live in `~/Library/Application Support/pi-voice/state.json`.
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
/voice tts on  # needs a selected voice: /voice voice <id>
```

## Command reference

| Input | Behavior |
|---|---|
| `/voice`, `/voice status` | Mic state, wake mode, device, TTS state, voice, key suffix |
| `/voice on`, `/voice off` | Start/stop wake listening for this session |
| `/voice setup` | Check binaries/env, provision the wake model, mic-permission guidance. Does not enable the mic |
| `/voice tts on\|off` | Session speech toggle (saved); `on` needs key + voice |
| `/voice voice [id]` | List ElevenLabs voices or select one by id |
| `/voice model [id]` | List or select the TTS model (default `eleven_v4_turbo`) |
| `/voice wake hey-pi\|hi-pi\|both` | Which phrases the local spotter listens for |
| `/voice sensitivity low\|normal\|high` | Detection strictness (default `normal`) |
| `/voice mic list\|default\|<name>` | Pick by AVFoundation device name; quote names with spaces (`"iPhone Microphone"`). A missing saved mic falls back to default with a notice |
| `/voice autostart on\|off` | Auto-listen at session start when the model is cached and the key is present (default on; never downloads at startup) |
| `/voice test mic\|wake\|tts` | Local mic capture / ~10 s offline wake listen (nothing submitted) / billable spoken test phrase |
| `/voice help` | This summary in-session |

## iPhone as mic, barge-in

- An iPhone with Continuity Camera/mic appears as an AVFoundation device;
  select it with `/voice mic "iPhone Microphone"`. Remote/phone-call audio
  beyond the local device list is out of scope.
- There is no acoustic echo cancellation: speaker playback can re-trigger
  the wake word. A **headset is recommended** for reliable barge-in. After
  playback the pipeline applies a short cooldown and resets the detector.

## Troubleshooting

- **Mic permission denied:** grant the terminal app Microphone access in
  System Settings → Privacy & Security → Microphone, then restart Pi.
- **`Export ELEVENLABS_API_KEY and restart Pi`:** the key is read at session
  start; exporting it mid-session is not enough.
- **`/voice test tts` fails:** needs key + selected voice (`/voice voice`).
- **No wake word heard:** try `/voice sensitivity high`, or
  `/voice test wake` to check detection without submitting anything.

## Manual live smoke checklist

1. `/voice setup` → model provisioned, binaries found.
2. `/voice on` → footer shows `🎙 listening`.
3. Say "hey pi", speak a short request → transcript submits once; status
   shows `🎙 hearing: …` mid-utterance.
4. While Pi streams a reply with TTS on → footer shows `🔊 speaking`;
   say "hey pi" → speech stops (barge-in).
5. `/voice off` → `voice off`, mic process gone (`pgrep ffmpeg` empty).
6. Restart Pi with autostart on → listening resumes without downloading.
