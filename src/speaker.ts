import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { stateDir } from "./preferences.ts";

/**
 * Enrolled owner voice profile. Centroid is L2-normalized. enrollScores
 * holds each clip's leave-one-out cosine (clip vs the centroid of the
 * other clips). Suggested thresholds are provisional until calibrated
 * on the owner's real voice.
 */
export type LearnedSample = {
  v: number[];
  at: string;
  score: number;
  /** Last time a discarded near-duplicate refreshed this sample as current. */
  lastSeen?: string;
};

export type SpeakerProfile = {
  version: 1;
  model: string;
  dim: number;
  centroid: number[];
  enrolledAt: string;
  enrollScores: number[];
  /** Per-user accept threshold derived from enrollScores; see suggestedThresholdFor. Provisional until calibrated on the owner's real voice. */
  suggestedThreshold: number;
  /** Enrollment-time threshold snapshot from buildProfile. Learning may move suggestedThreshold only within [enrollThreshold - 0.03, enrollThreshold] so adaptation cannot creep above the enrollment gate. Absent on pre-change profiles, which fall back to their current suggestedThreshold. */
  enrollThreshold?: number;
  /** Enrollment embeddings (one per clip), stored by buildProfile. Absent on pre-change profiles; those treat [centroid] as the single anchor. */
  anchors?: number[][];
  /** Owner-voice samples learned during normal use (FIFO-capped). */
  learned?: LearnedSample[];
};

/** Minimum enrollment clips required to build a profile. Leave-one-out scoring with 3 clips is too noisy. */
export const MIN_ENROLL_CLIPS = 4;

/** Recommended enrollment clip count for a stable profile. */
export const RECOMMENDED_ENROLL_CLIPS = 5;

/** Sample rate the embedder expects. */
export const SPEAKER_SAMPLE_RATE = 16000;

/**
 * Provisional cosine-similarity thresholds (low/normal/high sensitivity).
 * Calibrated 2026-10-04 on synthetic macOS `say` voices (Samantha,
 * Daniel, Karen, Moira x 4 sentences; centroid from 3 clips, 4th held
 * out; CAM++ dim 512): same-voice held-out 0.789-0.871, cross-voice
 * 0.558-0.807 — the bands overlap (worst: Karen clip vs Samantha
 * centroid 0.807 > Samantha self 0.789), so no threshold separates
 * synthetic voices cleanly. The low-0.6/normal-0.7/high-0.8 ladder
 * accepts every same-voice sample at "normal" while admitting
 * lookalike cross-voice samples; "high" rejects nearly all cross
 * (only the 0.807 pair passes) at the cost of borderline same-voice
 * rejects. Synthetic voices share one TTS pipeline and are only a
 * proxy: re-calibrate on real human enrollment audio and prefer
 * "normal" until then.
 */
export const SPEAKER_THRESHOLDS: { low: number; normal: number; high: number } = {
  low: 0.6,
  normal: 0.7,
  high: 0.8,
};

/** Cosine similarity in [-1, 1]; returns 0 when either vector has zero norm. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Derive a per-user accept threshold from leave-one-out enrollment self-scores.
 * Provisional rule: 0.05 below the worst leave-one-out score, clamped
 * into [0.5, 0.85]. The margin tolerates session variation while the
 * floor blocks absurdly lax gates from sloppy enrollments and the cap
 * keeps the gate selective; empty input falls back to
 * SPEAKER_THRESHOLDS.normal. Provisional until calibrated on the
 * owner's real voice: re-calibrate on real human audio before trusting it.
 */
export function suggestedThresholdFor(enrollScores: number[]): number {
  if (enrollScores.length === 0) return SPEAKER_THRESHOLDS.normal;
  return Math.min(0.85, Math.max(0.5, Math.min(...enrollScores) - 0.05));
}

function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += (vec[i] as number) * (vec[i] as number);
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = (vec[i] as number) / norm;
  return out;
}

/**
 * Build an owner profile from enrollment embeddings: the L2-normalized
 * mean (centroid). enrollScores holds each clip's leave-one-out cosine:
 * the clip scored against the normalized centroid of the OTHER clips,
 * so no clip inflates its own score by pulling the centroid toward
 * itself. Requires at least 4 clips; all embeddings must share one
 * dimension. The derived threshold is provisional until calibrated on
 * the owner's real voice.
 */
export function buildProfile(embeddings: Float32Array[], model: string): SpeakerProfile {
  if (embeddings.length < MIN_ENROLL_CLIPS) {
    throw new Error(`Need at least ${MIN_ENROLL_CLIPS} enrollment clips, got ${embeddings.length}.`);
  }
  const dim = embeddings[0]?.length ?? 0;
  if (dim === 0) throw new Error("Enrollment embeddings must be non-empty.");
  for (const e of embeddings) {
    if (e.length !== dim) throw new Error("Enrollment embeddings must share one dimension.");
  }
  const mean = new Float32Array(dim);
  for (const e of embeddings) {
    for (let i = 0; i < dim; i++) mean[i] = (mean[i] as number) + (e[i] as number);
  }
  for (let i = 0; i < dim; i++) mean[i] = (mean[i] as number) / embeddings.length;
  const centroid = normalize(mean);
  const enrollScores = embeddings.map((heldOut, heldIdx) => {
    const rest = new Float32Array(dim);
    for (let j = 0; j < embeddings.length; j++) {
      if (j === heldIdx) continue;
      const e = embeddings[j]!;
      for (let i = 0; i < dim; i++) rest[i] = (rest[i] as number) + (e[i] as number);
    }
    for (let i = 0; i < dim; i++) rest[i] = (rest[i] as number) / (embeddings.length - 1);
    return cosineSimilarity(heldOut, normalize(rest));
  });
  const anchors = embeddings.map((e) => Array.from(e));
  const suggestedThreshold = suggestedThresholdFor(enrollScores);
  const profile: SpeakerProfile = {
    version: 1,
    model,
    dim,
    centroid: Array.from(centroid),
    enrolledAt: new Date().toISOString(),
    enrollScores,
    suggestedThreshold,
    enrollThreshold: suggestedThreshold,
    anchors,
    learned: [],
  };
  return profile;
}

export type SpeakerStreamLike = {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
  inputFinished(): void;
};

export type SpeakerExtractorLike = {
  dim: number;
  createStream(): SpeakerStreamLike;
  isReady(stream: SpeakerStreamLike): boolean;
  compute(stream: SpeakerStreamLike): Float32Array;
};

export type SpeakerEmbedder = {
  dim: number;
  embed(pcm16k: Buffer): Float32Array;
};

function defaultExtractorFactory(modelPath: string): SpeakerExtractorLike {
  const req = createRequire(import.meta.url);
  const { SpeakerEmbeddingExtractor } = req("sherpa-onnx-node") as {
    SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number }) => SpeakerExtractorLike;
  };
  return new SpeakerEmbeddingExtractor({ model: modelPath, numThreads: 1 });
}

/**
 * Create a speaker embedder over s16le mono 16 kHz PCM. Each embed()
 * call runs a fresh stream and returns an L2-normalized embedding.
 */
export function createSpeakerEmbedder(
  modelPath: string,
  opts?: { extractorFactory?: (modelPath: string) => SpeakerExtractorLike },
): SpeakerEmbedder {
  const extractor = (opts?.extractorFactory ?? defaultExtractorFactory)(modelPath);
  const dim = extractor.dim;
  return {
    dim,
    embed(pcm16k: Buffer): Float32Array {
      if (pcm16k.length === 0 || pcm16k.length % 2 !== 0) {
        throw new Error("embed() needs non-empty even-length s16le PCM.");
      }
      const samples = new Float32Array(pcm16k.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = pcm16k.readInt16LE(i * 2) / 32768;
      }
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples, sampleRate: SPEAKER_SAMPLE_RATE });
      stream.inputFinished();
      if (!extractor.isReady(stream)) throw new Error("Speaker extractor produced no embedding for this audio.");
      return normalize(extractor.compute(stream));
    },
  };
}

function speakerFile(dirOverride?: string): string {
  return join(stateDir(dirOverride), "speaker.json");
}

/** Load the enrolled profile. Never throws: missing/corrupt/dim-mismatched files yield undefined. */
export async function loadSpeakerProfile(
  dirOverride?: string,
  onWarning?: (message: string) => void,
): Promise<SpeakerProfile | undefined> {
  const file = speakerFile(dirOverride);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    onWarning?.(`Ignoring corrupt speaker profile at ${file}.`);
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) {
    onWarning?.(`Ignoring invalid speaker profile at ${file}.`);
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  if (
    r["version"] !== 1 ||
    typeof r["model"] !== "string" ||
    typeof r["dim"] !== "number" ||
    !Array.isArray(r["centroid"]) ||
    typeof r["enrolledAt"] !== "string" ||
    !Array.isArray(r["enrollScores"])
  ) {
    onWarning?.(`Ignoring invalid speaker profile at ${file}.`);
    return undefined;
  }
  const dim = r["dim"] as number;
  const centroid = r["centroid"] as unknown[];
  if (!Number.isInteger(dim) || dim <= 0 || centroid.length !== dim || !centroid.every((v) => typeof v === "number")) {
    onWarning?.(`Ignoring speaker profile with dimension mismatch at ${file}.`);
    return undefined;
  }
  const suggestedThreshold =
    typeof r["suggestedThreshold"] === "number" &&
    (r["suggestedThreshold"] as number) > 0 &&
    (r["suggestedThreshold"] as number) < 1
      ? (r["suggestedThreshold"] as number)
      : SPEAKER_THRESHOLDS.normal;
  // Legacy profiles predate enrollThreshold: anchor the learning window to
  // whatever gate they currently enforce.
  const enrollThreshold =
    typeof r["enrollThreshold"] === "number" &&
    (r["enrollThreshold"] as number) > 0 &&
    (r["enrollThreshold"] as number) < 1
      ? (r["enrollThreshold"] as number)
      : suggestedThreshold;
  const profile: SpeakerProfile = {
    version: 1,
    model: r["model"] as string,
    dim,
    centroid: centroid as number[],
    enrolledAt: r["enrolledAt"] as string,
    enrollScores: (r["enrollScores"] as unknown[]).filter((v): v is number => typeof v === "number"),
    suggestedThreshold,
    enrollThreshold,
  };
  const anchors = parseAnchors(r["anchors"], dim);
  if (anchors !== undefined) profile.anchors = anchors;
  const learned = parseLearned(r["learned"], dim);
  if (learned !== undefined) profile.learned = learned;
  return profile;
}

function parseAnchors(raw: unknown, dim: number): number[][] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== dim || !row.every((v) => typeof v === "number")) return undefined;
    out.push([...(row as number[])]);
  }
  return out;
}

function parseLearned(raw: unknown, dim: number): LearnedSample[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const out: LearnedSample[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return undefined;
    const rec = item as Record<string, unknown>;
    const v = rec["v"];
    const at = rec["at"];
    const score = rec["score"];
    if (!Array.isArray(v) || (v as unknown[]).length !== dim || !(v as unknown[]).every((x) => typeof x === "number"))
      return undefined;
    if (typeof at !== "string" || typeof score !== "number") return undefined;
    const entry: LearnedSample = { v: [...(v as number[])], at, score };
    if (typeof rec["lastSeen"] === "string") entry.lastSeen = rec["lastSeen"] as string;
    out.push(entry);
  }
  return out;
}

/** Save the profile atomically (temp file + rename) with mode 0600, dir 0700. */
export async function saveSpeakerProfile(profile: SpeakerProfile, dirOverride?: string): Promise<void> {
  const file = speakerFile(dirOverride);
  const dir = stateDir(dirOverride);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot secure speaker profile directory ${dir} with mode 0700: ${detail}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(profile, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

/** Delete the enrolled profile, if any. Never throws when already absent. */
export async function deleteSpeakerProfile(dirOverride?: string): Promise<void> {
  await rm(speakerFile(dirOverride), { force: true });
}

export type SpeakerGateOptions = {
  embed: (pcm: Buffer) => Float32Array;
  profile: SpeakerProfile;
  threshold: number;
  minSpeechMs?: number;
  maxSpeechMs?: number;
};

export type SpeakerGateResult = {
  decision: "accept" | "reject" | "insufficient";
  score?: number;
  speechMs: number;
  embedding?: Float32Array;
  /** Present on fail-closed rejects: the embedding budget ran out with unscored speech. */
  reason?: "unverified";
};

export type SpeakerGate = {
  push(pcm16k: Buffer): void;
  decision(): "accept" | "reject" | "pending";
  finalize(): SpeakerGateResult;
  reset(): void;
  /** The embedding scored by the mid-utterance decision path / finalize, if any. No extra embedding is computed. */
  lastEmbedding(): Float32Array | undefined;
};

const MS_PER_BYTE = 1000 / (SPEAKER_SAMPLE_RATE * 2);

/**
 * Gate wake audio against the enrolled profile. The caller pushes only
 * speech-flagged s16le 16 kHz PCM. Audio accumulates until minSpeechMs
 * (default 1200), at which point the head window is embedded once.
 * An early "reject" is terminal and aborts the utterance immediately.
 * An early "accept" is provisional: speech keeps accumulating and
 * finalize() re-scores whenever speech arrived since the last scoring, so
 * the final verdict (and learning) reflects the whole utterance, including
 * speech that resumed after a pause. finalize() never returns a verdict
 * computed on stale audio.
 *
 * Two windows are scored: the head (the first maxSpeechMs of speech, which
 * is also the only window ever offered for learning) and, when the utterance
 * holds more than maxSpeechMs, the tail (the most recent maxSpeechMs). The
 * final decision is reject when either window rejects. finalize() embeds
 * whatever exists below minSpeechMs (< 600 ms of audio is "insufficient"
 * without embedding).
 *
 * Embedding budget: at most 6 embeddings per utterance. Measured 2026-10-04
 * against the cached CAM++ model (3D-Speaker, dim 512) via sherpa-onnx:
 * 1 s of audio embeds in median 20.1 ms / p95 20.9 ms, 3 s in median
 * 51.1 ms / p95 52.0 ms (20 runs each). Six worst-case 3 s embeddings cost
 * ~310 ms, paid only across the end-of-utterance settles; a typical
 * utterance needs 2-3 (early + head + tail). When the budget is spent while
 * unscored speech remains, finalize() fails closed: decision "reject" with
 * reason "unverified" and no embedding, so the controller submits nothing
 * and learns nothing from the unverified audio.
 */
export function createSpeakerGate(opts: SpeakerGateOptions): SpeakerGate {
  const minSpeechMs = opts.minSpeechMs ?? 1200;
  const maxSpeechMs = opts.maxSpeechMs ?? 3000;
  const MAX_EMBEDS = 6;
  let chunks: Buffer[] = [];
  let bytes = 0;
  let embeds = 0;
  type Scored = { embedding: Float32Array; score: number; verdict: "accept" | "reject" };
  let head: (Scored & { windowBytes: number }) | undefined;
  let tail: (Scored & { total: number }) | undefined;
  let lastScored: Float32Array | undefined;
  let failedClosed = false;
  const maxBytes = Math.floor((maxSpeechMs * SPEAKER_SAMPLE_RATE * 2) / 1000);

  function speechMs(): number {
    return bytes * MS_PER_BYTE;
  }
  function headWindowBytes(): number {
    return Math.min(bytes, maxBytes);
  }
  function headWindowMs(): number {
    return headWindowBytes() * MS_PER_BYTE;
  }
  function scoreWindow(buf: Buffer): Scored {
    const emb = opts.embed(buf);
    embeds += 1;
    lastScored = emb;
    const score = scoreSample(opts.profile, emb);
    return { embedding: emb, score, verdict: score >= opts.threshold ? "accept" : "reject" };
  }
  function rejected(s: Scored): SpeakerGateResult {
    return { decision: "reject", score: s.score, speechMs: headWindowMs(), embedding: s.embedding };
  }
  function failClosed(): SpeakerGateResult {
    failedClosed = true;
    return { decision: "reject", reason: "unverified", speechMs: headWindowMs() };
  }
  function terminalReject(): boolean {
    return failedClosed || head?.verdict === "reject" || tail?.verdict === "reject";
  }

  // Score the windows that grew since the last scoring. A repeat finalize
  // with no new speech embeds nothing. All speech is retained so the tail
  // window (most recent maxSpeechMs) stays available.
  function scoreFresh(): SpeakerGateResult {
    const full = Buffer.concat(chunks);
    if (head === undefined || head.windowBytes < headWindowBytes()) {
      if (embeds >= MAX_EMBEDS) return failClosed();
      const scored = scoreWindow(full.subarray(0, headWindowBytes()));
      head = { ...scored, windowBytes: headWindowBytes() };
      if (head.verdict === "reject") return rejected(head);
    }
    if (bytes > maxBytes && (tail === undefined || tail.total !== bytes)) {
      if (embeds >= MAX_EMBEDS) return failClosed();
      const scored = scoreWindow(full.subarray(bytes - maxBytes, bytes));
      tail = { ...scored, total: bytes };
      if (tail.verdict === "reject") return rejected(tail);
    }
    const done = head;
    // Unreachable: scoreFresh runs only when head is missing (scored above)
    // or a window was stale (head present). Guard for the type checker.
    if (done === undefined) return failClosed();
    // Learning always uses the head window: its embedding and its speechMs.
    return { decision: done.verdict, score: done.score, speechMs: headWindowMs(), embedding: done.embedding };
  }

  function result(): SpeakerGateResult {
    if (failedClosed) return { decision: "reject", reason: "unverified", speechMs: headWindowMs() };
    if (head?.verdict === "reject") return rejected(head);
    if (tail?.verdict === "reject") return rejected(tail);
    if (head === undefined) {
      // Not enough speech to score: report insufficient without embedding.
      if (speechMs() < 600) return { decision: "insufficient", speechMs: speechMs() };
      return scoreFresh();
    }
    const needHead = head.windowBytes < headWindowBytes();
    const needTail = bytes > maxBytes && (tail === undefined || tail.total !== bytes);
    if (!needHead && !needTail) {
      return { decision: head.verdict, score: head.score, speechMs: headWindowMs(), embedding: head.embedding };
    }
    return scoreFresh();
  }

  return {
    push(pcm16k: Buffer): void {
      // A reject is terminal: the controller aborts the utterance mid-stream.
      if (terminalReject()) return;
      chunks.push(pcm16k);
      bytes += pcm16k.length;
      // Mid-utterance stays provisional after the early verdict; re-scoring
      // happens in finalize(), not on every frame.
      if (head !== undefined) return;
      if (speechMs() < minSpeechMs) return;
      const full = Buffer.concat(chunks);
      const scored = scoreWindow(full.subarray(0, headWindowBytes()));
      head = { ...scored, windowBytes: headWindowBytes() };
    },
    decision(): "accept" | "reject" | "pending" {
      if (terminalReject()) return "reject";
      if (head === undefined) return "pending";
      return head.verdict;
    },
    finalize(): SpeakerGateResult {
      return result();
    },
    lastEmbedding(): Float32Array | undefined {
      return lastScored;
    },
    reset(): void {
      chunks = [];
      bytes = 0;
      embeds = 0;
      head = undefined;
      tail = undefined;
      lastScored = undefined;
      failedClosed = false;
    },
  };
}

/**
 * Provisional online-learning knobs for adaptProfile/addCorrection.
 * Values are guesses until calibrated on real owner voice data; expect them
 * to change once false-accept/false-reject rates are measured.
 */
export type LearnConfig = {
  /** Sample score must clear threshold by at least this margin to be learned. */
  margin: number;
  /** Minimum scored speech duration (ms) before a sample is learned. */
  minSpeechMs: number;
  /** Capacity of the learned reservoir bank. */
  maxLearned: number;
  /** Minimum share of total centroid weight carried by enrollment anchors. */
  anchorWeight: number;
  /** Maximum allowed threshold move per adaptation, in either direction. */
  maxThresholdStep: number;
  /** Owner-confirmed corrections tolerate a lower anchor-similarity bar by this much. */
  correctionSlack: number;
  /** Two samples within this cosine are the same speaking condition. */
  sameCondition: number;
  /** Max share of the learned bank one condition neighbourhood may occupy. */
  maxClusterShare: number;
};

export const LEARN: LearnConfig = {
  /** Sample score must clear threshold by at least this margin to be learned. */
  margin: 0.05,
  /** Minimum scored speech duration (ms) before a sample is learned. */
  minSpeechMs: 2000,
  /** Capacity of the learned reservoir bank. Kept at 16: calibration (research/speaker-bank/results.md) found coverage saturates by 16 while impostor acceptance rises monotonically with capacity (22.2% at 0, 34.6% at 16, 44.4% at 256 for the most overlapping synthetic voice). */
  maxLearned: 16,
  /** Minimum share of total centroid weight carried by enrollment anchors. */
  anchorWeight: 0.3,
  /** Maximum allowed threshold move per adaptation, in either direction. */
  maxThresholdStep: 0.02,
  /** Owner-confirmed corrections tolerate a lower anchor-similarity bar by this much. */
  correctionSlack: 0.15,
  /** Two samples within this cosine are the same speaking condition. */
  sameCondition: 0.9,
  /** Max share of the learned bank one condition neighbourhood may occupy. */
  maxClusterShare: 0.25,
};

function resolveLearn(opts?: Partial<LearnConfig>): LearnConfig {
  return { ...LEARN, ...opts };
}

export type AdaptReason = "learned" | "low-score" | "too-short" | "anchor-drift" | "dim-mismatch";

export type AdaptResult = {
  profile: SpeakerProfile;
  adapted: boolean;
  reason: AdaptReason;
};

function anchorsOf(profile: SpeakerProfile): number[][] {
  if (profile.anchors !== undefined && profile.anchors.length > 0) return profile.anchors;
  return [profile.centroid];
}

function normalizedMeanVecs(vecs: number[][]): number[] {
  const dim = vecs[0]!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const v of vecs) for (let i = 0; i < dim; i++) mean[i]! += v[i]!;
  for (let i = 0; i < dim; i++) mean[i]! /= vecs.length;
  const norm = Math.hypot(...mean);
  if (norm === 0) return mean;
  return mean.map((x) => x / norm);
}

function looScoresFor(vecs: number[][]): number[] {
  return vecs.map((clip, i) => {
    const rest = vecs.filter((_, j) => j !== i);
    if (rest.length === 0) return 1;
    const restProfile: SpeakerProfile = {
      version: 1,
      model: "",
      dim: clip.length,
      centroid: normalizedMeanVecs(rest),
      enrolledAt: "",
      enrollScores: [],
      suggestedThreshold: 0,
      anchors: rest,
    };
    return scoreSample(restProfile, Float32Array.from(clip));
  });
}

/**
 * Score an embedding against a profile: the best of the centroid cosine and
 * the mean of the top-3 cosines to individual samples (anchors + learned).
 * A centroid smears distinct speaking conditions together, so the exemplar
 * term keeps corner conditions (sick, odd mic) scoring highly. Shared by
 * createSpeakerGate and the leave-one-out threshold derivation.
 */
export function scoreSample(profile: SpeakerProfile, embedding: Float32Array): number {
  const centroidScore = cosineSimilarity(embedding, profile.centroid);
  const samples = [...anchorsOf(profile), ...((profile.learned ?? []).map((s) => s.v))];
  if (samples.length === 0) return centroidScore;
  const sims = samples.map((s) => cosineSimilarity(embedding, s)).sort((a, b) => b - a);
  const top = sims.slice(0, 3);
  const exemplar = top.reduce((a, b) => a + b, 0) / top.length;
  return Math.max(centroidScore, exemplar);
}

function neighbourhoodSize(all: number[][], index: number, cfg: LearnConfig): number {
  let n = 0;
  for (let j = 0; j < all.length; j++) {
    if (cosineSimilarity(all[index]!, all[j]!) >= cfg.sameCondition) n++;
  }
  return Math.max(n, 1);
}

function recomputeCentroid(anchors: number[][], learned: LearnedSample[], cfg: LearnConfig): number[] {
  const nA = anchors.length;
  const nL = learned.length;
  if (nL === 0) return normalizedMeanVecs(anchors);
  // Density weights: samples in crowded conditions share one vote, so dense
  // regions cannot dominate the centroid.
  const all = [...anchors, ...learned.map((s) => s.v)];
  const learnedWeights = learned.map((_, k) => 1 / neighbourhoodSize(all, nA + k, cfg));
  const learnedTotal = learnedWeights.reduce((a, b) => a + b, 0);
  const equalShare = nA / (nA + learnedTotal);
  const anchorScale =
    equalShare >= cfg.anchorWeight ? 1 : (cfg.anchorWeight * learnedTotal) / ((1 - cfg.anchorWeight) * nA);
  const dim = anchors[0]!.length;
  const mean = new Array<number>(dim).fill(0);
  for (const a of anchors) for (let i = 0; i < dim; i++) mean[i]! += a[i]! * anchorScale;
  learned.forEach((s, k) => {
    for (let i = 0; i < dim; i++) mean[i]! += s.v[i]! * learnedWeights[k]!;
  });
  const norm = Math.hypot(...mean);
  if (norm === 0) return mean;
  return mean.map((x) => x / norm);
}

function stepLimitedThreshold(prev: number, raw: number, cfg: LearnConfig): number {
  const delta = Math.min(Math.max(raw - prev, -cfg.maxThresholdStep), cfg.maxThresholdStep);
  return Math.min(Math.max(prev + delta, 0.5), 0.85);
}

function nearestLearned(learned: LearnedSample[], vec: number[]): number {
  let best = 0;
  let bestSim = -Infinity;
  learned.forEach((s, i) => {
    const sim = cosineSimilarity(vec, s.v);
    if (sim > bestSim) {
      bestSim = sim;
      best = i;
    }
  });
  return best;
}

/** Highest nearest-neighbour cosine of vecs[i] to any other vec in all. */
function redundancyOf(all: number[][], index: number): number {
  let best = -Infinity;
  for (let j = 0; j < all.length; j++) {
    if (j === index) continue;
    const sim = cosineSimilarity(all[index]!, all[j]!);
    if (sim > best) best = sim;
  }
  return best;
}

function rebuildProfile(
  profile: SpeakerProfile,
  learned: LearnedSample[],
  anchors: number[][],
  cfg: LearnConfig,
): SpeakerProfile {
  const centroid = recomputeCentroid(anchors, learned, cfg);
  const raw = suggestedThresholdFor(looScoresFor([...anchors, ...learned.map((s) => s.v)]));
  // Pin learning to the enrollment window: clamp the raw target into
  // [enrollThreshold - 0.03, enrollThreshold] first, then apply the per-update
  // step limit. Calibration (research/speaker-bank/results.md) showed clean-clip
  // learning otherwise creeps the threshold upward (0.61 to 0.846 for one owner)
  // and locks out the owner's own corner conditions, so learning may ease the
  // gate down slightly but never raise it above the enrollment value.
  const enroll = profile.enrollThreshold ?? profile.suggestedThreshold;
  const windowed = Math.min(Math.max(raw, enroll - 0.03), enroll);
  return {
    ...profile,
    anchors,
    learned,
    centroid,
    suggestedThreshold: stepLimitedThreshold(profile.suggestedThreshold, windowed, cfg),
  };
}

/**
 * Diversity-aware reservoir admission. The learned bank keeps ~maxLearned
 * representative samples spanning the observed conditions; anchors are fixed
 * and never evicted. When the bank (or the candidate's condition
 * neighbourhood) is full, the most redundant sample in scope is evicted;
 * when the candidate itself is most redundant it is discarded and its
 * nearest learned neighbour is refreshed via lastSeen.
 */
function withLearnedSample(profile: SpeakerProfile, sample: LearnedSample, cfg: LearnConfig): SpeakerProfile {
  const anchors = anchorsOf(profile);
  const learned: LearnedSample[] = [...(profile.learned ?? [])];
  const clusterCap = Math.max(1, Math.floor(cfg.maxClusterShare * cfg.maxLearned));
  const inHood = (vec: number[]): boolean => cosineSimilarity(sample.v, vec) >= cfg.sameCondition;
  const hoodSize = learned.filter((s) => inHood(s.v)).length;
  if (learned.length < cfg.maxLearned && hoodSize < clusterCap) {
    return rebuildProfile(profile, [...learned, { ...sample, lastSeen: sample.at }], anchors, cfg);
  }
  // Full bank or full neighbourhood: evict the most redundant sample in scope.
  const scope: number[] = hoodSize >= clusterCap
    ? learned.map((s, i) => i).filter((i) => inHood(learned[i]!.v))
    : learned.map((_, i) => i);
  const all = [...anchors, ...learned.map((s) => s.v), sample.v];
  const candidateIndex = all.length - 1;
  let evict = -1;
  let evictRedundancy = -Infinity;
  let evictAt = "";
  for (const i of scope) {
    const r = redundancyOf(all, anchors.length + i);
    const at = learned[i]!.at;
    if (r > evictRedundancy || (r === evictRedundancy && at < evictAt)) {
      evictRedundancy = r;
      evict = i;
      evictAt = at;
    }
  }
  const candidateRedundancy = redundancyOf(all, candidateIndex);
  if (evict === -1 || candidateRedundancy > evictRedundancy) {
    // Candidate adds nothing: discard it, refresh the nearest neighbour.
    const near = nearestLearned(learned, sample.v);
    const refreshed = learned.map((s, i) => (i === near ? { ...s, lastSeen: sample.at } : s));
    return { ...profile, anchors: profile.anchors ?? [profile.centroid], learned: refreshed };
  }
  const next = learned.filter((_, i) => i !== evict);
  next.push({ ...sample, lastSeen: sample.at });
  return rebuildProfile(profile, next, anchors, cfg);
}

/**
 * Consider one scored utterance sample for online learning. Pure: returns a
 * new profile. A sample is learned only when it clears the accept threshold
 * by LEARN.margin, spans at least LEARN.minSpeechMs of speech, and sits
 * within the owner's anchor cone (cosine to the anchor centroid, not the
 * adapted centroid, must reach suggestedThreshold) so impostors cannot drag
 * the profile away from the enrollment voice.
 */
export function adaptProfile(
  profile: SpeakerProfile,
  sample: { embedding: Float32Array; score: number; speechMs: number; threshold: number },
  now?: Date,
  opts?: Partial<LearnConfig>,
): AdaptResult {
  const cfg = resolveLearn(opts);
  if (sample.embedding.length !== profile.dim) return { profile, adapted: false, reason: "dim-mismatch" };
  if (sample.speechMs < cfg.minSpeechMs) return { profile, adapted: false, reason: "too-short" };
  if (sample.score < sample.threshold + cfg.margin) return { profile, adapted: false, reason: "low-score" };
  const anchorSim = cosineSimilarity(sample.embedding, normalizedMeanVecs(anchorsOf(profile)));
  if (anchorSim < profile.suggestedThreshold) return { profile, adapted: false, reason: "anchor-drift" };
  return {
    profile: withLearnedSample(
      profile,
      {
        v: Array.from(sample.embedding),
        at: (now ?? new Date()).toISOString(),
        score: sample.score,
      },
      cfg,
    ),
    adapted: true,
    reason: "learned",
  };
}

/**
 * Learn one owner-confirmed sample (explicit correction). Skips the score
 * margin and minimum-duration checks, but still rejects samples outside the
 * anchor cone (bar lowered by LEARN.correctionSlack) and dimension
 * mismatches. Pure: returns a new profile.
 */
export function addCorrection(
  profile: SpeakerProfile,
  embedding: Float32Array,
  now?: Date,
  opts?: Partial<LearnConfig>,
): AdaptResult {
  const cfg = resolveLearn(opts);
  if (embedding.length !== profile.dim) return { profile, adapted: false, reason: "dim-mismatch" };
  const anchorSim = cosineSimilarity(embedding, normalizedMeanVecs(anchorsOf(profile)));
  if (anchorSim < profile.suggestedThreshold - cfg.correctionSlack)
    return { profile, adapted: false, reason: "anchor-drift" };
  return {
    profile: withLearnedSample(
      profile,
      {
        v: Array.from(embedding),
        at: (now ?? new Date()).toISOString(),
        score: scoreSample(profile, embedding),
      },
      cfg,
    ),
    adapted: true,
    reason: "learned",
  };
}

/** Drop learned samples, restore the anchor centroid, and restore the enrollment gate. Pure. */
export function resetLearning(profile: SpeakerProfile): SpeakerProfile {
  const anchors = anchorsOf(profile);
  const enrollThreshold = profile.enrollThreshold ?? profile.suggestedThreshold;
  return {
    ...profile,
    anchors: profile.anchors ?? [profile.centroid],
    learned: [],
    centroid: normalizedMeanVecs(anchors),
    suggestedThreshold: enrollThreshold,
    enrollThreshold,
  };
}

/** Number of retained learned samples. */
export function learnedCount(profile: SpeakerProfile): number {
  return profile.learned?.length ?? 0;
}
