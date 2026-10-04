# STT A/B benchmark: Apple on-device vs ElevenLabs Scribe

Machine: macOS 26.6.2 (arm64), Xcode Swift 6.4, ffmpeg 5.1.1 (`/opt/miniconda3/bin/ffmpeg`), Node v25.9.0.
Date: 2026-10-04. All work confined to `research/stt-bench/`; nothing else in the repo touched.

## Corpus

20 short spoken coding prompts (`corpus.json`), rendered with macOS `say` in 2 voices:

- **Samantha** (`en_US`, female) and **Daniel** (`en_GB`, male) — the most natural
  general-purpose voices installed. No Siri/Premium/Enhanced voices are installed
  on this machine (`say -v '?'` lists stock voices plus the neural multi-locale
  Eddy/Flo/Grandma/Grandpa/Reed/Rocko/Sandy/Shelley family; no `Siri*` entries).
- 16 kHz mono s16le WAV (`wav/<id>_<voice>.wav`), plus a noisy variant per file
  (`wav/<id>_<voice>_noisy.wav`): pink noise mixed at **10.1 dB SNR** (range
  9.9–10.2 dB across the 40 files, calibrated per file against the exact noise
  segment; mix peak-normalized to 0.95, zero clipped files).
- Totals: 80 files, 282.0 s (4.70 min). Clean subset: 141.0 s (**2.35 min**).

> **Caveat: synthetic speech is a proxy only.** `say` output is cleaner and more
> consistently enunciated than real developer speech (no disfluencies, mic
> variation, or room acoustics beyond the added pink noise). Absolute WER numbers
> will be optimistic vs. real usage; the *relative* engine ranking is the signal.

## Engines

- **Apple** (`apple-stt.swift`, built with `xcrun swiftc -O apple-stt.swift -o apple-stt`):
  macOS 26 `SpeechAnalyzer` + `AssetInventory`, three variants —
  `transcribe` (`SpeechTranscriber`, `.transcription` preset),
  `dictation` (`DictationTranscriber`, `.shortDictation` preset),
  `context` (`SpeechTranscriber` + `AnalysisContext.contextualStrings[.general]`
  set to the 60 technical terms in `corpus.json`). API names taken from the SDK
  swiftinterface (`MacOSX.sdk/.../Speech.framework/.../arm64e-apple-macos.swiftinterface`).
  `AssetInventory.status` reported `installed`; no download needed, no
  authorization prompt from the CLI binary. Legacy `SFSpeechRecognizer` fallback
  was not needed.
- **ElevenLabs** (`elevenlabs.mjs`): batch `POST https://api.elevenlabs.io/v1/speech-to-text`
  (per https://elevenlabs.io/docs/api-reference/speech-to-text/convert),
  `model_id=scribe_v2`. **Clean files only** (2.35 min of cloud audio, under the
  3-minute budget). Zero API errors across 40 requests.

## Results

Scoring (`score.mjs`): case/punctuation-insensitive WER (punctuation → space);
technical-term accuracy = fraction of the utterance's key tokens
(`tech` in `corpus.json`, e.g. npm, typescript, usestate, pnpm, vad) appearing
as whole words in the hypothesis. File/batch mode only below (n=20 per cell);
realtime `rt` rows are excluded from the means.

| engine | voice | cond | mean WER | tech acc | mean latency |
|---|---|---|---|---|---|
| apple:transcribe | samantha | clean | 0.259 | 0.475 | 0.18 s/file (wall) |
| apple:transcribe | samantha | noisy | 0.305 | 0.410 | 0.17 s/file |
| apple:transcribe | daniel | clean | 0.290 | 0.393 | 0.18 s/file |
| apple:transcribe | daniel | noisy | 0.422 | 0.311 | 0.18 s/file |
| apple:dictation | samantha | clean | 0.334 | 0.361 | 0.39 s/file |
| apple:dictation | samantha | noisy | 0.401 | 0.262 | 0.48 s/file |
| apple:dictation | daniel | clean | 0.459 | 0.279 | 0.46 s/file |
| apple:dictation | daniel | noisy | 0.576 | 0.164 | 0.77 s/file |
| apple:context | samantha | clean | 0.259 | 0.475 | 0.17 s/file |
| apple:context | samantha | noisy | 0.305 | 0.410 | 0.16 s/file |
| apple:context | daniel | clean | 0.290 | 0.393 | 0.17 s/file |
| apple:context | daniel | noisy | 0.422 | 0.311 | 0.17 s/file |
| elevenlabs:scribe_v2 | samantha | clean | **0.071** | **0.852** | 0.93 s/req |
| elevenlabs:scribe_v2 | daniel | clean | **0.083** | **0.820** | 0.96 s/req |

Realtime-paced Apple feed (`rt` mode, 8 runs): end-of-audio → final result
**0.14–0.26 s** (transcribe: 0.143–0.191 s; context: 0.139–0.205 s).
Dictation `rt` runs completed but recorded no final-result timestamp
(`shortDictation` results did not surface `isFinal` in this harness).

Headline: Scribe v2 dominates on accuracy (WER ~0.08 vs Apple's best ~0.26;
tech-term accuracy 0.82–0.85 vs 0.31–0.48). Apple wins on latency for short
clips (~0.18 s on-device wall time vs ~0.95 s cloud round-trip) and degrades
more under noise and on the en-GB male voice. `DictationTranscriber` is
strictly worse than `SpeechTranscriber` here. **The `context` variant is
bit-identical to `transcribe` on all 80 files** — `contextualStrings[.general]`
had no measurable effect in this setup (either the terms need a different tag/
delivery path, or the LM already covers them).

## Worst 5 per engine (raw transcripts)

#### apple:transcribe
- u09_daniel_noisy (WER 0.89)
  - ref: debug the regex that parses json lines from stdout
  - hyp: The bugger rejects that pauses the same lines from sit down.
- u16_daniel_noisy (WER 0.70)
  - ref: grep stderr for the stack trace and curl the tarball
  - hyp: Gret's bare for the stacked trace and pel the tar ball.
- u07_daniel_noisy (WER 0.67)
  - ref: migrate the postgres schema and backfill the redis cache
  - hyp: Migrate the post because female and backbuilder are disk cache.
- u14_daniel_noisy (WER 0.64)
  - ref: open a websocket to the sqlite backed chat server through nginx
  - hyp: Opener with soccer to the slight back chat server proof games.
- u07_daniel_clean (WER 0.56)
  - ref: migrate the postgres schema and backfill the redis cache
  - hyp: Migrate the post gers, schema and backfill are a disk cache.

#### apple:dictation
- u07_daniel_noisy (WER 1.00)
  - ref: migrate the postgres schema and backfill the redis cache
  - hyp: My great the post goes steam and back builder a cash
- u07_daniel_clean (WER 1.00)
  - ref: migrate the postgres schema and backfill the redis cache
  - hyp: My grade, the posters steamer and backfield are a disc cash
- u10_daniel_clean (WER 0.82)
  - ref: update the yaml config and rerun eslint on the vite bundle
  - hyp: Not vaguely Yamel configured resent on the white bun
- u18_daniel_noisy (WER 0.80)
  - ref: refactor the CLI to stream NDJSON over the API gateway
  - hyp: Refer to the police screen and JSO and over the AAPI Gateway
- u09_daniel_noisy (WER 0.78)
  - ref: debug the regex that parses json lines from stdout
  - hyp: The bug the rejects that causes just limes from down

#### apple:context
- (identical to apple:transcribe on all 80 files — see note above)
- u09_daniel_noisy (WER 0.89)
  - ref: debug the regex that parses json lines from stdout
  - hyp: The bugger rejects that pauses the same lines from sit down.
- u16_daniel_noisy (WER 0.70)
  - ref: grep stderr for the stack trace and curl the tarball
  - hyp: Gret's bare for the stacked trace and pel the tar ball.
- u07_daniel_noisy (WER 0.67)
  - ref: migrate the postgres schema and backfill the redis cache
  - hyp: Migrate the post because female and backbuilder are disk cache.
- u14_daniel_noisy (WER 0.64)
  - ref: open a websocket to the sqlite backed chat server through nginx
  - hyp: Opener with soccer to the slight back chat server proof games.
- u07_daniel_clean (WER 0.56)
  - ref: migrate the postgres schema and backfill the redis cache
  - hyp: Migrate the post gers, schema and backfill are a disk cache.

#### elevenlabs:scribe_v2
- u08_daniel_clean (WER 0.27)
  - ref: add a graphql resolver with async await and proper error handling
  - hyp: Add a graphical resolver with a sync await and proper error handling
- u13_samantha_clean (WER 0.22)
  - ref: rotate the oauth secrets and reissue the JWT tokens
  - hyp: Rotate the O of secrets and reissue the JWT tokens
- u04_daniel_clean (WER 0.20)
  - ref: check git status and commit with message fix VAD endpointing
  - hyp: Check git status and commit with message fix VAD end pointing
- u04_samantha_clean (WER 0.20)
  - ref: check git status and commit with message fix VAD end pointing
  - hyp: Check git status and commit with message fix VAD end pointing
- u06_daniel_clean (WER 0.20)
  - ref: rewrite the dockerfile to cache the pnpm store between builds
  - hyp: Rewrite the decur file to cache the pnpm store between builds

## Reproduce

```bash
cd research/stt-bench
./make-corpus.sh                 # say -> 16 kHz WAV + 10 dB pink-noise variants (wav/)
xcrun swiftc -O apple-stt.swift -o apple-stt
./run-apple.sh                   # 3 variants x 80 files + rt subset -> apple_results.jsonl
ELEVENLABS_API_KEY=... node elevenlabs.mjs   # 40 clean files -> elevenlabs_results.jsonl
node score.mjs                   # table on stdout + score.json
```

## API errors encountered (verbatim)

None from ElevenLabs (40/40 HTTP 200). Apple issues, all in the `rt`
(realtime-paced) path, all resolved:

1. `AVAudioFile.read(into:)` (no-frame-count variant) threw a bridgeless ObjC
   error on the first read of every file. Surfaced as:
   `DEBUG rt: read loop threw type=_GenericObjCError domain=Foundation._GenericObjCError code=0 info=[:]`
   (JSON: `{"error":"nilError",...}`). Fix: `audioFile.read(into:frameCount:)`
   after `framePosition = 0` works reliably.
2. Combining `SpeechAnalyzer(inputSequence:modules:...)` with
   `analyzeSequence(_:)` traps the process. Log line + backtrace:
   `[SpeechFramework] Failed precondition: SpeechAnalyzer: Cannot simultaneously analyze multiple input sequences`
   at `Speech.SpeechAnalyzer.analyzeSequence(τ_0_0) + 1012` (`EXC_BREAKPOINT`).
   Fix: construct with `SpeechAnalyzer(modules:)` (+ `setContext` for the
   context variant), then `analyzeSequence(input)`.
3. Harmless framework log on every CLI invocation (no bundle id):
   `[SpeechFramework] +[SFUtilities defaultClientID]_block_invoke Application does not have a bundle identifier; using unstable "apple-stt" as client identifier`

## Caveats

- Synthetic `say` speech is a proxy only (see Corpus note); expect higher absolute
  WER on real microphone speech.
- Reference transcripts use speakable forms ("src slash controller dot ts",
  "chmod plus x", "VAD" spoken as letters by Daniel/Samantha). Engines that
  reconstruct written forms ("src/controller.ts", "chmod +x") are *penalized* by
  WER here despite arguably better output — normalization maps punctuation to
  spaces but keeps "slash"/"dot"/"plus" as word errors. Tech-term accuracy
  partially compensates.
- ElevenLabs ran on clean audio only (cloud-audio budget); noisy-column
  comparison Apple-vs-Scribe is not available.
- `say` rate/quality per voice is fixed defaults; no per-utterance rate tuning.
- One binary quirk worth knowing: `local a="$1" b="${a%...}"` on a single
  `local` line expands `b` before `a` is set (this bit an early version of
  `make-corpus.sh` and cost a re-render).
- `ELEVENLABS_API_KEY` was used from the environment only; it appears in no
  file in this directory (only the header name `xi-api-key` in `elevenlabs.mjs`).
