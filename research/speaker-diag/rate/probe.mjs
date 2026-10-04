/** Rate-artifact probe: does ffmpeg avfoundation really deliver ~88% of 16 kHz mono s16le?
 *
 * Variants (input ":default", 20 s runs, room sound only, audio stays in memory):
 *  (a) exact args from createAvFoundationSource in src/mic.ts
 *  (b) (a) plus `-thread_queue_size 4096` before `-i`
 *  (c) (a) minus `-fflags nobuffer -probesize 32 -analyzeduration 0`
 *
 * Per run: total bytes, full-span rate (bytes / time since first byte, for
 * comparison with the old 89% figure), STEADY-STATE rate = bytes received in
 * [firstByte+3s, firstByte+18s] / 15s, chunk/gap stats, stderr (one run per
 * variant uses -loglevel warning to capture warnings such as thread queue
 * blocking or timestamp discontinuities), and tail bytes flushed after SIGTERM.
 *
 * Run: node probe.mjs  (from this dir; Node >= 25, no audible output)
 */
import { spawn } from "node:child_process";

const FFMPEG_PATH = "/opt/miniconda3/bin/ffmpeg";
const INPUT = ":default";
const NOMINAL = 32000; // 16 kHz mono s16le B/s
const RUN_MS = 20000;
const WIN_START_S = 3;
const WIN_END_S = 18;

function baseArgs(loglevel) {
  return [
    "-hide_banner",
    "-loglevel",
    loglevel,
    "-fflags",
    "nobuffer",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-f",
    "avfoundation",
    "-i",
    INPUT,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ];
}

function argsFor(variant, loglevel) {
  if (variant === "a") return baseArgs(loglevel);
  if (variant === "b") {
    const a = baseArgs(loglevel);
    const i = a.indexOf("-i");
    a.splice(i, 0, "-thread_queue_size", "4096");
    return a;
  }
  if (variant === "c") {
    // Same as (a) without -fflags nobuffer -probesize 32 -analyzeduration 0.
    return [
      "-hide_banner",
      "-loglevel",
      loglevel,
      "-f",
      "avfoundation",
      "-i",
      INPUT,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ];
  }
  throw new Error(`unknown variant ${variant}`);
}

function runOnce(variant, loglevel) {
  return new Promise((resolve) => {
    const args = argsFor(variant, loglevel);
    const events = []; // { t: ms since spawn, n: bytes }
    let stderr = "";
    let firstByteAt = -1;
    let sigtermAt = -1;
    let tailBytes = 0;
    let error;
    let exit;
    const t0 = performance.now();
    const child = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d) => {
      const now = performance.now();
      if (firstByteAt < 0) firstByteAt = now;
      events.push({ t: now - t0, n: d.length });
      if (sigtermAt > 0 && now >= sigtermAt) tailBytes += d.length;
    });
    child.stderr?.on("data", (d) => {
      stderr = `${stderr}${d.toString("utf8")}`.slice(-8000);
    });
    child.once("error", (err) => {
      error = `process error: ${err.message}`;
    });
    child.once("exit", (code, signal) => {
      exit = `code ${code ?? "?"}, signal ${signal ?? "none"}`;
    });
    setTimeout(() => {
      sigtermAt = performance.now();
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        setTimeout(() => {
          const totalBytes = events.reduce((a, e) => a + e.n, 0);
          let steadyBytes = 0;
          let spanSec = 0;
          let steadyRate = 0;
          let maxGapMs = 0;
          let chunks = events.length;
          if (firstByteAt >= 0) {
            const fb = firstByteAt - t0;
            const lo = fb + WIN_START_S * 1000;
            const hi = fb + WIN_END_S * 1000;
            for (const e of events) {
              if (e.t >= lo && e.t < hi) steadyBytes += e.n;
            }
            steadyRate = steadyBytes / (WIN_END_S - WIN_START_S);
            const lastT = events.length > 0 ? events[events.length - 1].t : fb;
            spanSec = (Math.min(lastT, sigtermAt - t0) - fb) / 1000;
            let prev = fb;
            for (const e of events) {
              const gap = e.t - prev;
              if (gap > maxGapMs) maxGapMs = gap;
              prev = e.t;
            }
          } else {
            chunks = 0;
          }
          const fullRate = spanSec > 0 ? totalBytes / spanSec : 0;
          resolve({
            variant,
            loglevel,
            totalBytes,
            chunks,
            spanSec,
            fullRate,
            fullPct: (100 * fullRate) / NOMINAL,
            steadyBytes,
            steadyRate,
            steadyPct: (100 * steadyRate) / NOMINAL,
            maxGapMs,
            tailBytes,
            firstByteLatencyMs: firstByteAt >= 0 ? firstByteAt - t0 : -1,
            error,
            exit,
            stderr,
          });
        }, 400);
      }, 500);
    }, RUN_MS);
  });
}

function fmt(r) {
  return (
    `variant=${r.variant} loglevel=${r.loglevel} ` +
    `total=${r.totalBytes}B chunks=${r.chunks} span=${r.spanSec.toFixed(2)}s ` +
    `full=${Math.round(r.fullRate)}B/s(${r.fullPct.toFixed(1)}%) ` +
    `STEADY[${WIN_START_S}-${WIN_END_S}s]=${Math.round(r.steadyRate)}B/s(${r.steadyPct.toFixed(1)}%) ` +
    `maxGap=${Math.round(r.maxGapMs)}ms tailAfterSIGTERM=${r.tailBytes}B ` +
    `firstByte=${Math.round(r.firstByteLatencyMs)}ms ` +
    `error=${r.error ?? "none"} exit=${r.exit ?? "n/a"}`
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Interleaved rounds to control for room drift. Round 1 uses -loglevel
// warning on every variant (covers the stderr-warning requirement); rounds
// 2-3 use -loglevel error like src/mic.ts.
const planFilter = process.argv[2]; // e.g. "warning" to run only warning-level runs
const plan = [
  ["a", "warning"],
  ["b", "warning"],
  ["c", "warning"],
  ["a", "error"],
  ["b", "error"],
  ["c", "error"],
  ["a", "error"],
  ["b", "error"],
  ["c", "error"],
].filter(([variant, loglevel]) => !planFilter || loglevel === planFilter || variant === planFilter);

const results = [];
for (const [variant, loglevel] of plan) {
  console.log(`=== variant ${variant} (loglevel ${loglevel}) — 20 s ===`);
  const r = await runOnce(variant, loglevel);
  console.log(fmt(r));
  if (r.stderr.trim()) {
    console.log(`--- stderr (variant ${variant}, ${loglevel}) ---`);
    console.log(r.stderr.trim().slice(-2000));
  } else {
    console.log(`--- stderr (variant ${variant}, ${loglevel}): empty ---`);
  }
  results.push(r);
  await sleep(1500);
}

console.log("=== SUMMARY (steady-state = bytes in [first+3s, first+18s] / 15s) ===");
for (const r of results) console.log(fmt(r));
console.log(JSON.stringify(results, null, 1));
