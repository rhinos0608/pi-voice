// Speaker capture-path diagnostic.
// Run from the repo root: `node research/speaker-diag/diag.mjs` (interactive)
// or `node research/speaker-diag/diag.mjs --self-test` (no microphone needed).
//
// Compares six capture paths (A: helper VP on, AGC off; B: helper VP on +
// AGC on; C: helper VP on + bypass = raw mic, no processing; D: ffmpeg
// AVFoundation raw; E: ffmpeg raw recorded WHILE the helper runs with VP on,
// helper started first and kept running with its PCM discarded = planned
// production setup for speaker verification; F: ffmpeg raw WHILE a bypass
// helper holds the device (VP-on helper restarted with --bypass on for the
// recording, since the helper has no runtime bypass toggle; restart latency
// is printed) = control for whether concurrent-capture attenuation comes
// from VP DSP or merely from the helper holding the device) on the SAME 4
// spoken phrases
// (longer phrases, >= 3 s each, matching the enrollment style in
// src/commands.ts), using the same metrics + CAM++ embedding pipeline for
// each clip. Audio stays in memory; nothing is written to disk (except the
// --self-test's temp `say` files, which are deleted immediately after
// conversion).
//
// Interactive subset: --paths E,F,D (default E,F,D to keep the session short).
//
// Plain JavaScript on purpose: Node type-strips imported .ts files, but the
// .mjs entry point itself must parse as JS.

import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createEndpointer } from "../../src/vad.ts";
import { FFMPEG_PATH } from "../../src/mic.ts";
import { speakerModelCachedPath, vadModelPath } from "../../src/model.ts";
import {
  cosineSimilarity,
  createSpeakerEmbedder,
  loadSpeakerProfile,
  scoreSample,
} from "../../src/speaker.ts";
import { createVoiceIo, ensureVoiceIoHelper } from "../../src/voice-io.ts";

const SR = 16000;
const BYTES_PER_SEC = SR * 2;
const MAX_SEC = 6;
const FIRST_SPEECH_SEC = 1.2;
const GATE_WINDOW_SEC = 2.5;
const ENROLL_WINDOW_SEC = 4;

const PHRASES = [
  // First 4 ENROLL_PHRASES from src/commands.ts: longer natural sentences,
  // each yielding >= 3 s of VAD speech when read aloud at a normal pace.
  "The quick brown fox jumps over the lazy dog while the river flows quietly behind the old wooden fence",
  "Pack my box with five dozen liquor jugs before the delivery truck leaves the warehouse this afternoon",
  "She sells seashells by the seashore every sunny morning while the waves crash against the rocks",
  "The five boxing wizards jump quickly across the stage as the excited crowd cheers loudly for more",
];

const require = createRequire(import.meta.url);
function loadSherpa() {
  try {
    return require("sherpa-onnx-node");
  } catch (err) {
    throw new Error(`cannot load sherpa-onnx-node: ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- metrics

function pcmToFloat(pcm) {
  const n = Math.floor(pcm.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

function floatToPcm(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

function energyVadSegments(samples) {
  // Frame-level energy VAD used only when the Silero model file is absent.
  const frame = 320; // 20 ms
  const thresh = Math.pow(10, -40 / 20);
  const speech = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    speech.push(Math.sqrt(sum / (end - i)) > thresh);
  }
  const segments = [];
  let runStart;
  let silenceRun = 0;
  for (let f = 0; f <= speech.length; f++) {
    const s = f < speech.length ? speech[f] : false;
    if (s) {
      if (runStart === undefined) runStart = f;
      silenceRun = 0;
    } else if (runStart !== undefined) {
      silenceRun++;
      if (silenceRun >= 10 || f === speech.length) {
        // Merge gaps < 200 ms; keep runs >= 250 ms.
        const runEnd = f === speech.length ? f : f - silenceRun;
        const durMs = ((runEnd - runStart) * frame * 1000) / SR;
        if (durMs >= 250) {
          const start = runStart * frame;
          segments.push({ start, samples: samples.slice(start, runEnd * frame) });
        }
        runStart = undefined;
        silenceRun = 0;
      }
    }
  }
  return { segments, fallback: true };
}

function sileroVadSegments(samples, model) {
  const { Vad } = loadSherpa();
  const vad = new Vad(
    {
      sileroVad: {
        model,
        threshold: 0.5,
        minSilenceDuration: 0.8,
        minSpeechDuration: 0.25,
        windowSize: 512,
        maxSpeechDuration: 30,
      },
      sampleRate: SR,
      numThreads: 1,
      provider: "cpu",
    },
    60,
  );
  // Feed in exact 512-sample windows like createEndpointer in src/vad.ts:
  // a single bulk acceptWaveform() mis-segments (reports only a trailing
  // fragment), while chunked feeding reports full speech spans.
  for (let i = 0; i + 512 <= samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, i + 512));
  }
  const tail = samples.length % 512;
  if (tail >= 64) {
    const padded = new Float32Array(512);
    padded.set(samples.subarray(samples.length - tail));
    vad.acceptWaveform(padded);
  }
  vad.flush();
  const segments = [];
  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    segments.push({ start: seg.start, samples: seg.samples.slice() });
  }
  return segments;
}

function vadModelIfPresent() {
  try {
    const model = vadModelPath();
    statSync(model);
    return model;
  } catch {
    return undefined; // missing model: caller falls back to the energy VAD
  }
}

export function measureClip(pcm, wallMs) {
  const even = pcm.length % 2 === 1 ? pcm.subarray(0, pcm.length - 1) : pcm;
  const n = Math.floor(even.length / 2);
  let peak = 0;
  let sum = 0;
  let sumSq = 0;
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    const s = even.readInt16LE(i * 2);
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 32760) clipped++;
    sum += s;
    sumSq += s * s;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms / 32768) : Number.NEGATIVE_INFINITY;
  const peakDb = peak > 0 ? 20 * Math.log10(peak / 32768) : Number.NEGATIVE_INFINITY;

  const samples = pcmToFloat(even);
  const model = vadModelIfPresent();
  let segments;
  let vadFallback = false;
  if (model) {
    segments = sileroVadSegments(samples, model);
  } else {
    segments = energyVadSegments(samples).segments;
    vadFallback = true;
  }
  const vadSpeechMs = segments.reduce((a, s) => a + (s.samples.length * 1000) / SR, 0);
  const totalSpeechSamples = segments.reduce((a, s) => a + s.samples.length, 0);
  const speechFloat = new Float32Array(totalSpeechSamples);
  let off = 0;
  for (const s of segments) {
    speechFloat.set(s.samples, off);
    off += s.samples.length;
  }
  return {
    metrics: {
      bytes: even.length,
      audioSec: even.length / BYTES_PER_SEC,
      wallSec: wallMs / 1000,
      rmsDb,
      peakDb,
      clipPct: n > 0 ? (clipped / n) * 100 : 0,
      dcOffset: n > 0 ? sum / n / 32768 : 0,
      vadSpeechMs,
      vadFallback,
    },
    speechPcm: floatToPcm(speechFloat),
  };
}

export function firstSpeechWindow(speechPcm, sec = FIRST_SPEECH_SEC) {
  const want = Math.floor(sec * BYTES_PER_SEC);
  if (speechPcm.length <= want) return speechPcm;
  const cut = want - (want % 2);
  return speechPcm.subarray(0, cut);
}

// ---------------------------------------------------------------- embeddings

export function loadEmbedder() {
  const model = speakerModelCachedPath();
  if (!model) return undefined;
  return createSpeakerEmbedder(model);
}

export function tryEmbed(embedder, pcm) {
  if (!embedder || pcm.length < SR * 2 * 0.3) return undefined; // < 300 ms: extractor has nothing to work with
  try {
    return embedder.embed(pcm);
  } catch {
    return undefined; // too short / silence: no embedding available
  }
}

export function pairwiseStats(vecs) {
  let sum = 0;
  let min = Infinity;
  let n = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const a = vecs[i];
      const b = vecs[j];
      if (!a || !b) continue;
      const c = cosineSimilarity(a, b);
      sum += c;
      if (c < min) min = c;
      n++;
    }
  }
  return { mean: n > 0 ? sum / n : NaN, min: n > 0 ? min : NaN, n };
}

export function sanityPct(audioSec, wallSec) {
  if (!(audioSec > 0) || !(wallSec > 0)) return 0;
  return (audioSec / wallSec) * 100;
}

export function isSampleRateSuspicious(pct) {
  return pct < 95 || pct > 105;
}

function fmtCos(v) {
  return Number.isNaN(v) ? "  n/a" : v.toFixed(2).padStart(5);
}

export function printMatrix(title, vecs, labels) {
  console.log(`  ${title}`);
  console.log("       " + labels.map((l) => l.padStart(5)).join(" "));
  for (let i = 0; i < vecs.length; i++) {
    const cells = [];
    for (let j = 0; j < vecs.length; j++) {
      if (i === j) cells.push(" 1.00");
      else if (!vecs[i] || !vecs[j]) cells.push("  n/a");
      else cells.push(cosineSimilarity(vecs[i], vecs[j]).toFixed(2).padStart(5));
    }
    console.log(`${labels[i].padEnd(6)} ${cells.join(" ")}`);
  }
  const st = pairwiseStats(vecs);
  console.log(`  mean=${fmtCos(st.mean).trim()} min=${fmtCos(st.min).trim()} (n=${st.n})`);
}

// ---------------------------------------------------------------- analysis pipeline (shared by both modes)

function dbStr(v) {
  return Number.isFinite(v) ? `${v.toFixed(1)}dB` : "-inf";
}

export async function analyzePath(name, clips, embedder) {
  const profile = await loadSpeakerProfile();
  const results = [];
  for (const clip of clips) {
    const { metrics, speechPcm } = measureClip(clip.pcm, clip.wallMs);
    const r = { phrase: clip.phrase, metrics };
    const embFull = tryEmbed(embedder, clip.pcm);
    const embSpeech = tryEmbed(embedder, speechPcm);
    const embHead = tryEmbed(embedder, firstSpeechWindow(speechPcm));
    const embHead25 = tryEmbed(embedder, firstSpeechWindow(speechPcm, GATE_WINDOW_SEC));
    const embHead40 = tryEmbed(embedder, firstSpeechWindow(speechPcm, ENROLL_WINDOW_SEC));
    if (embFull) r.embFull = embFull;
    if (embSpeech) r.embSpeech = embSpeech;
    if (embHead) r.embHead = embHead;
    if (embHead25) r.embHead25 = embHead25;
    if (embHead40) r.embHead40 = embHead40;
    if (profile && embFull) r.scoreFull = scoreSample(profile, embFull);
    if (profile && embSpeech) r.scoreSpeech = scoreSample(profile, embSpeech);
    if (profile && embHead25) r.scoreHead25 = scoreSample(profile, embHead25);
    if (profile && embHead40) r.scoreHead40 = scoreSample(profile, embHead40);
    results.push(r);
  }

  console.log(`\n### Path ${name}`);
  for (const r of results) {
    const m = r.metrics;
    const sanity = sanityPct(m.audioSec, m.wallSec);
    const flag = isSampleRateSuspicious(sanity) ? "  <-- SAMPLE-RATE MISMATCH?" : "";
    console.log(
      ` phrase ${r.phrase}: bytes=${m.bytes} (=${m.audioSec.toFixed(2)}s @16k) vs wall=${m.wallSec.toFixed(2)}s (${sanity.toFixed(0)}%)${flag}`,
    );
    const gateScores = `score=${r.scoreFull !== undefined ? r.scoreFull.toFixed(3) : "n/a"} score-2.5s=${r.scoreHead25 !== undefined ? r.scoreHead25.toFixed(3) : "n/a"} score-4s=${r.scoreHead40 !== undefined ? r.scoreHead40.toFixed(3) : "n/a"}`;
    console.log(
      `   rms=${dbStr(m.rmsDb)} peak=${dbStr(m.peakDb)} clip=${m.clipPct.toFixed(2)}% dc=${m.dcOffset.toFixed(4)} vad=${Math.round(m.vadSpeechMs)}ms${m.vadFallback ? " (energy fallback)" : ""} ${gateScores}`,
    );
  }
  const labels = results.map((r) => `p${r.phrase}`);
  printMatrix("full-clip cosines:", results.map((r) => r.embFull), labels);
  printMatrix("speech-only cosines:", results.map((r) => r.embSpeech), labels);
  printMatrix("first-1.2s cosines:", results.map((r) => r.embHead), labels);
  printMatrix("first-2.5s cosines:", results.map((r) => r.embHead25), labels);
  printMatrix("first-4s cosines:", results.map((r) => r.embHead40), labels);
  return { results, profileThreshold: profile?.suggestedThreshold };
}

// ---------------------------------------------------------------- capture

async function captureTimed(startFn, stopFn, maxSec) {
  const chunks = [];
  let captureError;
  let firstByteAt = 0; // wall clock runs first received byte -> stop
  let speechStarted = false;
  let speechEnded = false;
  let ep;
  const model = vadModelIfPresent();
  if (model) {
    ep = createEndpointer(
      model,
      {
        onSpeechStart: () => {
          speechStarted = true;
        },
        onSpeechEnd: () => {
          if (speechStarted) speechEnded = true;
        },
      },
      { minSilenceSec: 0.8 },
    );
  }
  // No VAD model: fixed-duration capture (no early speech-end stop).
  const t0 = Date.now();
  await startFn(
    (chunk) => {
      if (!firstByteAt) firstByteAt = Date.now();
      chunks.push(chunk);
      try {
        if (ep) ep.push(chunk);
      } catch {
        // Metering must never break capture.
      }
    },
    (err) => {
      captureError = err;
    },
  );
  while (!captureError && Date.now() - t0 < maxSec * 1000) {
    if (ep && speechStarted && speechEnded) break;
    await sleep(100);
  }
  const tEnd = Date.now();
  const wallMs = firstByteAt ? tEnd - firstByteAt : tEnd - t0;
  try {
    await stopFn();
  } finally {
    if (ep) ep.close();
  }
  if (captureError) throw captureError;
  return { pcm: Buffer.concat(chunks), wallMs };
}

async function recordHelperClip(opts = {}) {
  const helperPath = await ensureVoiceIoHelper();
  const handle = createVoiceIo({
    helperPath,
    voiceProcessing: opts.voiceProcessing ?? true,
    ...(opts.agc === true ? { agc: true } : {}),
    ...(opts.bypass === true ? { bypass: true } : {}),
  });
  try {
    return await captureTimed(
      (onPcm, onError) => handle.source.start(onPcm, onError),
      () => handle.source.stop(),
      MAX_SEC,
    );
  } finally {
    await handle.close();
  }
}

function ffmpegPath() {
  try {
    statSync(FFMPEG_PATH);
    return FFMPEG_PATH;
  } catch {
    return "ffmpeg"; // fall back to PATH when the pinned binary is absent
  }
}

// Same ffmpeg arguments as createAvFoundationSource in src/mic.ts.
function ffmpegCaptureArgs() {
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
    ":default",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-f",
    "s16le",
    "pipe:1",
  ];
}

async function recordFfmpegWhileHelperRunning() {
  // Planned production setup for speaker verification: the helper holds the
  // mic path open with VP on (as during wake/STT) while ffmpeg captures raw
  // audio concurrently. The helper's processed PCM is discarded.
  const helperPath = await ensureVoiceIoHelper();
  const handle = createVoiceIo({ helperPath, voiceProcessing: true });
  let helperError;
  await handle.source.start(
    () => {},
    (err) => {
      helperError = err;
    },
  );
  try {
    if (helperError) throw helperError;
    const clip = await recordFfmpegClip();
    if (helperError) throw helperError;
    return clip;
  } finally {
    try {
      await handle.source.stop();
    } finally {
      await handle.close();
    }
  }
}

async function recordFfmpegWithBypassHelper() {
  // Control for E: the helper holds the device with VP DSP bypassed while
  // ffmpeg captures concurrently. The helper has no runtime bypass toggle
  // (stdin protocol is PLAY/FINISH/STOP/QUIT only), so the VP-on helper is
  // restarted with --bypass on for the recording and stopped at record end.
  // F vs E isolates VP DSP from device-hold; F vs D isolates bypass-hold.
  const tStart = Date.now();
  const helperPath = await ensureVoiceIoHelper();
  const handle = createVoiceIo({ helperPath, voiceProcessing: true, bypass: true });
  let helperError;
  await handle.source.start(
    () => {},
    (err) => {
      helperError = err;
    },
  );
  console.log(`Bypass helper ready in ${((Date.now() - tStart) / 1000).toFixed(2)} s (restart latency).`);
  try {
    if (helperError) throw helperError;
    const clip = await recordFfmpegClip();
    if (helperError) throw helperError;
    return clip;
  } finally {
    try {
      await handle.source.stop();
    } finally {
      await handle.close();
    }
  }
}

async function recordFfmpegClip() {
  const proc = spawn(ffmpegPath(), ffmpegCaptureArgs(), { stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  if (proc.stderr) {
    proc.stderr.on("data", (d) => {
      stderrTail = `${stderrTail}${d.toString("utf8")}`.slice(-2000);
    });
  }
  const stopProc = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      proc.once("exit", finish);
      try {
        proc.kill("SIGTERM");
      } catch {
        finish();
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone; finish below still releases the waiter.
        }
        setTimeout(finish, 100);
      }, 500);
    });
  try {
    return await captureTimed(
      async (onPcm, onError) => {
        if (proc.stdout) proc.stdout.on("data", (d) => onPcm(Buffer.from(d)));
        proc.once("error", (e) => onError(e));
        proc.once("exit", (code, sig) => {
          if (code !== 0 && code !== null)
            onError(new Error(`ffmpeg exited (code ${code}, signal ${sig ?? "none"}): ${stderrTail.slice(-300)}`));
        });
        await sleep(300); // let the process fail fast on a bad device before timing starts
        if (proc.exitCode !== null && proc.exitCode !== 0)
          throw new Error(`ffmpeg failed to start (code ${proc.exitCode}): ${stderrTail.slice(-300)}`);
      },
      async () => {
        if (proc.stdout) proc.stdout.removeAllListeners();
        proc.removeAllListeners();
        await stopProc();
      },
      MAX_SEC,
    );
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Best effort: the process already exited on its own.
    }
  }
}

// ---------------------------------------------------------------- interactive mode

function waitEnter(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

const ALL_PATHS = [
  { key: "A", label: "helper VP on (AGC off, production default)", record: () => recordHelperClip({ voiceProcessing: true }) },
  { key: "B", label: "helper VP on + AGC on", record: () => recordHelperClip({ voiceProcessing: true, agc: true }) },
  { key: "C", label: "helper VP on + bypass (raw mic, no processing)", record: () => recordHelperClip({ voiceProcessing: true, bypass: true }) },
  { key: "D", label: "ffmpeg raw", record: () => recordFfmpegClip() },
  {
    key: "E",
    label: "ffmpeg raw WHILE helper VP-on running (planned prod setup)",
    record: () => recordFfmpegWhileHelperRunning(),
  },
  {
    key: "F",
    label: "ffmpeg raw WHILE bypass helper running (restart w/ --bypass)",
    record: () => recordFfmpegWithBypassHelper(),
  },
];

const DEFAULT_PATH_KEYS = ["E", "F", "D"];

export function parsePathsArg(argv) {
  const arg = argv.find((a) => a.startsWith("--paths"));
  if (!arg) return [...DEFAULT_PATH_KEYS];
  const eq = arg.indexOf("=");
  const raw = (eq >= 0 ? arg.slice(eq + 1) : argv[argv.indexOf(arg) + 1] ?? "").toUpperCase();
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = keys.filter((k) => ALL_PATHS.some((p) => p.key === k));
  if (valid.length === 0) throw new Error(`--paths must name a subset of A,B,C,D,E,F (got "${raw}")`);
  return [...new Set(valid)];
}

async function interactive(selectedKeys) {
  const embedder = loadEmbedder();
  if (!embedder) {
    console.error("Speaker model not cached; cannot compute embeddings. Run /voice setup first.");
    return 1;
  }
  const profile = await loadSpeakerProfile();
  console.log(`Enrolled profile: ${profile ? `yes (threshold ${profile.suggestedThreshold})` : "none — scores vs profile will show n/a"}`);
  const paths = ALL_PATHS.filter((p) => selectedKeys.includes(p.key));

  const byPath = new Map();
  for (const path of paths) {
    console.log(`\n=== Path ${path.key}: ${path.label} ===`);
    const clips = [];
    for (let i = 0; i < PHRASES.length; i++) {
      console.log(`\nSay this (${i + 1}/${PHRASES.length}):`);
      console.log(`  "${PHRASES[i]}"`);
      await waitEnter("Press Enter to start recording (~5 s, stops on silence or 6 s)... ");
      console.log("Recording... speak now.");
      try {
        const clip = await path.record();
        console.log(`Got ${clip.pcm.length} bytes in ${(clip.wallMs / 1000).toFixed(2)} s.`);
        clips.push({ pcm: clip.pcm, wallMs: clip.wallMs, phrase: i + 1 });
      } catch (err) {
        console.error(`Capture failed: ${err.message}`);
        return 1;
      }
    }
    const { results } = await analyzePath(`${path.key} (${path.label})`, clips, embedder);
    byPath.set(path.key, results);
  }

  printCrossPath(byPath);
  printSummary(byPath);
  printCopyPasteBlock(byPath);
  return 0;
}

function crossPathSpeechValues(byPath, kx, ky) {
  const x = byPath.get(kx);
  const y = byPath.get(ky);
  if (!x || !y) return [];
  const vals = [];
  for (let p = 1; p <= PHRASES.length; p++) {
    const ra = x.find((r) => r.phrase === p);
    const rb = y.find((r) => r.phrase === p);
    if (ra?.embSpeech && rb?.embSpeech) vals.push(cosineSimilarity(ra.embSpeech, rb.embSpeech));
  }
  return vals;
}

function printCrossPath(byPath) {
  const keys = [...byPath.keys()];
  if (keys.length < 2) return;
  console.log("\n### Cross-path cosines (same phrase, speech-only embeddings)");
  console.log("A vs C isolates Apple processing; C vs D isolates helper vs ffmpeg; E vs D isolates running the helper alongside ffmpeg; F vs E isolates VP DSP from device-hold; F vs D isolates bypass-hold.");
  for (let p = 1; p <= PHRASES.length; p++) {
    const cells = [];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const ra = byPath.get(keys[i]).find((r) => r.phrase === p);
        const rb = byPath.get(keys[j]).find((r) => r.phrase === p);
        const v = ra?.embSpeech && rb?.embSpeech ? cosineSimilarity(ra.embSpeech, rb.embSpeech).toFixed(2) : "n/a";
        cells.push(`${keys[i]}-${keys[j]}=${v}`);
      }
    }
    console.log(` phrase ${p}: ${cells.join("  ")}`);
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const vals = crossPathSpeechValues(byPath, keys[i], keys[j]);
      const mean = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
      console.log(` mean ${keys[i]} vs ${keys[j]}: ${Number.isNaN(mean) ? "n/a" : mean.toFixed(3)} (n=${vals.length})`);
    }
  }
}

function printSummary(byPath) {
  console.log("\n### Summary per path (speech-only within-path cosine)");
  console.log("path  within-cos  within-min  mean-score  mean-rms");
  let bestKey = "";
  let bestMean = -Infinity;
  for (const [key, results] of byPath) {
    const st = pairwiseStats(results.map((r) => r.embSpeech));
    const scored = results.map((r) => r.scoreSpeech).filter((s) => s !== undefined);
    const meanScore = scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : NaN;
    const finiteRms = results.map((r) => r.metrics.rmsDb).filter((v) => Number.isFinite(v));
    const meanRms = finiteRms.length > 0 ? finiteRms.reduce((a, b) => a + b, 0) / finiteRms.length : NaN;
    console.log(
      `${key.padEnd(5)} ${fmtCos(st.mean).trim().padStart(10)} ${fmtCos(st.min).trim().padStart(10)} ${(Number.isNaN(meanScore) ? "n/a" : meanScore.toFixed(3)).padStart(10)} ${(Number.isNaN(meanRms) ? "-inf" : meanRms.toFixed(1) + "dB").padStart(9)}`,
    );
    if (!Number.isNaN(st.mean) && st.mean > bestMean) {
      bestMean = st.mean;
      bestKey = key;
    }
  }
  let verdict;
  if (!bestKey) {
    verdict = "VERDICT: no usable embeddings on any path — check capture levels first.";
  } else {
    verdict = `VERDICT: path ${bestKey} is the most self-consistent (highest mean speech-only within-path cosine). Prefer it for enrollment/verification.`;
  }
  console.log(verdict);
  return { verdict };
}

function printCopyPasteBlock(byPath) {
  // One self-contained numbers-only block for pasting into chat: no audio,
  // no secrets, no profile contents.
  const keys = [...byPath.keys()];
  const lines = [];
  lines.push("speaker-diag summary");
  for (const [key, results] of byPath) {
    const st = pairwiseStats(results.map((r) => r.embSpeech));
    const mean = Number.isNaN(st.mean) ? "n/a" : st.mean.toFixed(3);
    const min = Number.isNaN(st.min) ? "n/a" : st.min.toFixed(3);
    const finiteRms = results.map((r) => r.metrics.rmsDb).filter((v) => Number.isFinite(v));
    const meanRms = finiteRms.length > 0 ? (finiteRms.reduce((a, b) => a + b, 0) / finiteRms.length).toFixed(1) + "dB" : "n/a";
    lines.push(`within-speech ${key}: mean=${mean} min=${min} n=${st.n} mean-rms=${meanRms}`);
  }
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const vals = crossPathSpeechValues(byPath, keys[i], keys[j]);
      const per = vals.map((v) => v.toFixed(3)).join(",");
      const mean = vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : "n/a";
      lines.push(`cross-speech ${keys[i]}-${keys[j]}: per-phrase=[${per}] mean=${mean}`);
    }
  }
  console.log("\n===== COPY-PASTE SUMMARY BEGIN =====");
  for (const line of lines) console.log(line);
  console.log("===== COPY-PASTE SUMMARY END =====");
}

// ---------------------------------------------------------------- self-test mode (no human, no microphone)

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr: String(stderr ?? "") });
    });
  });
}

async function synthPhrase(phrase) {
  // `say -o` writes a file without audible playback; ffmpeg converts to
  // 16 kHz mono s16le in memory. The temp file is deleted right after.
  const tmp = join(tmpdir(), `speaker-diag-${process.pid}-${Math.floor(Math.random() * 1e9)}.aiff`);
  try {
    await runCmd("say", ["-v", "Samantha", "-o", tmp, phrase]);
    const converted = await new Promise((resolve, reject) => {
      const proc = spawn(
        ffmpegPath(),
        ["-hide_banner", "-loglevel", "error", "-i", tmp, "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks = [];
      let errTail = "";
      if (proc.stdout) proc.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
      if (proc.stderr) proc.stderr.on("data", (d) => (errTail += d.toString("utf8")));
      proc.once("error", reject);
      proc.once("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg convert failed (code ${code}): ${errTail.slice(-300)}`));
      });
    });
    return converted;
  } finally {
    // Best effort: the temp file may already be gone.
    await unlink(tmp).catch(() => undefined);
  }
}

async function selfTest() {
  console.log("SELF-TEST: synthesizing 4 phrases with `say` (no microphone, no playback).");
  const rateChecks = [
    { pct: 94, want: true },
    { pct: 100, want: false },
    { pct: 106, want: true },
  ];
  for (const { pct, want } of rateChecks) {
    if (isSampleRateSuspicious(pct) !== want) {
      console.error(`SELF-TEST FAIL: isSampleRateSuspicious(${pct}) should be ${want}.`);
      return 1;
    }
  }
  console.log("self-test rate-flag bounds: 94%=flagged 100%=ok 106%=flagged");
  const embedder = loadEmbedder();
  if (!embedder) {
    console.error("SELF-TEST FAIL: speaker model not cached; embedding pipeline cannot be verified.");
    return 1;
  }
  const clips = [];
  for (let i = 0; i < PHRASES.length; i++) {
    let pcm;
    try {
      pcm = await synthPhrase(PHRASES[i]);
    } catch (err) {
      console.error(`SELF-TEST FAIL: cannot synthesize phrase ${i + 1}: ${err.message}`);
      return 1;
    }
    if (pcm.length === 0) {
      console.error(`SELF-TEST FAIL: phrase ${i + 1} converted to 0 bytes.`);
      return 1;
    }
    // Wall time is meaningless for synthesis; use the byte duration so the
    // sanity ratio prints 100% and only the metric math is exercised.
    clips.push({ pcm, wallMs: (pcm.length / BYTES_PER_SEC) * 1000, phrase: i + 1 });
  }
  const { results } = await analyzePath("SELF-TEST (synthetic Samantha)", clips, embedder);
  const byPath = new Map([["S", results]]);
  const st = pairwiseStats(results.map((r) => r.embSpeech));
  const missingEmb = results.filter((r) => !r.embSpeech).length;
  const silent = results.filter((r) => !Number.isFinite(r.metrics.rmsDb)).length;
  const missing25 = results.filter((r) => !r.embHead25).length;
  const missing40 = results.filter((r) => !r.embHead40).length;
  const pathKeys = new Set(ALL_PATHS.map((p) => p.key));
  const pathsWired = ["D", "E", "F"].every((k) => pathKeys.has(k)) &&
    ALL_PATHS.every((p) => typeof p.record === "function");
  console.log(`self-test paths wired: D,E,F present=${pathKeys.has("D") && pathKeys.has("E") && pathKeys.has("F")}`);
  console.log(`\nself-test checks: embeddings missing=${missingEmb}/4 silent=${silent}/4 win-2.5s missing=${missing25}/4 win-4s missing=${missing40}/4 within-mean=${fmtCos(st.mean).trim()}`);
  if (missingEmb > 0 || silent > 0 || missing25 > 0 || missing40 > 0 || !pathsWired) {
    console.error("SELF-TEST FAIL: pipeline produced no embedding or silence on synthetic speech.");
    return 1;
  }
  printSummary(byPath);
  printCopyPasteBlock(byPath);
  console.log("SELF-TEST PASS");
  return 0;
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage:");
  console.log("  node research/speaker-diag/diag.mjs [--paths E,F,D] interactive (needs the owner + microphone)");
  console.log("  node research/speaker-diag/diag.mjs --self-test non-interactive pipeline check via `say`");
  console.log("Paths: A=helper VP on, AGC off; B=helper VP on+AGC on; C=helper VP on+bypass (raw mic);");
  console.log("       D=ffmpeg raw; E=ffmpeg raw while helper VP-on runs (planned prod setup);");
  console.log("       F=ffmpeg raw while bypass helper runs (restart w/ --bypass). Default: E,F,D.");
  process.exit(0);
}

try {
  const code = args.includes("--self-test") ? await selfTest() : await interactive(parsePathsArg(args));
  process.exit(code);
} catch (err) {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
}
