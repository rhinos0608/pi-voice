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
```
Last verified at 46de542 (measured): `npm run typecheck` exit 0, `node --test --test-timeout=60000 test/*.test.ts` 472/472.

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

## In flight at handoff

Workflow `78b1c611-bb3e-4816-9e9c-767987184d1d` (async; completion wakes the session):
1. `probe-concurrent` — can raw ffmpeg capture run concurrently with the helper's VP without being altered? (research/speaker-diag/concurrent/)
2. `fix-helper-start` — capture must not fail when playback isn't ready (owner hit "Playback unavailable: player has no output connection").
3. `diag-path-e` — diag path E = ffmpeg raw while helper VP runs; fix rate warning; scores at 2.5 s/4 s.
4. then `raw-speaker-path` — speaker gate + enrollment + `/voice test speaker` on a dedicated raw ffmpeg capture with own VAD,
   only while needed; fix `/voice test speaker` always "no usable speech captured" (root cause to be stated); bare `/voice speaker`
   shows status; profile records capture path. Writer must STOP if probe says infeasible.
5. then `review`.
Check with `subagent({action:"status", id:"78b1c611-bb3e-4816-9e9c-767987184d1d"})` if no wake arrives. Do not poll.

**Update after `probe-concurrent` finished (reported, research/speaker-diag/concurrent/results.md):** concurrent ffmpeg
capture works (no errors, byte rate intact, helper rate unaffected) but while the helper runs VP the raw ffmpeg feed is
**attenuated 15–26 dB and gated** (zero fraction 0.6% → 11–20%) — Apple VP affects the shared device feed system-wide.
So the planned "dedicated raw ffmpeg capture alongside the helper" is NOT clean. `diag-path-e` was steered to add
**path F** = helper VP on, toggled to bypass only during each recording; diag default paths E,F,D.
**Action when `raw-speaker-path` (stage 2) starts or reports:** it must NOT ship the concurrent-ffmpeg design. Keep only
items 2–4 (fix `/voice test speaker` with stated root cause, bare `/voice speaker` status, profile capture-path field) and
make the speaker capture source a small strategy seam; choose the strategy only after the owner runs diag E/F/D.
Likely winner if F ≈ D: bypass VP during the capture phase (AEC is not needed then — wake already cancelled TTS),
keeping one continuous stream for STT/VAD/gate. If stage 2 already implemented the concurrent design, revert that part
via a follow-up worker (do not hand-edit).

## Next steps

1. Read workflow results; verify yourself (typecheck, full tests, `xcrun swiftc -O native/voice-io.swift -o /tmp/vio`), review findings → fix rounds → commit.
2. Ask owner to: restart Pi, `/voice setup`, run `node research/speaker-diag/diag.mjs` (default paths E,D) and paste the summary,
   re-enroll (`/voice enroll`), `/voice test speaker` ×4–5, ideally have another person try. Set `PI_VOICE_DEBUG=1`.
3. Recalibrate thresholds on real data (current: suggested = min LOO − 0.05 clamped [0.5,0.85]; owner profile thr 0.643).
4. If raw capture is infeasible concurrently: alternatives = briefly switch helper to bypass during capture phase (AEC not needed
   after barge-in cancels TTS) — measure C-path again; or isolation off for speaker path.
5. Open/unverified: echo cancellation quality not measured live; named-mic selection untested; route-change restarts untested on hardware.

## Pitfalls seen with subagents

- Unscoped `grep` timed out at 300 s (home dir / research audio). Always tell children to scope grep to `src/`, `test/`, `native/`.
- A hung test file blocked everyone's `npm test` — tell children to use `--test-timeout` and report others' failures, not fix them.
- Children sharing files: always assign disjoint ownership; concurrent writers make the suite transiently red.
- Fake components in tests hid real bugs (gate froze after first verdict) — require real-component repro tests.
- One child wrote tests via shell heredoc after an edit failure; forbid it explicitly.
- `subagent` steer takes `{action:"steer", id, message}` only (no `mode` field).

## Untracked leftovers (owner may delete)

research/stt-bench/{wav,tmp,apple-stt,run-apple.out}, research/speaker-bank/tmp/{embeddings,manifest}.json.
`research/speaker-diag/diag.mjs` currently modified by in-flight `diag-path-e`; `research/speaker-diag/concurrent/` from the probe.
