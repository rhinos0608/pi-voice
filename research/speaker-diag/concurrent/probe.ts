/** Concurrent-capture probe: raw ffmpeg vs voice-io helper running VP on.
 *
 * Conditions (10 s each, ambient room sound only, no playback):
 *  (1) ffmpeg alone (exact args from src/mic.ts, input ":default")
 *  (2) ffmpeg + helper (VP on, AGC off default) concurrently
 *  (3) helper alone (VP on, AGC off default)
 *
 * Per stream: bytes, time since first byte, rate vs 32000 B/s nominal,
 * RMS/peak dBFS, zero-sample fraction, spectral band shares (0-1 / 1-4 / 4-8 kHz).
 * Run: node probe.ts  (from this dir; Node >= 25, no audible output)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { FFMPEG_PATH } from "../../../src/mic.ts";
import { createVoiceIo, ensureVoiceIoHelper } from "../../../src/voice-io.ts";

const SECONDS = 10;
const SAMPLE_RATE = 16000;
const NOMINAL_RATE = SAMPLE_RATE * 2; // 16-bit mono
const INPUT = ":default";

type Capture = {
  buffers: Buffer[];
  times: number[]; // ms, performance.now() at chunk arrival
  stderrTail: string;
  error: string | undefined;
  exit: string | undefined;
};

function ffmpegArgs(): string[] {
  // Exact args from createAvFoundationSource in src/mic.ts.
  return [
    "-hide_banner",
    "-loglevel",
    "error",
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

function captureFfmpeg(ms: number): Promise<Capture> {
  return new Promise((resolve) => {
    const cap: Capture = { buffers: [], times: [], stderrTail: "", error: undefined, exit: undefined };
    let child: ChildProcess;
    try {
      child = spawn(FFMPEG_PATH, ffmpegArgs(), { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      cap.error = `spawn threw: ${(err as Error).message}`;
      resolve(cap);
      return;
    }
    child.stdout?.on("data", (d: Buffer) => {
      cap.buffers.push(Buffer.from(d));
      cap.times.push(performance.now());
    });
    child.stderr?.on("data", (d: Buffer) => {
      cap.stderrTail = `${cap.stderrTail}${d.toString("utf8")}`.slice(-1000);
    });
    child.once("error", (err: Error) => {
      cap.error = `process error: ${err.message}`;
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      cap.exit = `code ${code ?? "?"}, signal ${signal ?? "none"}`;
    });
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
        setTimeout(() => resolve(cap), 300);
      }, 500);
    }, ms);
  });
}

function captureHelper(ms: number): Promise<{ cap: Capture; helperPath: string }> {
  return (async () => {
    const cap: Capture = { buffers: [], times: [], stderrTail: "", error: undefined, exit: undefined };
    const helperPath = await ensureVoiceIoHelper();
    const handle = createVoiceIo({ helperPath, voiceProcessing: true });
    try {
      await handle.source.start(
        (chunk: Buffer) => {
          cap.buffers.push(Buffer.from(chunk));
          cap.times.push(performance.now());
        },
        (err: Error) => {
          cap.error = `helper onError: ${err.name}: ${err.message}`;
        },
      );
      await new Promise((r) => setTimeout(r, ms));
      await handle.source.stop();
    } catch (err) {
      cap.error = `helper start threw: ${(err as Error).message}`;
    } finally {
      await handle.close().catch(() => undefined);
    }
    return { cap, helperPath };
  })();
}

async function captureBoth(ms: number): Promise<{ ff: Capture; helper: Capture; helperPath: string }> {
  const helperPath = await ensureVoiceIoHelper();
  const handle = createVoiceIo({ helperPath, voiceProcessing: true });
  const helper: Capture = { buffers: [], times: [], stderrTail: "", error: undefined, exit: undefined };
  const ffP = captureFfmpeg(ms);
  try {
    await handle.source.start(
      (chunk: Buffer) => {
        helper.buffers.push(Buffer.from(chunk));
        helper.times.push(performance.now());
      },
      (err: Error) => {
        helper.error = `helper onError: ${err.name}: ${err.message}`;
      },
    );
  } catch (err) {
    helper.error = `helper start threw: ${(err as Error).message}`;
  }
  const ff = await ffP;
  await handle.source.stop().catch(() => undefined);
  await handle.close().catch(() => undefined);
  return { ff, helper, helperPath };
}

// --- analysis ---

function hann(n: number, i: number): number {
  return 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
}

/** Iterative radix-2 FFT, real input; returns power per bin 0..n/2. */
function framePower(samples: Float64Array): Float64Array {
  const n = samples.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * hann(n, i);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i]; re[i] = re[j]; re[j] = t;
      const u = im[i]; im[i] = im[j]; im[j] = u;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const power = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

type Stats = {
  bytes: number;
  chunks: number;
  spanSec: number;
  rateBps: number;
  ratePctNominal: number;
  rmsDbfs: number;
  peakDbfs: number;
  zeroFrac: number;
  bandLo: number; // 0-1 kHz share
  bandMid: number; // 1-4 kHz share
  bandHi: number; // 4-8 kHz share
};

function analyze(cap: Capture): Stats {
  const bytes = cap.buffers.reduce((a, b) => a + b.length, 0);
  const chunks = cap.buffers.length;
  const spanSec = cap.times.length >= 2 ? (cap.times[cap.times.length - 1]! - cap.times[0]!) / 1000 : 0;
  const rateBps = spanSec > 0 ? bytes / spanSec : 0;
  const pcm = Buffer.concat(cap.buffers);
  const n = Math.floor(pcm.length / 2);
  let sumSq = 0;
  let peak = 0;
  let zeros = 0;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    if (v === 0) zeros++;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    const f = v / 32768;
    samples[i] = f;
    sumSq += f * f;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
  const peakDbfs = peak > 0 ? 20 * Math.log10(peak / 32768) : Number.NEGATIVE_INFINITY;
  // Band energies over non-overlapping 2048-sample frames.
  const N = 2048;
  let eLo = 0;
  let eMid = 0;
  let eHi = 0;
  const frame = new Float64Array(N);
  for (let off = 0; off + N <= n; off += N) {
    frame.set(samples.subarray(off, off + N));
    const power = framePower(frame);
    const binHz = SAMPLE_RATE / N;
    for (let k = 1; k <= N / 2; k++) {
      const f = k * binHz;
      const p = power[k]!;
      if (f < 1000) eLo += p;
      else if (f < 4000) eMid += p;
      else if (f <= 8000) eHi += p;
    }
  }
  const total = eLo + eMid + eHi;
  return {
    bytes,
    chunks,
    spanSec,
    rateBps,
    ratePctNominal: (100 * rateBps) / NOMINAL_RATE,
    rmsDbfs,
    peakDbfs,
    zeroFrac: n > 0 ? zeros / n : 0,
    bandLo: total > 0 ? eLo / total : 0,
    bandMid: total > 0 ? eMid / total : 0,
    bandHi: total > 0 ? eHi / total : 0,
  };
}

function fmtDb(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : "-inf";
}

function report(name: string, cap: Capture, s: Stats): void {
  console.log(`--- ${name} ---`);
  console.log(`bytes=${s.bytes} chunks=${s.chunks} spanSinceFirst=${s.spanSec.toFixed(2)}s rate=${Math.round(s.rateBps)} B/s (${s.ratePctNominal.toFixed(1)}% of 32000 nominal)`);
  console.log(`rms=${fmtDb(s.rmsDbfs)} dBFS peak=${fmtDb(s.peakDbfs)} dBFS zeroFrac=${(s.zeroFrac * 100).toFixed(2)}%`);
  console.log(`bands 0-1k=${(s.bandLo * 100).toFixed(1)}% 1-4k=${(s.bandMid * 100).toFixed(1)}% 4-8k=${(s.bandHi * 100).toFixed(1)}%`);
  console.log(`error=${cap.error ?? "none"} exit=${cap.exit ?? "n/a"} stderrTail=${cap.stderrTail ? JSON.stringify(cap.stderrTail.slice(-200)) : "empty"}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log(`ffmpeg: ${FFMPEG_PATH}`);
console.log(`conditions: 10 s each, ambient room sound only, input ${INPUT}`);
console.log("=== (1) ffmpeg alone ===");
const c1 = await captureFfmpeg(SECONDS * 1000);
const s1 = analyze(c1);
report("ffmpeg alone", c1, s1);
await sleep(1500);
console.log("=== (2) ffmpeg + helper(VP on) concurrently ===");
const c2 = await captureBoth(SECONDS * 1000);
const s2f = analyze(c2.ff);
const s2h = analyze(c2.helper);
console.log(`helper binary: ${c2.helperPath}`);
report("ffmpeg while helper runs", c2.ff, s2f);
report("helper while ffmpeg runs", c2.helper, s2h);
await sleep(1500);
console.log("=== (3) helper alone ===");
const { cap: c3, helperPath } = await captureHelper(SECONDS * 1000);
const s3 = analyze(c3);
console.log(`helper binary: ${helperPath}`);
report("helper alone", c3, s3);
console.log("=== comparison (1) vs (2) ffmpeg ===");
console.log(`bytes: ${s1.bytes} -> ${s2f.bytes} (ratio ${(s2f.bytes / Math.max(1, s1.bytes)).toFixed(3)})`);
console.log(`rate: ${Math.round(s1.rateBps)} -> ${Math.round(s2f.rateBps)} B/s`);
console.log(`rms: ${fmtDb(s1.rmsDbfs)} -> ${fmtDb(s2f.rmsDbfs)} dBFS (delta ${(s2f.rmsDbfs - s1.rmsDbfs).toFixed(1)} dB)`);
console.log(`bands 0-1k: ${(s1.bandLo * 100).toFixed(1)}% -> ${(s2f.bandLo * 100).toFixed(1)}% | 1-4k: ${(s1.bandMid * 100).toFixed(1)}% -> ${(s2f.bandMid * 100).toFixed(1)}% | 4-8k: ${(s1.bandHi * 100).toFixed(1)}% -> ${(s2f.bandHi * 100).toFixed(1)}%`);
console.log(`helper rate while ffmpeg runs vs alone: ${Math.round(s2h.rateBps)} vs ${Math.round(s3.rateBps)} B/s`);
