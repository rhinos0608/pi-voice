# Concurrent raw-ffmpeg + helper(VP on) probe — results

Probe: `probe.ts` (this dir). 10 s per condition, ambient room sound only, no playback.
ffmpeg uses the exact arg vector from `createAvFoundationSource` in `src/mic.ts`
(input `:default`). Helper via `ensureVoiceIoHelper` + `createVoiceIo({ helperPath,
voiceProcessing: true })` (VP on, AGC off default). Two full runs.

Nominal rate for 16 kHz mono s16le: 32000 B/s. Span = time since first byte.

## Run 1

| stream | bytes | span | rate (B/s / % nominal) | RMS dBFS | peak dBFS | zero% | bands 0-1k / 1-4k / 4-8k | error |
|---|---|---|---|---|---|---|---|---|
| (1) ffmpeg alone | 274740 | 9.78 s | 28084 (87.8%) | -52.7 | -28.0 | 0.62 | 98.0 / 1.8 / 0.2 | none |
| (2) ffmpeg + helper | 276106 | 9.70 s | 28455 (88.9%) | -78.4 | -59.2 | 11.12 | 99.2 / 0.6 / 0.2 | none |
| (2) helper + ffmpeg | 319454 | 9.89 s | 32289 (100.9%) | -52.6 | -17.8 | 19.82 | 68.8 / 14.3 / 16.9 | none |
| (3) helper alone | 319454 | 9.90 s | 32264 (100.8%) | -51.6 | -22.6 | 18.45 | 81.8 / 2.9 / 15.3 | none |

ffmpeg (1)->(2): bytes ratio 1.005, RMS delta **-25.6 dB**.

## Run 2

| stream | bytes | span | rate (B/s / % nominal) | RMS dBFS | peak dBFS | zero% | bands 0-1k / 1-4k / 4-8k | error |
|---|---|---|---|---|---|---|---|---|
| (1) ffmpeg alone | 244362 | — | 24983 | -65.7 | — | — | 98.5 / 1.3 / 0.3 | none |
| (2) ffmpeg + helper | 278836 | 9.74 s | 28633 (89.5%) | -80.9 | -59.7 | 20.31 | 91.9 / 3.5 / 4.7 | none |
| (2) helper + ffmpeg | 300170 | 9.30 s | 32291 (100.9%) | -42.5 | -13.4 | 8.63 | 88.9 / 8.3 / 2.8 | none |
| (3) helper alone | 319454 | 9.90 s | 32268 (100.8%) | -46.0 | -17.6 | 13.63 | 91.7 / 5.5 / 2.8 | none |

ffmpeg (1)->(2): bytes ratio 1.141, RMS delta **-15.2 dB**.

(ffmpeg `exit=code 255` is its normal SIGTERM/SIGKILL stop, not a failure;
stderr empty, no spawn/stall/permission errors on any stream in any condition.)

## Verdict

**Concurrent capture is feasible but the raw feed is NOT unaffected.**
Both processes run side by side with no errors and correct byte rates
(ffmpeg byte flow unchanged, helper rate identical with/without ffmpeg:
32291 vs 32268 B/s), but the ffmpeg stream is strongly attenuated while the
helper runs VP: -25.6 dB (run 1) and -15.2 dB (run 2), with zero-sample
fraction jumping from 0.6% to 11–20%. Band shares stay low-frequency
dominated, but at -80 dBFS that is mostly residual/noise floor, so tilt
comparison is not very informative. The signature (level drop + zero
gating, rate preserved) looks like system-wide application of voice
processing (macOS voice-isolation mic mode engaging globally once any
client enables VP) rather than room variation: room level did drift
between runs (ffmpeg-alone -52.7 -> -65.7), yet the concurrent condition
was the quietest in both runs.

**Caveat:** ambient-only cannot show speech effects (suppression behaviour
on voiced frames, formant distortion, AGC pumping). Owner to confirm with
speech via diag path E whether the attenuated raw feed still verifies
(osine may be partly level-invariant, but gating/NS distortion may hurt).
Practical consequence: prefer capturing speaker-verification audio on the
raw path while the helper is stopped, or keep both and compare E scores.
