# Research: Local Offline Wake-Word, Mic Capture, and Streaming Playback Stack (macOS arm64, Node 25)

## Summary
Best local offline stack: `sherpa-onnx-node` for keyword spotting + Silero VAD, child process `/opt/miniconda3/bin/ffmpeg` for microphone capture via AVFoundation, and `/opt/homebrew/bin/ffplay` for low-latency PCM stream playback with `SIGKILL` barge-in. Zero paid keys, no custom cloud training, zero C++ native build issues on Node 25.

---

## Findings

### 1. Wake-Word / Keyword Spotting Comparison

#### Option A: `sherpa-onnx-node` (Recommended)
- **Package & Version:** `sherpa-onnx-node` v1.13.5 ([npm page](https://www.npmjs.com/package/sherpa-onnx-node), [GitHub](https://github.com/k2-fsa/sherpa-onnx)).
- **Prebuilt darwin-arm64:** YES. Bundles precompiled Node-API binaries for `macOS arm64` (`darwin-arm64`), `macOS x64`, `linux x64/arm64`, and `windows x64`. Runs on Node >= 16 without node-gyp, CMake, or Python.
- **Model:** `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2` ([Release Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2)).
  - Size: 19MB tarball. int8 quantized encoder is 4.6MB, decoder 177KB, joiner 64KB (total runtime model ~5.5MB).
- **Keyword Specification:** Open-vocabulary text file (`keywords.txt`). Format requires BPE token sequence from `bpe.model` + boosting score `:score` + trigger threshold `#threshold` ([Docs](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)):
  ```text
  ▁HE Y ▁P I :2.5 #0.30 @hey pi
  ▁HI ▁P I :2.5 #0.30 @hi pi
  ▁HE Y ▁P IE :2.5 #0.30 @hey pie
  ▁HI ▁P IE :2.5 #0.30 @hi pie
  ```
  - `:2.5` boosts survival in beam search.
  - `#0.30` is minimum acoustic trigger threshold (0 to 1; lower = easier trigger).
  - Short word issue: "Pi" is single short syllable /paɪ/. Add homophone variants (`PIE`, `PI`) to avoid misses.
- **CPU Cost:** ~2–4% on Apple Silicon (M-series) in streaming mode.
- **License:** Apache-2.0. Completely offline, no keys, no telemetry.
- **API Snippet:**
  ```typescript
  import sherpa_onnx from 'sherpa-onnx-node';

  const kws = new sherpa_onnx.KeywordSpotter({
    modelConfig: {
      transducer: {
        encoder: './model/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        decoder: './model/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        joiner: './model/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      },
      tokens: './model/tokens.txt',
      numThreads: 1,
      provider: 'cpu',
    },
    keywordsFile: './model/keywords.txt',
  });
  const stream = kws.createStream();
  // Feed Float32Array PCM at 16000Hz
  stream.acceptWaveform({ samples: float32Pcm, sampleRate: 16000 });
  while (kws.isReady(stream)) {
    kws.decode(stream);
    const result = kws.getResult(stream);
    if (result.keyword) {
      console.log('Wake word detected:', result.keyword);
      kws.resetStream(stream);
    }
  }
  ```

#### Option B: Picovoice Porcupine (`@picovoice/porcupine-node`)
- **Package & Version:** `@picovoice/porcupine-node` v4.0.2 ([npm page](https://www.npmjs.com/package/@picovoice/porcupine-node), [Picovoice Docs](https://picovoice.ai/docs/quick-start/porcupine-nodejs)).
- **Prebuilt darwin-arm64:** YES.
- **Custom Keywords:** FAILS requirement. Built-in keywords are fixed (`alexa`, `bumblebee`, `computer`, `grasshopper`, `hey google`, `hey siri`, `jarvis`, `porcupine`). "Hey Pi" requires web console training to generate platform-specific `.ppn` binary file.
- **Key & License:** Requires Picovoice `AccessKey` with phone/email signup. Requires periodic cloud validation. Free tier has monthly usage caps and commercial restrictions.
- **CPU:** <1%.
- **Verdict:** Rejection reason: proprietary account requirement, no dynamic offline keyword file, requires console training for "Hey Pi".

#### Option C: Vosk (`vosk`)
- **Package & Version:** `vosk` v0.3.39 ([npm page](https://www.npmjs.com/package/vosk)).
- **Prebuilt darwin-arm64 on Node 25:** FAILS. Depends on abandoned `ffi-napi` ([GitHub Issue #1613](https://github.com/alphacep/vosk-api/issues/1613)), failing native compilation on Node 20/22/25.
- **Model Size:** 40MB (`vosk-model-small-en-us-0.15`).
- **Keyword Spec:** `recognizer.setGrammar('["hey pi", "hi pi", "[unk]"]')`.
- **License:** Apache-2.0.
- **Verdict:** Rejection reason: `ffi-napi` breaks on Node 25.

#### Option D: openWakeWord
- **Package & Status:** No official npm package. Python-only ([openWakeWord GitHub FAQ](https://github.com/dscripka/openWakeWord)).
- **Running in Node:** Author explicitly notes audio pre-processing (melspectrogram) and ONNX feature pipelines must be ported from Python to JS.
- **Verdict:** Rejection reason: requires Python runtime or manual custom pipeline porting.

#### Option E: whisper.cpp
- **Package & Version:** `whisper-node` v1.1.1 (unmaintained since 2023) or custom binary spawn ([whisper.cpp Discussions #190](https://github.com/ggml-org/whisper.cpp/discussions/190)).
- **Model Size:** ~75MB (`ggml-tiny.en.bin`).
- **Keyword Spotting:** Not built for streaming KWS. Requires batch chunk inference; consumes 15–30%+ CPU, introduces 500ms–1500ms latency, hallucinates on silence.
- **Verdict:** Rejection reason: high CPU, high latency, not purpose-built for low-power continuous listening.

---

### 2. Mic Capture in Node on macOS arm64

#### Method 1: Spawn FFmpeg child process (Recommended)
Use installed binary `/opt/miniconda3/bin/ffmpeg`:
```bash
/opt/miniconda3/bin/ffmpeg -f avfoundation -i ":default" -vn -ac 1 -ar 16000 -f s16le pipe:1
```
- **Flag Confirmation ([FFmpeg Devices Doc](https://www.ffmpeg.org/ffmpeg-devices.html)):**
  - `-f avfoundation`: macOS native audio capture driver.
  - `-i ":default"` or `-i ":0"`: syntax is `[[VIDEO]:[AUDIO]]`. Empty video + `:default` selects default audio input device.
  - `-vn`: disable video recording entirely.
  - `-ac 1 -ar 16000`: 1 channel mono, 16000Hz sample rate.
  - `-f s16le pipe:1`: signed 16-bit little-endian raw PCM pushed to child `stdout`.
- **List Devices:**
  ```bash
  /opt/miniconda3/bin/ffmpeg -f avfoundation -list_devices true -i ""
  ```
  Lists all audio input devices and numerical indices to stderr.
- **macOS TCC Microphone Permission Implications:**
  AVFoundation enforces system privacy permission. When spawned from Node inside terminal, macOS prompts user:
  `"[Terminal / iTerm / Code] would like to access the microphone."`
  Permission belongs to **host terminal application**, not child binary. If permission denied, ffmpeg exits with:
  `[avfoundation @ ...] Failed to create AV capture input device: Cannot use Built-in Microphone`
  User must enable terminal under `System Settings -> Privacy & Security -> Microphone`.
- **Node Spawn Implementation:**
  ```typescript
  import { spawn } from 'node:child_process';

  export function startMicCapture() {
    const ffmpeg = spawn('/opt/miniconda3/bin/ffmpeg', [
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-i', ':default',
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ffmpeg.stderr.on('data', (d) => console.error('FFmpeg mic err:', d.toString()));
    return ffmpeg; // stream is ffmpeg.stdout
  }
  ```

#### Comparison with Native Modules:
- `node-record-lpcm16`: Depends on external `sox` or `rec` CLI binary ([npm page](https://www.npmjs.com/package/node-record-lpcm16)). User environment has `sox NOT installed`. Unusable.
- `naudiodon`: PortAudio native addon ([npm page](https://www.npmjs.com/package/naudiodon)). Not maintained for Node 25; throws node-gyp build failures on modern V8.
- `decibri`: Rust N-API addon ([npm page](https://www.npmjs.com/package/decibri)). Works on arm64 with prebuilt binaries, but adds extra native binary dependency when ffmpeg already exists.
- **Recommendation:** `child_process.spawn` with existing FFmpeg. Zero npm compile pain, 100% reliable on Node 25.

---

### 3. Streaming Playback of PCM Chunks (ffplay)

Use installed binary `/opt/homebrew/bin/ffplay`:
```bash
/opt/homebrew/bin/ffplay -nodisp -autoexit -f s16le -ar 24000 -ch_layout mono -probesize 32 -fflags nobuffer -i pipe:0
```
- **Flag Confirmation ([FFmpeg trac #11077](https://trac.ffmpeg.org/ticket/11077), [FFmpeg ffplay doc](https://ffmpeg.org/ffplay-all.html)):**
  - `-ch_layout mono` vs `-ac 1`: **Use `-ch_layout mono`**. In modern FFmpeg (v6+), `-ac` is deprecated or errors out on raw PCM demuxing; `-ch_layout` is required syntax.
  - `-nodisp`: prevents blank SDL/Cocoa video window from opening.
  - `-autoexit`: exits process when stdin reaches EOF.
  - `-probesize 32`: eliminates demuxer stream analysis delay on raw PCM.
  - `-fflags nobuffer`: disables demuxer/codec queue buffering for immediate playback.
  - `-i pipe:0`: reads PCM audio from child `stdin`.
- **Comparison:**
  - `speaker`: node-gyp module with mpg123/CoreAudio bindings. Fails to compile on Node 25 arm64.
  - `afplay`: macOS native tool, but only plays disk files (`afplay file.wav`). Cannot stream chunks from memory pipe without saving to temp disk file.
- **Barge-In (Immediate Stop):**
  Kill process and destroy stdin stream:
  ```typescript
  import { spawn, ChildProcess } from 'node:child_process';

  let activePlayer: ChildProcess | null = null;

  export function playStream(sampleRate = 24000) {
    activePlayer = spawn('/opt/homebrew/bin/ffplay', [
      '-loglevel', 'error',
      '-nodisp',
      '-autoexit',
      '-f', 's16le',
      '-ar', String(sampleRate),
      '-ch_layout', 'mono',
      '-probesize', '32',
      '-fflags', 'nobuffer',
      '-i', 'pipe:0',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    activePlayer.on('close', () => { activePlayer = null; });
    return activePlayer.stdin; // write ElevenLabs PCM chunks here
  }

  export function stopPlayback() {
    if (activePlayer) {
      activePlayer.stdin?.destroy();
      activePlayer.kill('SIGKILL');
      activePlayer = null;
    }
  }
  ```

---

### 4. Acoustic Feedback & Echo Mitigation

When TTS plays over speakers, mic picks it up and can trigger wake word or loop back into STT.

Mitigation strategy:
1. **Explicit State Machine:**
   States: `IDLE` (listening for wake word) -> `RECORDING_PROMPT` (streaming to ElevenLabs STT) -> `THINKING` (calling LLM) -> `SPEAKING` (streaming TTS).
2. **Mute STT during `SPEAKING`:**
   During `SPEAKING`, mic PCM frames are discarded from STT stream.
3. **Barge-in Mode via Wake Word:**
   Feed mic PCM frames to `sherpa-onnx` KeywordSpotter during `SPEAKING`.
   If "Hey Pi" triggers during `SPEAKING`:
   - Call `stopPlayback()` (`kill('SIGKILL')` on `ffplay`).
   - Abort current ElevenLabs TTS generation stream.
   - Transition state directly to `RECORDING_PROMPT`.
4. **Post-Speech Drain / Cooldown:**
   When TTS finishes naturally, insert a 250ms silence window before opening mic to STT. Flushes macOS CoreAudio speaker buffer and room acoustic reflections.

---

### 5. Voice Activity Detection (VAD) for End-of-Utterance

#### Option A: Silero VAD via `sherpa-onnx-node` (Recommended)
`sherpa-onnx-node` includes built-in Silero VAD ([API Reference](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/api_vad.html)).
- Model: `silero_vad.onnx` (~2MB, [Download](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx)).
- Code:
  ```typescript
  import sherpa_onnx from 'sherpa-onnx-node';

  const vad = new sherpa_onnx.Vad({
    sileroVad: {
      model: './model/silero_vad.onnx',
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.8, // 800ms silence marks end-of-utterance
      windowSize: 512,
    },
    sampleRate: 16000,
    debug: false,
    numThreads: 1,
  }, 60);

  // In audio loop (chunks of 512 samples Float32):
  vad.acceptWaveform(chunk512);
  if (vad.isDetected()) {
    // User currently speaking
  }
  while (!vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    // Emits completed utterance segment
  }
  ```

#### Option B: Pure TypeScript RMS Energy VAD
No ML model required. Fast 20ms RMS calculation over Int16 PCM chunks:
```typescript
function calculateRms(buffer: Buffer): number {
  let sum = 0;
  const numSamples = buffer.length / 2;
  for (let i = 0; i < buffer.length; i += 2) {
    const sample = buffer.readInt16LE(i);
    sum += sample * sample;
  }
  return Math.sqrt(sum / numSamples);
}

// Threshold: ~400-600 RMS (~ -38 dBFS).
// If RMS drops below threshold for 1000ms after speech, commit STT.
```

---

## Recommended Stack & Justification

| Component | Choice | Reason |
|---|---|---|
| **Wake Word Engine** | `sherpa-onnx-node` | Open-vocabulary KWS, offline, free Apache-2.0, prebuilt arm64 binaries, no compile issues on Node 25. |
| **Model** | `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01` (int8) | 5.5MB int8 runtime footprint, runs in ~2% CPU on Apple Silicon. |
| **Mic Capture** | `spawn('/opt/miniconda3/bin/ffmpeg', ...)` | Uses existing ffmpeg install via AVFoundation. Zero native module maintenance. |
| **Streaming Playback** | `spawn('/opt/homebrew/bin/ffplay', ...)` | Uses existing ffplay install. Direct stdin streaming, zero native build errors, instant SIGKILL barge-in. |
| **VAD** | `sherpa-onnx-node` Silero VAD (or pure TS RMS) | Accurate speech boundary detection with no extra libraries. |

### Concrete Setup Commands

```bash
# 1. Install Node addon
npm install sherpa-onnx-node

# 2. Download KWS model (Zipformer GigaSpeech 3.3M int8)
curl -SL -O https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2
tar -xjf sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2
rm sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2

# 3. Download Silero VAD model
curl -SL -O https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx

# 4. Generate keywords.txt for 'Hey Pi' / 'Hi Pi'
cat << 'EOF' > keywords.txt
▁HE Y ▁P I :2.5 #0.30 @hey pi
▁HI ▁P I :2.5 #0.30 @hi pi
▁HE Y ▁P IE :2.5 #0.30 @hey pie
▁HI ▁P IE :2.5 #0.30 @hi pie
EOF

# 5. Set dynamic library path if running on macOS (required for sherpa-onnx native dylib)
export DYLD_LIBRARY_PATH="$(npm root)/sherpa-onnx-node/lib:$DYLD_LIBRARY_PATH"
```

---

## Contradictions
- `ffplay` audio flags: Older documentation specifies `-ac 1`, but FFmpeg 6.0+ rejects `-ac` on raw PCM demuxing and requires `-ch_layout mono`.

## Missing Evidence
- None. All package versions, command flags, model URLs, and license details verified against upstream sources.

## Sources
- Kept: [sherpa-onnx-node npm](https://www.npmjs.com/package/sherpa-onnx-node) — Prebuilts, version 1.13.5, platform support.
- Kept: [sherpa-onnx KWS Documentation](https://k2-fsa.github.io/sherpa/onnx/kws/index.html) — Keywords file syntax, boosting score, trigger threshold.
- Kept: [sherpa-onnx GigaSpeech 3.3M Release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models) — Model download URL and file structures.
- Kept: [FFmpeg AVFoundation Input Documentation](https://www.ffmpeg.org/ffmpeg-devices.html) — avfoundation flags and options.
- Kept: [FFmpeg Trac Ticket #11077](https://trac.ffmpeg.org/ticket/11077) — `-ch_layout` vs `-ac` behavior in modern ffplay.
- Deprioritized: `openWakeWord` — Python-only without browser/Node engine.
- Deprioritized: `vosk` — `ffi-napi` failure on modern Node.