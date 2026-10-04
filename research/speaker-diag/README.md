# Speaker capture-path diagnostic

Compares four microphone capture paths on the SAME 4 spoken phrases to find
out whether the owner's unstable CAM++ embeddings come from the audio fed to
the embedder (suspected) rather than from the accept threshold. Phrases are
the first 4 enrollment phrases from `src/commands.ts` (longer sentences,
>= 3 s of speech each).

- **A — helper VP on, AGC off**: production default
  (`createVoiceIo({ voiceProcessing: true })`, 16 kHz mono s16le on stdout).
- **B — helper VP on + AGC on**: `createVoiceIo({ voiceProcessing: true,
  agc: true })` (passes `--agc on` to the helper).
- **C — helper VP on + bypass**: `createVoiceIo({ voiceProcessing: true,
  bypass: true })` — raw mic, no Apple processing, same pipeline.
- **D — ffmpeg raw**: AVFoundation capture with the exact arguments from
  `createAvFoundationSource` in `src/mic.ts` (`-i :default -ac 1 -ar 16000
  -f s16le`), i.e. the pre-helper capture path.

## How to run

From the repo root (`/Users/rhinesharar/pi-voice`):

```sh
node research/speaker-diag/diag.mjs               # interactive, needs the owner + mic (paths A,C,D)
node research/speaker-diag/diag.mjs --paths A,C,D  # same; pick any subset of A,B,C,D
node research/speaker-diag/diag.mjs --self-test    # no human, no microphone
node research/speaker-diag/diag.mjs --help
```

Interactive flow: for each selected path in turn, each of the 4 printed
phrases is recorded (~3–4 s; owner presses Enter to start, recording stops on
VAD end-of-speech or after 6 s). Audio stays in memory; nothing is written to
disk. Do NOT run the interactive mode unattended — it needs the owner
speaking into the microphone.

Self-test: synthesizes the same 4 phrases with macOS `say -o` (file output,
no audible playback) into temp files, converts to 16 kHz mono s16le in memory
with ffmpeg, deletes the temp files, then runs the identical
metrics/embedding pipeline. Exit 0 + `SELF-TEST PASS` means the tool works.

## What each number means

Per clip:

- `bytes (Xs @16k) vs wall Ys (Z%)` — sample-rate sanity. Bytes received
  should equal wall-clock time at 16 kHz mono s16le (32000 B/s). A ratio far
  from 100% (flagged `SAMPLE-RATE MISMATCH?` beyond ±5%) means the capture
  path is delivering the wrong rate — e.g. the earlier 3 s VP capture that
  produced only 66,858 bytes instead of ~96,000.
- `rms` (dBFS) — loudness. Healthy speech is roughly **−25 to −10 dBFS**.
  The suspect VP-on capture sat at about −58 dBFS (near silence) — that alone
  explains unstable embeddings.
- `peak` (dBFS) — loudest sample. Should stay a few dB below 0; at 0 dB with
  high `clip` the signal is distorted.
- `clip %` — share of samples at full scale. Healthy: **< 0.1%**.
- `dc` — DC offset as a fraction of full scale. Healthy: **|dc| < 0.01**.
- `vad` — milliseconds of Silero speech detected (same model/config as
  `src/vad.ts`, fed in 512-sample windows like the live endpointer). A 3–4 s
  phrase should show most of its duration as speech. `(energy fallback)`
  appears only if the VAD model file is missing.
- `score` — `scoreSample` of the full-clip embedding against the saved owner
  profile (`loadSpeakerProfile`); `n/a` when no profile is enrolled.

Embedding views (each printed as a 4×4 cosine matrix with mean/min):

- **full-clip** — embedding over everything recorded, silence included.
- **speech-only** — embedding over VAD-speech audio only. If this is much
  more consistent than full-clip, leading/trailing silence is polluting
  embeddings.
- **first-1.2s** — embedding over the first 1.2 s of speech (the gate's early
  window is 1.2 s of speech by default). If this is inconsistent while longer
  windows are fine, the gate is scoring before it has enough voice.

Cross-path cosines show, per phrase, how similar the paths' speech-only
embeddings are to each other — low values mean the capture path itself
changes the voice signature. A vs C isolates the effect of Apple's
processing; C vs D isolates helper vs ffmpeg. The summary table gives mean
within-path speech-only cosine, mean score vs profile, and mean level per
path, plus a one-line verdict naming the most self-consistent path. The
tool finally prints the whole summary again as one copy-pasteable block
(`COPY-PASTE SUMMARY BEGIN/END`, numbers only, no audio, no secrets).

## Expected healthy ranges (heuristics)

- Same-speaker pairwise cosine on ~3 s of clean speech: typically **≥ 0.7**.
- Synthetic `say` voices through files score 0.86–0.95 self-consistency; the
  owner's live enrollments only reached 0.35–0.76 pairwise, with most live
  utterances scoring < 0.53 against the profile — that gap is the symptom
  this tool localizes.
- If no path reaches ~0.7 within-path consistency at healthy levels
  (−25 to −10 dBFS, no clipping, VAD ≈ utterance length), the problem is
  upstream of the embedder (mic, OS processing, sample-rate conversion) and
  not the threshold.
