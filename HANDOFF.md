# pi-voice — orchestrator handoff

Last updated 2026-10-04 by the orchestrating Pi session (pre-compaction). This file is for the
orchestrator, not end users. Facts marked (measured) were directly observed; (reported) came from
subagent reports and were not independently re-run.

## Owner preferences (durable)

- **Orchestrate only**: do not write code yourself; delegate to subagents (worker/reviewer/scout/researcher),
  fan out across disjoint file ownership, keep context lean (read summaries/targeted slices).
- **Commits allowed** in this repo for this task (past and future work). Commit after own verification.
- Launch **evidence-auditor style researchers** (researcher agents briefed to falsify claims against
  primary sources) for load-bearing claims. No dedicated `evidence-auditor` agent exists.
- Use measurement over research when they conflict (e.g. the 9-channel claim below).
- Never play audible sound without telling the owner. Never print/log keys.

## Goal

1. Replace ElevenLabs TTS with a high-quality fast streaming provider → **Inworld** (done).
2. Voice isolation: clean background noise + **only react to the owner's voice**, tuned to them,
   learning from use (done structurally; accuracy work in progress).
3. Evaluate native macOS STT (done: rejected, see below).

## Commits since owner's baseline (`2a74c26` = owner's own pending work checkpointed)

```
cd9b2db Inworld TTS default, voice-io Swift helper (Apple voice processing), speaker verification + diversity learning
8f4b247 research/stt-bench (Apple SpeechAnalyzer vs Scribe)
54a28c1 learning wired: learn after accepted+submitted; that-was-me, learn on/off, reset-learning
4b4e8be every submit/stage path goes through the speaker gate
d5debff research/speaker-bank capacity sweep
5544429 hardening: bank cap 16, no threshold raise, head+tail re-score, fail closed at 6 embeddings, serialized profile store, mic fallback fixes, SIGPIPE-safe helper
a365182 "unverified" reject message distinct from "not your voice"
dd54b46 channel-0 capture + persistent converter, AGC off default; no terminal reject before 2.5 s; 6-clip quality-gated enrollment
38a0c9f research/speaker-diag diagnostic tool
46de542 shared VAD speech-frame rule (feedVadSpeechFrame in src/vad.ts) for enrollment + live gate
e15431e durable orchestrator handoff notes
f874647 capture readiness independent of playback readiness
d6f1148 research probe + diagnostics E/F/D, helper failure + rate bounds
fde497f speaker capture path metadata, gate matching, and enrollment source stability
```
Last verified in this session (measured): typecheck exit 0; full tests 488/488; diff check clean. Also validated Swift compile and diagnostic self-test before the final commands-only cleanup change.

## Architecture map

- `src/inworld-tts.ts` WebSocket `wss://api.inworld.ai/tts/v1/voice:streamBidirectional`, `Authorization: Basic $INWORLD_API_KEY`,
  camelCase frames, PCM 24 kHz, default model `inworld-tts-2`, voice default `Ashley` (owner currently uses `Alistair`).
  `src/inworld-api.ts` voice list (`/voices/v1/voices`, 404 → legacy `/tts/v1/voices`). Protocol audited against docs (all confirmed).
- `src/tts.ts` ElevenLabs TTS (selectable via `/voice provider`). STT stays ElevenLabs Scribe (`src/stt.ts`).
- `native/voice-io.swift` + `src/voice-io.ts`: one AVAudioEngine process doing mic capture (16 kHz s16le stdout) and TTS
  playback (stdin frames) so Apple AEC cancels pi-voice's own playback. Flags: `--voice-processing`, `--agc` (default off),
  `--bypass`, `--probe-channels N`, `--input <name>`, `--list-devices`. Compiled by `/voice setup` into
  `~/Library/Application Support/pi-voice/bin/voice-io-<hash>`. Fallback to ffmpeg/ffplay (`src/mic.ts`, `src/player.ts`).
- `src/speaker.ts`: CAM++ (sherpa-onnx-node, model via `ensureSpeakerModel` in `src/model.ts`), profile `speaker.json` (0600)
  with anchors (enrollment, never evicted), diversity-aware learned bank (cap 16, cluster cap 25%, density weights,
  top-3 exemplar scoring), threshold never raised by learning (≤0.03 lower), gate: provisional decisions, terminal reject
  before 2.5 s only if score < thr−0.15, insufficient <1.5 s proceeds unlearned, head/tail re-score, fail closed at 6 embeddings.
- `src/controller.ts`: state machine; gate settles before every submit/stage path; learning only after real submission.
- `src/commands.ts`: `/voice …` incl. `enroll`, `speaker off|low|normal|high|forget|learn on|off|that-was-me|reset-learning`,
  `test speaker`, `isolation on|off`, `provider`; `createSpeakerStore` serializes profile disk ops (forget cannot be undone).

## Key evidence (keep — drives decisions)

- STT bench (measured by subagent, synthetic `say` voices, research/stt-bench/results.md): Scribe v2 WER 7–8%, tech-term 82–85%;
  Apple SpeechTranscriber 26–42%, DictationTranscriber 33–58%. contextualStrings only honored by DictationTranscriber. → keep Scribe.
- Bank sweep (research/speaker-bank/results.md, synthetic): coverage saturates at 16; FAR rises with capacity (22%→35%→44% at 0/16/256);
  threshold creep observed → fixed.
- Channel probe on owner's Mac (reported): with VP on all 9 tap channels are **bit-identical** → averaging was NOT the cause
  (three researchers claimed it was; measurement wins). Sample accounting fine (99.8% over 10 s).
- **Owner real-voice diagnostic (measured by owner, speech-only within-path cosine, 4×~5 s phrases):**
  A helper VP on = 0.66 (min 0.49); C helper bypass = 0.79 (min 0.71); **D ffmpeg raw = 0.89 (min 0.79)**.
  First-1.2 s windows 0.68–0.73 on all paths. → Apple voice processing degrades speaker embeddings; short windows are bad.
  "SAMPLE-RATE MISMATCH" warnings in that run were a tool artifact (wall clock included startup; ffmpeg also ~86%).
- Owner enrollment through path A after dd54b46: pairwise mean 0.76 min 0.54.

## Current state after latest commits

- Live gate still uses the session source; **no concurrent ffmpeg speaker capture or source switch** was implemented. Owner's ambient-only probe found that concurrent ffmpeg bytes arrive at the nominal rate, but Apple's VP system-wide attenuates them 15–26 dB and gates them (zero fraction 0.6%→11–20%). Speech effect is unverified.
- Diagnostic `node research/speaker-diag/diag.mjs` defaults to E/F/D: E ffmpeg while VP helper runs, F ffmpeg while a restarted helper runs with bypass, D ffmpeg alone. F prints helper restart latency (there is no runtime bypass command). It reports speech-only cosine plus 2.5/4 s windows and checks helper health after capture. Rate sanity flags <95% or >105%. `--self-test` passes; real mic run is still needed.
- Capture/playback startup decoupled: helper capture READY no longer depends on player readiness; playback errors fail only the sink operation. Swift compile and real-binary silence-drain tests passed. Actual owner-machine first-start race still needs confirmation.
- `/voice test speaker` asks for a ~4 s phrase (capture's minimum is 2.5 s speech), reports speech ms, score, threshold, decision. Bare `/voice speaker` reports status. Profile stores `capture: raw|processed`; enrollment snapshots path and rejects isolation toggles mid-enrollment. Status and live gate compare against the current selected helper/fallback source. Legacy profiles with unset capture stay silent.
- New commits above are complete. Latest measured checks: `npm run typecheck` and full tests 488/488; `git diff --check` clean. Swift compile and diagnostic self-test pass; two existing-style `Optional<CFString>` Swift warnings remain.

## Owner diag rerun 2026-10-04 ~22:15 local (INVALID)

- Every D/E/F clip was -71..-77 dBFS RMS (earlier D run: about -33); VAD found 0 ms of speech in 3 of 4 F clips. Parent measured
  afterwards with no helper running: ambient ffmpeg = -57.1 dBFS, zero 0.77% (normal); input volume 71; default input is the built-in mic.
  Speech at 15 dB below the quiet-room floor matches the 'ffmpeg + VP helper elsewhere' signature, so another Pi session's helper was
  likely live (not provable: no debug log). Pi processes: 80968 (about 5 h old, runs OLD pi-voice code, holds the mic via ffmpeg pid 81229,
  possibly this orchestrator session) and 71959 (new). Do not kill them.
- `/voice test speaker` x5 in the new session (processed path, profile enrolled on processed path, legacy `capture` unset): 0.71, 0.51,
  0.65, 0.72, 0.48 against threshold 0.64 => 3 accepts, 2 rejects. This confirms the processed path is inconsistent (path A within-cosine 0.66).
- ffmpeg rate shows 89% on every clip, even after the first-byte fix; the probe measured 25-28.6 kB/s over 10 s against 32 kB/s nominal.
  Possible real sample loss in the raw path.
- Done (committed): the diag now refuses to run while a foreign `voice-io-<hash>` helper is running (`--force` overrides).
  Clips below -50 dBFS RMS or with VAD under 1.5 s are INVALID and excluded; no verdict for a path with under 3 valid clips.
- ffmpeg rate probe (research/speaker-diag/rate/results.md, measured by subagent, 9 runs, concurrent with the owner's pid 81229):
  steady-state 85.8-88.2% of 32 kB/s with no stderr warnings, no tail loss and max gap 28-51 ms. `-thread_queue_size 4096` and removing
  nobuffer/probesize do not change it. This is real under-delivery, NOT an accounting artifact. Dropped audio vs a slow clock is unresolved;
  a simultaneous helper (VP off) vs ffmpeg alignment-drift test would discriminate. It affects the production raw path
  (isolation off / fallback). Note: path C (the helper's own bypassed stream, 100% delivery) scored 0.79 vs D 0.89.

## Research wave 2026-10-05 (owner concluded embedding matching is not robust enough)

Workflow `d1d262b8-430b-483d-a8eb-f1617f40efd5`, 5 researcher reports in subagent-artifacts
(61fb3b80 sv-sota, 310abaa6 production, cfbe5c22 device-directed, 24bb8778 tse-pvad, c23b59bf macos-hw).
- Consensus: shipping assistants do not hard-gate on a text-independent embedding threshold. Apple: text-dependent check on the wake
  phrase, then later passes plus directed-speech detection. Google/Alexa: speaker ID gates personal data, not wake-up.
- Parent spot-checks: FFmpeg Trac #11398 is real (open: avfoundation audio randomly missing samples; matches our ~12% shortfall).
  The openWakeWord custom-verifier doc exists (its >95% claim is unverified). Picovoice Eagle does support Node and macOS arm64 but needs an
  AccessKey account (free-tier limits unverified). Researcher claim that MediaRemote now-playing works is WRONG: blocked for third-party
  apps since macOS 15.4 (works only via the perl-adapter workaround).
- Researchers assumed we gate at 1.2 s. We do not: the owner's 5 `/voice test speaker` runs had 5.4-5.7 s of speech and still spread 0.48-0.72
  (processed path). Whole-utterance scoring alone did not fix it. The raw path's accept/reject rates have never been measured.
- **Owner DECIDED (2026-10-05): option 1.** No voice check: speaker verification off (default off; keep the code as an opt-in).
  "hey pi"/"hi pi" just work. Add a **push-to-talk key** and **ignore other audio playing on the Mac**.
  Do NOT add the keyboard-recency gate. The near-field level gate was not requested; don't build it.
- Pi has `pi.registerShortcut()` (focused terminal only; key presses, no releases). Global hold-to-talk needs a native
  key listener.
- Workflow `f3e2a67a-1991-47b0-a8ca-cd89a6333308` (read-only): scout-integration (controller seams for PTT start/commit, helper
  lifecycle/protocol/run loop, speakerCheck default, ducking config), hotkey research (Carbon RegisterEventHotKey press/release vs
  CGEventTap/Input Monitoring, Pi registerShortcut), other-audio research (does macOS VP cancel other apps' output? ducking defaults;
  Core Audio process taps + permission; permission-free process-output signals; reference-based wake suppression/AEC). Next: write a plan,
  confirm product choices (hold vs toggle, key, global vs focused, contaminated-utterance behaviour), then delegate by file ownership.
  Any hardware test that plays audible sound needs the owner's OK first.
- Research findings (reports 1fd2c9ad scout, 66c7563b hotkey, d856481a other-audio):
  - PTT: Carbon `RegisterEventHotKey` gives press+release globally with NO TCC permission; needs main thread + NSApplication loop.
    Default ⌃⌥Space. Modifier-only keys (Fn/Right Option) need CGEventTap + Input Monitoring for the terminal app. Superwhisper and
    MacWhisper use Carbon.
  - Apple VP AEC cancels ONLY its own output bus, not other apps. No external-reference input exists. Other-app rejection needs a reference
    stream: process tap (kTCCServiceAudioCapture; reportedly all-zero buffers from a bare terminal-spawned CLI; reportedly conflicts with VPIO
    in the same process) or ScreenCaptureKit audio (Screen & System Audio Recording permission, ~50-150 ms latency, monthly reminders).
    Plan: run a second KWS on the reference and drop mic wakes that coincide. Full dictation cleanup would need WebRTC AEC3 (high effort).
  - BUG (parent-verified): native/voice-io.swift ~291-293 mutates a copy of voiceProcessingOtherAudioDuckingConfiguration and never
    assigns it back, so DEFAULT ducking turned the owner's media down whenever the helper ran. There is no "off" level; min is the lowest.
- Owner has NOT yet confirmed my stated assumptions: hold-to-talk; global ⌃⌥Space; ignore wake words the Mac itself plays; when other
  audio plays during dictation, cancel it or stage the transcript in the editor instead of auto-send.
- Workflow `afdac225-21ff-4784-9ac3-a4ff12965ced`: stage 1 parallel ducking-fix (voice-io.swift), hotkey-helper (native/hotkey.swift,
  src/hotkey.ts, test/hotkey.test.ts), other-audio-probe (research/other-audio/, compile only, NOT run). Stage 2 ptt-wiring
  (controller/contracts/prefs/commands/index/README/tests; speakerCheck default off). Stage 3 review. Then: verify, fix, commit. Then ask
  the owner to run the other-audio probes while THEY play a video (permission prompts appear), then build reference-KWS coincidence rejection.

## Next steps (superseded by the decision above)

1. Owner: restart Pi, run `/voice setup` to rebuild the helper. Before the diag, run `/voice off` in EVERY Pi session.
2. Run `node research/speaker-diag/diag.mjs` in Terminal (defaults E,F,D) with the same phrases per path; paste `COPY-PASTE SUMMARY`. Audio remains in memory only. This determines whether bypass during capture (F) approaches plain ffmpeg (D); do not change production speaker capture before this evidence.
3. Re-enroll (`/voice enroll`) after selecting the capture strategy; then test `/voice test speaker` 4–5 times and ideally have another speaker try.
4. Thresholds still require calibration on real human data. Previous owner profile: threshold 0.643; old enrollment pairwise mean 0.76, min 0.54, made through processed path.
5. Remaining hardware gaps: first-start capture readiness; interactive E/F/D; named-mic selection; route-change converter behavior; live AEC quality.


## Pitfalls seen with subagents

- Unscoped `grep` timed out at 300 s (home dir / research audio). Always tell children to scope grep to `src/`, `test/`, `native/`.
- A hung test file blocked everyone's `npm test` — tell children to use `--test-timeout` and report others' failures, not fix them.
- Children sharing files: always assign disjoint ownership; concurrent writers make the suite transiently red.
- Fake components in tests hid real bugs (gate froze after first verdict) — require real-component repro tests.
- One child wrote tests via shell heredoc after an edit failure; forbid it explicitly.
- `subagent` steer takes `{action:"steer", id, message}` only (no `mode` field).

## Untracked leftovers (owner may delete)

research/stt-bench/{wav,tmp,apple-stt,run-apple.out}, research/speaker-bank/tmp/{embeddings,manifest}.json. These are generated/local artifacts and remain untracked.
