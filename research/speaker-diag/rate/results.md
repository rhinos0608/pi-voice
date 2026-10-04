# ffmpeg avfoundation rate probe — results

Probe: `probe.mjs` (this dir). Room sound only, no playback, audio held in
memory (chunk sizes + arrival timestamps only; no samples written to disk).
Nominal rate for 16 kHz mono s16le: **32000 B/s**.

## Method

20 s capture per run, input `:default`. Steady-state rate = bytes received in
the wall-clock window **[firstByte+3 s, firstByte+18 s] / 15 s** — this
excludes startup latency entirely, so it directly tests the "start/stop
accounting artifact" hypothesis. Full-span rate (bytes / time since first
byte, the old 89%-figure method) is reported alongside for comparison.
Tail loss = bytes arriving on stdout after SIGTERM is sent (500 ms SIGKILL
escalation, +400 ms drain). One run per variant uses `-loglevel warning`
(round 1); the rest use `-loglevel error` exactly as in `src/mic.ts`.

Variants (exact args from `createAvFoundationSource` in `src/mic.ts`):

- **(a)** current args: `-hide_banner -loglevel … -fflags nobuffer -probesize 32
  -analyzeduration 0 -f avfoundation -i :default -ac 1 -ar 16000 -f s16le pipe:1`
- **(b)** (a) plus `-thread_queue_size 4096` before `-i`
- **(c)** (a) minus `-fflags nobuffer -probesize 32 -analyzeduration 0`

Runs interleaved (a,b,c × 3 rounds) to control for room drift. 9 fully
attributed runs (3 per variant); a prior full pass the same evening gave the
same picture (steady 86.4–89.9% across all variants).

## Results

| run | variant | loglevel | steady [3–18 s] B/s (% nominal) | full-span B/s (% nominal) | max gap | tail after SIGTERM | first byte | stderr |
|---|---|---|---|---|---|---|---|---|
| 1 | a | warning | 27443 (85.8%) | 27567 (86.1%) | 45 ms | 0 B | 201 ms | empty |
| 2 | b | warning | 27739 (86.7%) | 27919 (87.2%) | 35 ms | 0 B | 224 ms | empty |
| 3 | c | warning | 28058 (87.7%) | 27990 (87.5%) | 44 ms | 0 B | 204 ms | empty |
| 4 | a | error | 28217 (88.2%) | 28329 (88.5%) | 28 ms | 0 B | 249 ms | empty |
| 5 | b | error | 28217 (88.2%) | 28233 (88.2%) | 37 ms | 0 B | 245 ms | empty |
| 6 | c | error | 28080 (87.8%) | 28154 (88.0%) | 46 ms | 0 B | 208 ms | empty |
| 7 | a | error | 28126 (87.9%) | 28048 (87.7%) | 38 ms | 0 B | 268 ms | empty |
| 8 | b | error | 28149 (88.0%) | 28041 (87.6%) | 51 ms | 0 B | 268 ms | empty |
| 9 | c | error | 27511 (86.0%) | 27613 (86.3%) | 33 ms | 0 B | 218 ms | empty |

Variant means (steady): (a) 87.3%, (b) 87.6%, (c) 87.2% — no meaningful
difference. Exit was `code 255` on every run (normal SIGTERM/SIGKILL stop,
not a failure); no spawn/stall/permission errors.

## Verdict: NOT a start/stop accounting artifact — real under-delivery, and none of the variants fix it

1. **The ~88% deficit survives steady-state measurement.** Full-span and
   steady-state rates agree within ~0.3% on every run, and the steady window
   excludes the first 3 s after first byte entirely. If the 89% figure were a
   first-byte-timing or stop-truncation artifact, the [3 s, 18 s] window would
   read ~100%. It reads 85.8–88.2% instead. The accounting-artifact hypothesis
   is rejected.
2. **No variant fixes it.** `-thread_queue_size 4096` (b) and removing the
   low-latency flags (c) both land in the same 86–88% band as current args
   (a). There is no arg-variant evidence for an input-queue-overflow or
   `nobuffer`-induced drop mechanism here.
3. **The loss is silent and smooth, not bursty.** Max inter-chunk gap was
   28–51 ms on every run (chunks flow continuously, ~340–370 B average), yet
   ~1.8 s worth of audio per 15 s window never arrives. No `-loglevel warning`
   output on any variant — no "thread message queue blocking", no timestamp
   discontinuity, no buffer warnings. Whatever discards the bytes does so
   without telling stderr.
4. **No tail loss.** 0 bytes arrived after SIGTERM on all 9 runs: stopping the
   process loses nothing beyond the kill point, so stop truncation cannot
   explain the deficit either.

Practical consequence for the diag numbers: byte-count-derived durations on
the ffmpeg path overstate wall-clock coverage by ~1/0.88 (≈14%) — or,
equivalently, ~12% of wall-clock audio never reaches the pipe. This is
consistent with the earlier observations (ffmpeg 24983–28633 B/s vs helper
32264–32291 B/s in `concurrent/results.md`). Byte counts alone cannot
distinguish dropped frames from a slow delivery clock (pitch/continuity
analysis would be needed), so no `src/` change is proposed — and per
instructions none was made.

## Caveat: concurrent capture (pid 81229)

The owner's Pi session ffmpeg (pid 81229, exact `src/mic.ts` args,
input `:default`) held the same mic during all runs; this probe was therefore
a second concurrent AVFoundation client. Both this probe and the earlier diag
ran alongside it and both show ~88%, while the voice-io helper (a different
capture API) shows ~101% — so the ffmpeg-vs-helper gap persists independent
of that process. It is a raw capture client (no voice processing), so the
VP-attenuation mechanism from `concurrent/results.md` does not apply to it,
but some shared-device contention effect cannot be ruled out from these data.
A clean re-test would need pid 81229 stopped (owner's call — it was not
touched). If that re-test still shows ~88% steady-state, the deficit is
intrinsic to the ffmpeg/AVFoundation path on this machine.
