# pi-voice design (oracle)

## Inherited decisions

- Wake detection stays local/offline; only post-wake microphone audio goes to ElevenLabs Scribe. Final transcript becomes Pi user prompt.
- TTS optional; assistant text streams to ElevenLabs and playback streams locally.
- Latest user decision: **API key only from `ELEVENLABS_API_KEY`**. No Keychain, key-setting command, or user-edited `config.json`.
- Package installs with `pi install ~/pi-voice`; workers own disjoint files. No files edited during this design review.

## Diagnosis / drift check

Installed Pi declarations supersede research brief: `sendUserMessage()` returns `void`, accepts `deliverAs` but **not** `source`; `registerCommand()` supports `getArgumentCompletions` but not an `args` declaration; `session_shutdown` covers reload and session replacement. See [types.d.ts](file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L1128-L1227). ElevenLabs audit also corrects STT error names, duplicate timestamp events, and TTS final-message handling. Do not implement contrary brief snippets.

## Recommendation: implementation contract

### Runtime and state

```
off ── /voice on ──► preparing ──► wake
                                  │ wake detected
                                  ▼
                               capture ── committed transcript ──► submit ──► wake
                                                                       │ text_delta, TTS on
                                                                       ▼
                                                                    speaking ──► wake
```

- **Off by default on every Pi launch.** `/voice on` explicitly enables microphone for current session; `/voice tts on` explicitly enables outgoing assistant text and playback for current session. Neither opt-in persists. Failure or `/voice off` returns to off, closes sockets, stops child processes, clears timers/status.
- One FFmpeg AVFoundation child supplies mono 16-bit/16-kHz PCM frames. Frame assembler handles arbitrary stdout boundaries; same frame feeds KWS in `wake`/`speaking`, STT exclusively in `capture`. No second microphone process. Both KWS streams reset after any detection (shared ~1.5 s refractory).
- On wake, stop feeding KWS, open STT socket with `xi-api-key` header, then forward **subsequent** frames in ~8-KiB chunks. Buffer at most two seconds while connecting; never send wake audio or feed inactive STT. Use `scribe_v2_realtime`, `pcm_16000`, `commit_strategy=manual`, timestamps off. Partial transcript updates status only. Append each `committed_transcript` once; ignore additional timestamp transcript events. End-of-speech comes from the local Silero endpointer (~0.8 s of silence), which drives an explicit manual commit; the committed text then resolves to the final transcript, typically ~0.3 s later. A 3 s grace timer after commit falls back to the last partial transcript, then to blank. Guard rails: 5-second no-speech timeout, 30-second capture cap.
- While Pi busy, send final text with `pi.sendUserMessage(text, {deliverAs:"followUp"})`; never steer or abort model work implicitly. While idle, call `sendUserMessage(text)` without delivery option. Reject oversized transcripts and show bounded, non-secret status; do not persist raw audio.
- **Intent parsing** (`src/intent.ts`): each final transcript is classified as `empty`, `send`, or `dictate`. A leading "hey/hi pi" is stripped; a trailing "…send to pi" marks `thenSend`. Exact "send" / "send it" / "submit" / "send to pi" (after wake-strip, so "hey pi, send" qualifies) means `send`.
- **Review mode** (`sendMode: "review"`, default `auto`): `dictate` text appends to the Pi editor instead of submitting; `thenSend` submits editor contents plus the dictation; `send` submits the editor draft (or reports "nothing to send"). Submitted drafts clear the editor. The wake spotter runs with an extra "send-to-pi" keyword group in review mode, so a standalone "send to pi" submits the draft without an STT round-trip — but as a keyword-spotter command it is missed fairly often after long silence (measured on synthetic speech: ~19/36 silence lengths for "send to pi", ~31/36 for "hey pi"), while "hey pi, send" goes through STT.
- **Failure handling:** blank finals show `🎙 didn't catch that`; the 5 s no-speech timeout shows `🎙 didn't hear anything`; both play an error cue and return to wake. Auth/quota/terms/mic/key failures stop voice with an error. Retryable network/rate failures warn (deduped per minute) with an error cue and return to wake.
- **Keyword-spotter streams:** one mic source feeds two consumers on separate paths — the KWS detector in `wake`/`speaking`, the STT utterance plus Silero endpointer in `capture` — never both at once. Inside the detector, two spotter streams get identical audio: a live stream plus a staggered stream held 0.75 s of audio content behind (sample-counted, never wall-clock). Detection on either stream fires once (shared ~1.5 s refractory) and resets both streams. Rationale: the spotter's trailing-blank reset is hardcoded (~1.5 s; upstream sherpa-onnx issue #3990) and drops keywords that straddle it. The stagger only holds from a reset point (detector creation, any detection, start of capture): a second keyword within ~6 s of one improved from 43/69 to 60/69 on the gap sweep. During long silence both streams auto-reset at the same audio point and re-synchronise, so detection after long silence is unchanged. The "send-to-pi" group (review mode only) joins the same keywords file; no second mic process exists.
- Speaking keeps **local KWS active**, but never STT. Wake during playback terminates TTS/player, starts new capture, then queues prompt as follow-up if Pi remains busy. False wake from speaker echo remains possible without acoustic echo cancellation: require headset for reliable barge-in; add brief post-playback cooldown and reset KWS stream, not a claim of echo cancellation.
- STT auth/quota/terms errors: stop capture, notify actionable cause, do not retry until user acts. Transient network/rate failures: return to local wake detection; bounded reconnect delay, never replay partial utterance or submit partial transcript. Mic permission failure: off with macOS Terminal microphone-permission guidance. Use generation IDs on every async callback so a late event from canceled socket cannot submit/speak.
- Start long-lived resources only inside `session_start` or `/voice on`; register handlers in factory. `session_shutdown` synchronously marks controller closed, then idempotently closes sockets, stdin, children, timers, listeners, and status; await close briefly, escalate owned child termination if needed. Applies to `/reload`, quit, and session switch. Abrupt process kill cannot guarantee cleanup; FFmpeg stdout/ffplay stdin pipe closure should ordinarily terminate children, subject to smoke test. Non-TUI modes never auto-start audio.

### TTS contract

- Subscribe to `message_update`; accept only `assistantMessageEvent.type === "text_delta"` belonging to an assistant message. Ignore thinking/tool-call deltas and tool-result messages. `message_end` finishes that assistant message; `agent_end` handles incomplete stream fallback; `input` cancels playback for a new interactive/RPC user turn; abort/error `stopReason` cancels rather than flushes. Avoid speaking extension-generated control/status text.
- Incremental Markdown normalizer tracks fenced-code state across delta boundaries. **Never speak fenced or inline code**, raw URLs, or link destinations; speak visible link labels and ordinary prose. Bound pending text; release at sentence punctuation plus whitespace, preferably 120–300 characters, force chunk by ~400 characters. Send each chunk with trailing space; on successful message end flush remaining prose, send `{"text":""}`, drain final audio. No full-message wait.
- One `/stream-input` WebSocket **per assistant message**, `eleven_flash_v2_5`, selected voice ID, `pcm_24000`, header auth, initial `{"text":" "}`. Single-context socket keeps cancellation and ownership simple; no persistent idle socket. Handle separate final event with null audio; accept documented final-field spelling variants only after parsing/validation. Stream base64-decoded PCM to FFplay `-f s16le -sample_rate 24000 -ch_layout mono -i pipe:0`; honor stdin backpressure with bounded queue. Cancel socket/player immediately on new user input, barge-in, `/voice tts off`, `/voice off`, abort, or shutdown. Never send key in URL, first JSON message, logs, or errors.

### Slash surface

One registered `/voice` command; parser and context-aware `getArgumentCompletions` own subcommands:

| Input | Behavior / completion |
|---|---|
| `/voice` or `/voice status` | Show mic state, wake mode, device, TTS state, voice, and `key: present ••••1234` or `key: missing`; never full key. |
| `/voice on`, `/voice off` | Start/stop current-session wake listening; autocomplete `on`, `off`. |
| `/voice setup` | Check binaries/env, provision verified KWS and VAD models, report permission instructions; **does not enable mic**. |
| `/voice tts on\|off` | Session-only TTS toggle; `on` requires key and selected voice. |
| `/voice list` | Fetch `/v2/voices` with `page_size=100`, follow `next_page_token` with page cap; autocomplete entries show name and ID suffix, insert **ID** to avoid duplicate-name ambiguity. Lists bounded selection/help. |
| `/voice <voice-id>` or `/voice id <id>` | Save the voice ID directly (no key needed to save); partial IDs complete from the voice list when the key is present. |
| `/voice wake hey-pi\|hi-pi\|both` | Select only bundled, verified BPE tokenized phrases; default `both`. No arbitrary phrase promise. |
| `/voice send auto\|review` | Stage (`review`) or immediately submit (`auto`, default) transcripts; `review` adds the "send-to-pi" spotter group for the session. |
| `/voice sensitivity low\|normal\|high` | Predefined KWS thresholds, default `normal`; tune with recordings, not invented documented defaults. |
| `/voice mic list\|default\|<device>` | Parse FFmpeg device listing; autocomplete discovered device IDs with names. Persist name and fail clearly if later missing/ambiguous rather than silently selecting another mic. |
| `/voice test mic\|wake\|stt\|tts` | `mic`: short local capture with level readout; `wake`: bounded offline detection without submission; `stt`: live 8 s capture reporting commit→final latency; `tts`: explicit billable fixed test phrase, requires key/voice. |

All key-dependent actions fail: “Export `ELEVENLABS_API_KEY` and restart Pi.” Read env at session start; do not accept keys as arguments. Autocomplete should not call API for unrelated subcommands; voice-list retrieval needs timeout/page cap and a short in-memory result reuse to avoid repeated paid-service requests per keystroke. Help includes privacy/cost boundaries.

### Persistence, assets, dependencies

- Persist **preferences only**—schema version, selected voice ID, wake choice, sensitivity, mic preference—in extension-owned `~/Library/Application Support/pi-voice/state.json`, mode `0600`, atomic replace. No raw transcript/audio/key; no `pi.appendEntry` because settings must follow user across sessions, not session branches. Unknown/corrupt schema fails closed to defaults with warning. Concurrent Pi instances can last-write-win preferences; each mic/TTS enabled state remains instance-local.
- First `/voice setup` or `/voice on`: fetch fixed upstream GigaSpeech English KWS archive into bounded temp file; verify **hard-coded SHA-256 pinned by asset owner before implementation lands**, then validate tar member allowlist and symlink/path safety, extract selected int8 ONNX/tokens/BPE files using system `tar` into staging, atomically rename into cache. Never execute downloaded content; never accept runtime-computed hash as trusted expected hash. Upstream GitHub release API currently exposes `digest:null`, so pinned digest creation and independent comparison are prerequisite. Bundle `hey pi`/`hi pi` keyword BPE sequences **generated against archive’s actual `bpe.model`**, not research brief’s guessed `▁P I`. Runtime Python must not be required.
- Manifest: `"pi":{"extensions":["./src/index.ts"]}`, `"type":"module"`, Node `>=25`; runtime `sherpa-onnx-node: "1.13.8"` and `ws: "8.21.3"`; peer `@earendil-works/pi-coding-agent:"*"`, not bundled. Dev `typescript:"5.9.3"`, `@types/node:"25.5.0"`, `@types/ws:"8.18.1"`; lockfile owned by foundation lane. `ws` avoids untested Node-global custom-header behavior. `.ts` relative imports, erasable TypeScript for Node 25 test runner, Pi jiti loading. External binaries use specified absolute paths after preflight; Sherpa dylib search path **must be smoke-tested**, not assumed from conflicting docs.

### File contracts and disjoint worker ownership

Shared contracts, finalized before parallel lanes modify code:

```ts
// src/contracts.ts — foundation lane
export type VoicePreferences = {
  version: 1;
  voiceId?: string;
  wake: "hey-pi" | "hi-pi" | "both";
  sensitivity: "low" | "normal" | "high";
  mic: { kind: "default" } | { kind: "named"; name: string };
};
export type VoicePhase = "off" | "preparing" | "wake" | "capture" | "submit" | "speaking";
export type VoiceFailure = {
  code: "key_missing" | "model" | "mic" | "auth" | "quota" |
        "rate" | "network" | "audio" | "protocol";
  message: string; retryable: boolean;
};
export interface Disposable { close(): Promise<void>; }
export type PcmFrame = Buffer; // signed LE mono 16 kHz, even byte length
```

| Lane | Exclusive files; public interfaces | Acceptance / runnable fake-only check |
|---|---|---|
| **A — foundation** | `package.json`, lockfile, `tsconfig.json`, `src/contracts.ts`, `src/preferences.ts` (`loadPreferences():Promise<VoicePreferences>`, `savePreferences(value):Promise<void>`, `keyStatus():{present:boolean;last4?:string}`, `requireApiKey():string`), `src/model.ts` (`ensureWakeModel(signal):Promise<ModelPaths>`), `assets/keywords.json`, `test/preferences.test.ts`, `test/model.test.ts`. | Fake download/tar runner; checksum mismatch, traversal, corrupt state fail closed. `node --test test/preferences.test.ts test/model.test.ts && npm run typecheck`. Pin actual archive digest and generated keywords before marking complete. |
| **B — local audio/KWS** | `src/mic.ts` (`listMicrophones():Promise<MicDevice[]>`, `startMicrophone(mic,onFrame,onError):Promise<Disposable>`), `src/wake.ts` (`createWakeDetector(paths,choice,sensitivity,onWake):WakeDetector` with `push(frame)`, `reset()`, `close()`), `test/mic.test.ts`, `test/wake.test.ts`. | Fake spawn/addon; one capture, odd-byte frame stitching, child exit, idempotent stop, reset after wake. `node --test test/mic.test.ts test/wake.test.ts && npm run typecheck`. |
| **C — Scribe** | `src/stt.ts` (`startUtterance(key,{onPartial,onFinal,onFailure},socketFactory?):Utterance` with `push(frame):void`, `close():Promise<void>`), `test/stt.test.ts`. | Fake socket; header/query, VAD protocol, bounded buffers, duplicate timestamp ignored, final-once, real error names, timeout/cancel races. `node --test test/stt.test.ts && npm run typecheck`. |
| **D — speech output** | `src/speech-text.ts` (`createSpeechChunker(emit):(push(delta),finish(),cancel())`), `src/player.ts` (`startPlayer(onError):PcmPlayer` with `write`, `finish`, `close`), `src/tts.ts` (`startSpeech({key,voiceId,onDone,onFailure},socketFactory?,playerFactory?):Speech` with `push`, `finish`, `cancel`), corresponding `test/*.test.ts`. | Split Markdown fences, no code speech, deltas before message end, null final, backpressure, cancellation and ffplay args via fakes. `node --test test/speech-text.test.ts test/player.test.ts test/tts.test.ts && npm run typecheck`. |
| **E — final integration, after A–D** | `src/index.ts`, `src/commands.ts`, `test/integration.test.ts`, `README.md`. Own Pi event wiring, state-machine transitions, slash parser/completion, voice discovery, lifecycle. | Fake Pi/ports: no processes at factory, default off, wake→final→one prompt, busy follow-up, barge-in, input abort, reload cleanup, key-missing message. `node --test test/integration.test.ts && npm test && npm run typecheck`. |

A owns shared manifest/types first; B–D may implement against **above frozen contracts** in parallel, with no other lane editing A’s files. E starts after their interfaces land. `npm test` runs `node --test test/*.test.ts`; `npm run typecheck` runs `tsc --noEmit`. Fake tests need no real key, mic, paid request, or installed FFmpeg. Final operator smoke test is separate.

### Risks / approvals

1. **Blocking live gates:** Node 25 Sherpa addon load and macOS dylib resolution; actual generated BPE keywords detecting both phrases; FFplay’s `-sample_rate`/PCM playback; FFmpeg TCC behavior; ElevenLabs socket auth, VAD timing, final-field spelling. Run opt-in macOS smoke tests before calling feature production-ready.
2. **Security/privacy:** accidental wake can submit spoken room content and trigger Pi tools; visible microphone state and session-only opt-in mitigate, not eliminate. Provider receives post-wake audio and optional assistant prose. Key suffix reveals four characters as explicitly requested; no full secret anywhere observable.
3. **Model integrity:** upstream supplies no digest in inspected release metadata. Worker must pin independently checked checksum, not defer verification to runtime.
4. **No further user decision needed** for scoped design. If robust speakerphone barge-in without headset is required, that would require separate echo-cancellation product decision.

Sources: installed [Pi extension types](file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts#L1128-L1227), [lifecycle guidance](file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md#L52-L63), [package guidance](file:///opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md#L57-L90), [ElevenLabs event reference](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference), [Sherpa KWS API](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/keyword_spotter.html), [ws documentation](https://raw.githubusercontent.com/websockets/ws/8.21.3/doc/ws.md).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Complete design above specifies lifecycle, event/state contracts, commands, secrets, provisioning, disjoint ownership, checks, and residual live-smoke risks."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "No shell commands run; read, grep, web_search, and fetch supplied design evidence.",
      "result": "not-run",
      "summary": "Review-only task; proposed test commands are handoff criteria, not execution claims."
    }
  ],
  "validationOutput": [],
  "residualRisks": [
    "Node 25 Sherpa native loading and model wake accuracy need real-device tests.",
    "ElevenLabs socket and FFplay behavior need opt-in live smoke tests.",
    "Model archive checksum must be pinned before runtime provisioning ships."
  ],
  "noStagedFiles": true,
  "diffSummary": "No edits.",
  "reviewFindings": [
    "blocker before implementation completion: pin independently checked model archive SHA-256 and verified BPE keywords",
    "research correction: installed Pi sendUserMessage returns void and has no source option"
  ],
  "manualNotes": "Latest user decision enforced: environment-only API key; no Keychain or key-setting commands. No executor handoff by oracle; parent can assign listed lanes."
}
```

---

## Design amendment — supersedes two points above

**Inherited decision:** iPhone can be selected as an AVFoundation microphone in v1. Remote phone audio is future scope; design seam now, do not implement transport.

**Drift check:** Previous recommendation to fail when saved microphone disappears conflicts with new requirement. Replace it: `/voice mic list` parses FFmpeg AVFoundation stderr into **device names**; completion inserts names, never indices. Save name. On startup, if saved name is absent, select system default and notify user. Duplicate names require disambiguation before saving.

**Audio seam:** Lanes B and D own native adapters; lane E wires them. Wake/STT/TTS consume these contracts rather than FFmpeg/FFplay directly:

```ts
interface AudioSource {
  start(onPcm: (chunk: Buffer) => void, onError: (error: Error) => void): Promise<void>;
  stop(): Promise<void>;
}
// Source contract: 16-kHz, mono, signed 16-bit LE PCM; arbitrary chunk boundaries.

interface AudioSink {
  start(format: { sampleRate: 24000; channels: 1; encoding: "s16le" }): Promise<void>;
  write(chunk: Buffer): Promise<void>; // backpressure-aware, ordered
  finish(): Promise<void>;             // drain normal response
  stop(): Promise<void>;               // immediate barge-in/cancel
}
```

Lane B: `AvFoundationAudioSource`, name discovery/fallback tests. Lane D: `FfplayAudioSink`, drain/stop tests. Lane E: fake-source/fake-sink integration tests proving wake→STT→TTS orchestration contains no native-device assumptions. Source/sink ownership remains session-scoped; shutdown closes both.

**Remote transport risk/recommendation:** Prefer **WebRTC** for future browser-based iPhone call: native bidirectional audio, jitter handling, and acoustic echo cancellation suit speakerphone barge-in better than raw WebSocket PCM. Adapter converts negotiated audio to/from stated PCM contracts; signaling, authenticated pairing, TLS, and TURN require separate security design. Browser background/microphone behavior needs iPhone testing. Use Twilio only if requirement becomes actual PSTN calling: added provider, transcoding, cost, and privacy boundaries.

**Need from main agent:** None. No additional executor handoff beyond amended lane contracts.

---

## Parent decisions (user-approved, supersede everything above)

1. **Persistence approved:** preferences live in `~/Library/Application Support/pi-voice/state.json` (0600, atomic replace), written only by slash commands. Never store the key, transcripts, or audio there.
2. **Autostart (user decision; replaces "off by default on every launch"):** add `autostart: boolean` to `VoicePreferences`, default `true`, toggled with `/voice autostart on|off`. On `session_start`, when `ctx.hasUI` is true, autostart is on, the wake model is already provisioned and `ELEVENLABS_API_KEY` is present, start wake listening automatically. If any of those is missing, do not start; show one status hint (for example "voice: run /voice setup"). **Never download the model during startup.** `/voice on` and `/voice off` still work per session; `/voice off` does not change the autostart preference.
3. **TTS preference persists:** add `tts: boolean` to `VoicePreferences`, default `false`; `/voice tts on|off` saves it. TTS stays inactive while the key is missing or no voice is selected, and status says why.
4. **Final `VoicePreferences`:** `{ version: 1; voiceId?: string; wake: "hey-pi"|"hi-pi"|"both"; sensitivity: "low"|"normal"|"high"; mic: {kind:"default"}|{kind:"named";name:string}; autostart: boolean; tts: boolean }`. Older or missing fields are filled from defaults. An unknown `version` value or unparseable JSON falls back to defaults with a warning.
5. **Mic selection:** the amendment's name-based selection with fallback to the default device plus a notice supersedes the table row that said to "fail clearly if missing".
6. **Audio seam supersedes the lane B/D signatures:** `AudioSource` and `AudioSink` (amendment above) live in `src/contracts.ts` (lane A). Lane B exports `listMicrophones(): Promise<MicDevice[]>` and `createAvFoundationSource(mic: VoicePreferences["mic"], deps?): AudioSource`. Lane D exports `createFfplaySink(deps?): AudioSink`, and `startSpeech` takes an `AudioSink` factory instead of `playerFactory`. Wake, STT and TTS logic never spawn processes directly.
8. **TTS model (user decision):** default `eleven_v4_turbo`, documented by ElevenLabs as its low-latency v4 model with bidirectional streaming. v4 voice settings are only `stability` and `similarity_boost`. Add a persisted `ttsModel?: string` preference (default `eleven_v4_turbo`) and `/voice model <id>`, autocompleting from `GET /v1/models` filtered to `can_do_text_to_speech`, cached in memory, with `eleven_v4_turbo` and `eleven_flash_v2_5` as an offline fallback list. Lane E owns adding `ttsModel` to `src/contracts.ts` and `src/preferences.ts` (plus their tests), since lane A is finished. `startSpeech` accepts `modelId`.
7. **Remote/phone-call audio is out of scope.** If it comes back later, the design should rely on isolation (a sandboxed network piece that can only pass audio, reachable only over Tailscale) rather than on permission checks.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Amendment specifies name-based iPhone mic selection, missing-device default fallback, source/sink contracts, lane ownership, verification, and remote transport risk."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [],
  "residualRisks": [
    "Duplicate AVFoundation device names need explicit disambiguation.",
    "WebRTC signaling, authentication, TURN, iPhone background behavior, and echo quality remain future design/smoke work."
  ],
  "noStagedFiles": true,
  "diffSummary": "No edits; design-only amendment.",
  "reviewFindings": [
    "Earlier fail-on-missing-mic recommendation superseded by notice plus default-device fallback."
  ],
  "manualNotes": "Apply this amendment to previous full design before delegating lanes. Remote transport remains unimplemented."
}
```
