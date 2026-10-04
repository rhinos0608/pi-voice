# Other-app audio reference probes ("is that the speakers?")

Goal: decide how pi-voice can capture a **reference stream of what other apps
play** so it can reject wake words coming from the Mac's speakers instead of
the user. These probes do NOT run in CI and were NOT executed while preparing
them — **you (the owner, on this Mac, with speakers on) run them** while
playing a video.

What each probe does: captures ~10 s of system-playback audio and prints
per-second **RMS/peak dBFS, zero fraction, first-buffer latency, and format**,
plus a one-line `verdict:`. **No audio is ever written to disk** — only
aggregate statistics.

## Before you start

1. Start a video (YouTube etc.) **at normal listening volume** and keep it
   playing through all three probes. Note what you played + the volume.
2. Use the Mac's **built-in speakers or the current default output** (don't
   plug/unplug headphones mid-run — the tap follows the default output).
3. Each probe takes ~10 s. Keep the video playing the whole time.

## Run order (matters: bare tap → bundled tap → SCK)

### 1. Bare tap probe (expect: possibly silent all-zero buffers)

```sh
xcrun swiftc -O research/other-audio/tap-probe.swift -o /tmp/tap-probe
/tmp/tap-probe
```

- **Dialogs to expect:** possibly none at all — and that is the point. A bare
  CLI inherits its terminal's bundle identity, which has no
  `NSAudioCaptureUsageDescription`, so macOS may grant nothing and the tap
  may deliver **silent all-zero buffers** (a result, not a crash — the probe
  prints `verdict: SILENT` and exits 0).
- If macOS *does* prompt for audio capture, say **Allow** and note it.

### 2. Bundled tap probe (expect: one audio-capture prompt)

```sh
sh research/other-audio/build-bundled-tap-probe.sh --duration=10
```

This builds `TapProbe.app` (`CFBundleIdentifier local.pi-voice.tap-probe`,
with `NSAudioCaptureUsageDescription`) in `/tmp`, ad-hoc codesigns it, and
launches it via `open -W -n`. The app writes stats to a temp file that the
script prints when the app exits (stdout is invisible under `open`).

- **Dialogs to expect:** on first run, a system prompt like
  *"TapProbe would like to capture audio"* (wording varies). Click **Allow**.
  If you click Deny, the probe prints `verdict: SILENT` — re-run to try again.
- If no prompt appears and the verdict is `SIGNAL`, note that too (it means
  the bundle identity alone was sufficient on this macOS version).

### 3. ScreenCaptureKit probe (expect: Screen Recording prompt)

```sh
xcrun swiftc -O research/other-audio/sck-probe.swift -o /tmp/sck-probe
/tmp/sck-probe
```

- **Dialogs to expect:** macOS asks for **Screen & System Audio Recording**
  permission (possibly sending you to System Settings → Privacy & Security).
  Grant it, then **run the probe a second time** — the first run after
  granting often still captures nothing.
- Research reports **50–150 ms latency** for SCK audio; compare with the
  printed `first-buffer-latency` (note: that measures time-to-first-buffer,
  not A/V sync offset).

## What to paste back (per probe)

Paste the **full stdout** of each probe (format line, `first-buffer-latency`
line, the per-second table, and the `verdict:` line), plus:

- [1] what video/source played + volume,
- [2] which dialogs appeared and what you clicked,
- [3] macOS version (`sw_vers -productVersion`) if different from 26.6.2,
- [4] output device (built-in speakers / headphones / external).

Decision rule of thumb: a probe is viable for pi-voice iff it prints
`verdict: SIGNAL` while video plays **and** `verdict: SILENT`/`NEAR-SILENT`
when nothing plays (re-run your winner once with the video paused to check).

## Revoke permissions afterwards

- **Per-app toggles (both probes):** System Settings → Privacy & Security →
  **Screen & System Audio Recording** (SCK probe / terminal) and
  **Audio Capture** / **Microphone** (TapProbe.app — the exact category name
  varies by macOS version; look for `local.pi-voice.tap-probe` or
  "TapProbe") → toggle off, or select and click **−**.
- **Nuclear option (resets ALL capture permissions for the bundle id):**
  ```sh
  tccutil reset AudioCapture local.pi-voice.tap-probe
  tccutil reset ScreenCapture com.apple.Terminal   # only if you want to re-test the prompt
  ```
  (`tccutil reset` without a bundle id resets that service for *everything* —
  avoid that unless you mean it.)
- **Cleanup:** `rm -rf /tmp/TapProbe.app /tmp/tap-probe /tmp/sck-probe`.

## Files

| File | What |
|---|---|
| `tap-probe.swift` | Process-tap probe (bare CLI + bundled binary). Flags: `--duration SEC`, `--stats-file PATH`. |
| `sck-probe.swift` | ScreenCaptureKit audio-only probe. Flag: `--duration SEC`. |
| `build-bundled-tap-probe.sh` | Builds/signs/launches `TapProbe.app`, prints its stats file. |

Claims under test (unverified on this Mac — that's what you're verifying):

1. Process taps (macOS 14.2+ `stereoGlobalTapButExcludeProcesses` +
   private aggregate device) need `kTCCServiceAudioCapture` and give
   all-zero buffers as a bare CLI.
2. The `.app` bundle variant gets a real prompt and real signal.
3. SCK audio-only needs Screen & System Audio Recording, ~50–150 ms latency.
