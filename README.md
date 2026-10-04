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
  Inworld by default (ElevenLabs selectable via `/voice provider elevenlabs`)
  and plays locally. Code, URLs, and link destinations are never
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
- After the wake word, microphone audio goes to ElevenLabs (Scribe STT).
  With TTS on, the assistant's prose goes to Inworld (TTS, the default
  provider) or ElevenLabs (TTS, when selected via `/voice provider
  elevenlabs`). Both are billable third-party usage.
- API keys come only from the environment: `ELEVENLABS_API_KEY` (STT and
  ElevenLabs TTS) and `INWORLD_API_KEY` (Inworld TTS). They are never
  stored, logged, or shown (status shows the last 4 characters only).
- Preferences (TTS provider, voice, wake phrase, sensitivity, mic,
  autostart, TTS, TTS model, send mode) live in
  `~/Library/Application Support/pi-voice/state.json`.
  No transcripts, audio, or keys are persisted there.

## Install

```sh
pi install ~/pi-voice
# add to ~/.zshrc, then restart the shell / Pi:
export ELEVENLABS_API_KEY="..."  # speech-to-text (Scribe) + wake gating
```

For spoken replies (TTS, on by default via Inworld), also export:

```sh
export INWORLD_API_KEY="..."  # text-to-speech (Inworld, default provider)
```

Then inside Pi:

```
/voice setup   # checks ffmpeg/ffplay, provisions the wake model, mic help
/voice on      # enable the mic for this session
/voice tts on  # speaks with the default Inworld voice (Ashley); pick another via /voice list
```

Prefer ElevenLabs for speech too? `export ELEVENLABS_API_KEY`, then
`/voice provider elevenlabs` and `/voice <voice-id>` to pick a voice.

## Command reference

| Input | Behavior |
|---|---|
| `/voice`, `/voice status` | Mic state, wake mode, device, TTS state, provider, voice, model, both key suffixes |
| `/voice on`, `/voice off` | Start/stop wake listening for this session |
| `/voice setup` | Check binaries/env, provision the wake-word and VAD models, mic-permission guidance. Does not enable the mic |
| `/voice provider [inworld\|elevenlabs]` | Show or select the TTS provider (default `inworld`; STT stays ElevenLabs). Bare `/voice provider` shows the current provider |
| `/voice tts on\|off` | Session speech toggle (saved); `on` needs the active provider's key (ElevenLabs also needs a selected voice) |
| `/voice list` | List active-provider voices (needs that provider's key) |
| `/voice <voice-id>` | Select the active-provider voice by id (saved, no key needed; Inworld ids are names like `Ashley`) |
| `/voice id <id>` | Select the active-provider voice by id (explicit form) |
| `/voice model [id]` | List or select the active-provider TTS model (Inworld: `inworld-tts-2` default, `inworld-tts-2-flash`; ElevenLabs: default `eleven_flash_v2_5`, `eleven_v4_*` models are rejected by the streaming endpoint) |
| `/voice wake hey-pi\|hi-pi\|both` | Which phrases the local spotter listens for |
| `/voice sensitivity low\|normal\|high` | Detection strictness (default `normal`) |
| `/voice mic list\|default\|<name>` | Pick by AVFoundation device name; quote names with spaces (`"iPhone Microphone"`). A missing saved mic falls back to default with a notice |
| `/voice autostart on\|off` | Auto-listen at session start when the model is cached and the key is present (default on; never downloads at startup) |
| `/voice isolation on\|off` | Echo-cancelling helper capture + playback (default on when built). Bare shows state and whether the helper is built |
| `/voice enroll` | Guided owner-voice enrollment (cancel with `/voice off`; audio never written to disk) |
| `/voice speaker off\|low\|normal\|high\|forget\|learn on\|off\|that-was-me\|reset-learning` | Owner-voice check strictness (default `normal`), delete the voice profile, toggle continuous learning, learn the last rejection as your voice, or clear learned samples |
| `/voice send auto\|review` | `auto` submits transcripts immediately; `review` stages them in the Pi editor. Bare `/voice send` shows the current mode |
| `/voice test mic\|wake\|stt\|tts\|speaker` | `mic`: 2 s capture with input level; `wake`: ~10 s offline listen (nothing submitted); `stt`: 8 s live capture reporting commit→transcript latency; `tts`: billable spoken test phrase; `speaker`: one utterance scored vs threshold, nothing submitted |
| `/voice help` | This summary in-session |

## Voice isolation

Two opt-out layers keep room noise and other voices out of your prompts.
Both default on and degrade gracefully when their build artifacts are missing.

**Noise suppression + echo cancellation (isolation).** When `/voice
isolation` is on (default) and the helper is built, capture and TTS playback
both run through one native helper process (`native/voice-io.swift`, compiled
to `~/Library/Application Support/pi-voice/bin/`) using Apple's voice
processing: echo cancellation of pi-voice's own playback and noise
suppression. Automatic gain control is available via the helper's `--agc`
flag but stays off by default because level swings hurt speaker embeddings. This replaces the ffmpeg mic and ffplay sink for
the session. Notes:

- Echo cancellation covers **only pi-voice's own playback** (TTS spoken
  through the helper). Audio from other apps is not cancelled — a headset is
  still the most reliable setup.
- While the helper runs, macOS exposes its **Control Center → Microphone →
  Voice Isolation** mic mode for the helper's input. That toggle is
  user-selected and cannot be forced on programmatically; it is separate from
  `/voice isolation`.
- If the helper fails (missing device, engine error, crash, or a mid-session
  failure after capture started), the session switches to ffmpeg capture and
  ffplay playback with the one-time warning `Voice isolation helper failed;
  using ffmpeg capture and ffplay playback for this session.` In-flight
  speech fails cleanly and capture restarts transparently.
  Microphone-permission denial keeps the existing System Settings guidance.
- The helper is **never compiled at session start** (like the models, no work
  at startup). `/voice setup` builds it and reports the result.
- Building requires the **Xcode command line tools** (`xcrun swiftc`):
  `xcode-select --install`.

**Owner-voice check (speaker).** `/voice enroll` records
a guided enrollment (6 longer sentences shown one at a time, each needing
at least 2.5 s of speech — aim for 3+ s per clip, ~15–20 s total; too-short
takes are repeated) and stores a
numeric voice profile. Each clip is embedded as you read it: once 3 clips
exist, a clip whose mean cosine similarity to the others is below 0.60
(provisional) is flagged and you are asked to re-record it (up to 2 retries
per phrase). At the end the pairwise clip-similarity matrix is summarized
(mean/min). Later utterances are scored against the profile: strangers hear
an error cue and a brief `🎙 not your voice`, and nothing is submitted (in
review mode, nothing lands in the editor either).

- Strictness: `/voice speaker off|low|normal|high` (default `normal`).
  Each level offsets the enrolled threshold by low −0.05 / normal +0 /
  high +0.05.
- Thresholds are **provisional**: calibrate with `/voice test speaker`, which
  asks you to read a ~4 s sentence aloud (same >= 2.5 s speech floor as
  enrollment and the gate) and reports speech ms, score vs threshold, and the
  decision without submitting anything. A short take reports how much speech
  was captured so you can retry with a longer phrase. Raise the level if
  lookalike voices pass; lower it if you get rejected.
- The profile records which capture path it was enrolled on (`capture`,
  currently `processed` — the voice-processed session pipeline used by
  enrollment and the gate). When the selected source differs (isolation off
  or helper fallback captures `raw`), status and the gate warn once to
  re-enroll for best accuracy. Whether verification should
  move to unprocessed audio is still open: see `research/speaker-diag/`
  (concurrent-capture probe + paths E/F/D, not yet confirmed with owner
  speech), so no capture change is claimed here.
- The check runs only when a profile is enrolled **and** the speaker model is
  cached; otherwise it is silently off (status says so).
- **Privacy:** the profile is a numeric embedding (no audio) stored with mode
  `0600` in `~/Library/Application Support/pi-voice/speaker.json`;
enrollment audio lives only in memory and is never written to disk. Delete
  with `/voice speaker forget`.
- **Continuous learning (default on, `/voice speaker learn off` to pause).**
  After an utterance the gate accepted is actually submitted (auto mode, or
  review-mode text actually sent — never on cancel, barge-in, STT failure,
  empty transcripts, or unsent drafts), confident matches refine the profile:
  only samples clearing the threshold by a margin with enough speech are
  learned. Enrollment anchors stay fixed and are never evicted, so impostors
  cannot drag the profile away; learned samples live in a diversity-aware
  bank (up to 16, one speaking condition capped at a quarter of the bank).
  Capacity is capped at 16 because the calibration in
  `research/speaker-bank/results.md` found coverage saturates by 16 while
  impostor acceptance rises monotonically with capacity (22.2% at 0, 34.6%
  at 16, 44.4% at 256 for the most overlapping synthetic voice pair).
  Learning also never raises the gate: the threshold may ease down at most
  0.03 below its enrollment value but can never exceed it (the same study
  showed unbounded learning creeping 0.61 to 0.846 and locking out the
  owner's own conditions).
  Saves are debounced (at most once per 30 s, flushed on voice off /
  shutdown) and never delay submission. Status shows the bank fill, e.g.
  `speaker: normal, enrolled 2026-10-04, learned 12/16`.
- **False reject?** `/voice speaker that-was-me` learns the last rejected
  utterance as your voice (kept in memory only, for 2 minutes). Samples too
  different from enrollment are refused. `/voice speaker reset-learning`
  drops all learned samples back to the enrollment anchors.
- Learning knobs (accept margin, bank size, condition cap, threshold step)
  are **provisional** constants in `src/speaker.ts` (`LEARN`): expect them to
  change once false-accept/false-reject rates are measured on real voice.

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
- **Re-enroll after this update.** Enrollment now needs 6 clips of 2.5+ s
  speech each with outlier re-recording; profiles enrolled under the old
  short-phrase flow (5 × ~1.5 s) under-represent your voice and should be
  replaced via `/voice enroll`.
- **What the pairwise numbers mean.** After enrollment you see a per-clip mean
  similarity plus a final `Pairwise clip similarity: mean X, min Y`.
  Consistent enrollments sit well above 0.60 per clip. If the final mean is
  below 0.65, the audio path may be degraded (room noise, mic gain, wrong
  device) — re-enroll somewhere quieter, preferably with a headset, or run
  `research/speaker-diag/diag.mjs` to diagnose.
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
7. `/voice setup` → builds the voice-isolation helper (needs Xcode command line tools) and provisions the speaker model, reporting each result.
8. `/voice enroll` → reads back 6 sentences, flags outliers for re-recording, then reports scores, the pairwise summary, and the threshold; `/voice test speaker` → score vs threshold, nothing submitted.
