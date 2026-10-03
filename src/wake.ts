import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPaths, VoicePreferences } from "./contracts.ts";

export type WakeChoice = VoicePreferences["wake"];
export type Sensitivity = VoicePreferences["sensitivity"];

/**
 * Sensitivity to sherpa keyword-spotter tuning, calibrated live 2026-10-01
 * against `say` output (Samantha/Daniel/Karen): threshold 0.1 + score 1.0
 * detected all 4 positives ("hey pi"/"hi pi" variants) and rejected all 4
 * negatives ("happy birthday", "hey Siri", "the pie is ready",
 * "type check the project"). Low is stricter (fewer false alarms, may miss
 * soft "hi pi"); high is looser (catches more, risks false alarms).
 */
export const SENSITIVITY_CONFIG: Record<Sensitivity, { keywordsThreshold: number; keywordsScore: number }> = {
  low: { keywordsThreshold: 0.25, keywordsScore: 1.0 },
  normal: { keywordsThreshold: 0.1, keywordsScore: 1.0 },
  high: { keywordsThreshold: 0.05, keywordsScore: 1.0 },
};

/** Minimum gap between consecutive onWake fires. */
export const REFRACTORY_MS = 1500;

/** How far behind the live stream the staggered stream lags, in seconds of audio. */
export const STAGGER_LAG_S = 0.75;

/** Sample rate of audio fed to the spotter streams. */
export const SPOTTER_SAMPLE_RATE = 16000;

export type SpotterStream = {
  acceptWaveform: (input: { samples: Float32Array; sampleRate: number }) => void;
};

export type SpotterLike = {
  createStream: () => SpotterStream;
  isReady: (stream: SpotterStream) => boolean;
  decode: (stream: SpotterStream) => void;
  reset: (stream: SpotterStream) => void;
  getResult: (stream: SpotterStream) => { keyword: string };
};

export type SpotterConfig = {
  featSampleRate: number;
  featDim: number;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  keywordsFile: string;
  keywordsScore: number;
  keywordsThreshold: number;
};

export type WakeDetector = {
  push(frame: Buffer): void;
  reset(): void;
  close(): void;
};

export type WakeDetectorDeps = {
  createSpotter?: (config: SpotterConfig) => SpotterLike;
  now?: () => number;
  refractoryMs?: number;
  /** Raw assets/keywords.json text; default read from the repo assets dir. */
  keywordsJsonText?: string;
  /** Write filtered keywords file; default writes under os.tmpdir(). */
  writeKeywordsFile?: (content: string) => string;
  removeKeywordsFile?: (path: string) => void;
};

type KeywordsJson = {
  groups: Record<string, { phrase: string; tokens: string }[]>;
};

function keywordsJsonPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "assets", "keywords.json");
}

function loadKeywordsJsonText(deps: WakeDetectorDeps): string {
  if (deps.keywordsJsonText !== undefined) return deps.keywordsJsonText;
  return readFileSync(keywordsJsonPath(), "utf8");
}

function defaultWriteKeywordsFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-voice-kws-"));
  const path = join(dir, "keywords.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

function defaultRemoveKeywordsFile(path: string): void {
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
}

function defaultCreateSpotter(config: SpotterConfig): SpotterLike {
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { KeywordSpotter } = req("sherpa-onnx-node") as {
    KeywordSpotter: new (config: unknown) => SpotterLike;
  };
  return new KeywordSpotter({
    featConfig: { sampleRate: config.featSampleRate, featureDim: config.featDim },
    modelConfig: {
      transducer: { encoder: config.encoder, decoder: config.decoder, joiner: config.joiner },
      tokens: config.tokens,
      numThreads: 1,
      provider: "cpu",
    },
    keywordsFile: config.keywordsFile,
    keywordsScore: config.keywordsScore,
    keywordsThreshold: config.keywordsThreshold,
    numTrailingBlanks: 1,
  });
}

/** Phrase groups the spotter can report. */
export type WakeGroup = "hey-pi" | "hi-pi" | "send-to-pi";

export type WakeOptions = {
  /** Add the "send-to-pi" group alongside the wake group(s). Default false. */
  includeSend?: boolean;
};

function selectedGroups(choice: WakeChoice, options?: WakeOptions): WakeGroup[] {
  const base: WakeGroup[] = choice === "both" ? ["hey-pi", "hi-pi"] : [choice as WakeGroup];
  if (options?.includeSend && !base.includes("send-to-pi")) base.push("send-to-pi");
  return base;
}

/** Pick token lines for the chosen wake group(s): bare tokens, one per line. */
export function buildKeywordsFile(choice: WakeChoice, data: KeywordsJson, options?: WakeOptions): string {
  const entries = selectedGroups(choice, options).flatMap((g) => data.groups[g] ?? []);
  return `${entries.map((e) => e.tokens).join("\n")}\n`;
}

/** Map a spotter result keyword back to its group via keywords.json. */
export function mapKeywordToGroup(keyword: string, data: KeywordsJson): WakeGroup | undefined {
  const want = keyword.trim().toUpperCase();
  for (const [group, entries] of Object.entries(data.groups)) {
    if (entries.some((e) => e.phrase.toUpperCase() === want)) return group as WakeGroup;
  }
  return undefined;
}

/** Map a spotter result keyword back to its phrase via keywords.json. */
export function mapKeywordToPhrase(keyword: string, data: KeywordsJson): string {
  const want = keyword.trim().toUpperCase();
  for (const group of Object.values(data.groups)) {
    for (const entry of group) {
      if (entry.phrase.toUpperCase() === want) return entry.phrase;
    }
  }
  return keyword;
}

/**
 * Create a local keyword spotter. Live-verified 2026-10-01:
 * getResult().keyword returns matched phrase text ("HEY PI"/"HI PI"),
 * mapped back via keywords.json. For choice != both a filtered keywords
 * file (bare token lines, no @/# suffix) is written to os.tmpdir() and
 * removed on close(); "both" reuses paths.keywordsFile. push() converts
 * s16le frames to Float32 and runs the decode loop on two streams fed the
 * same audio: a live stream plus a staggered stream held STAGGER_LAG_S of
 * content behind each reset point (creation and every detection). Both
 * streams are reset on any detection; a ~1.5 s refractory period suppresses
 * double fires. All stagger timing is in audio samples, never wall-clock.
 */
export function createWakeDetector(
  paths: ModelPaths,
  choice: WakeChoice,
  sensitivity: Sensitivity,
  onWake: (phrase: string, group: WakeGroup | undefined) => void,
  deps?: WakeDetectorDeps,
  options?: WakeOptions,
): WakeDetector {
  const d = deps ?? {};
  const tuning = SENSITIVITY_CONFIG[sensitivity];
  const now = d.now ?? Date.now;
  const refractoryMs = d.refractoryMs ?? REFRACTORY_MS;
  const writeFile = d.writeKeywordsFile ?? defaultWriteKeywordsFile;
  const removeFile = d.removeKeywordsFile ?? defaultRemoveKeywordsFile;
  const createSpotter = d.createSpotter ?? defaultCreateSpotter;

  const data = JSON.parse(loadKeywordsJsonText(d)) as KeywordsJson;
  let keywordsFile = paths.keywordsFile;
  let tempFile: string | undefined;
  if (choice !== "both" || options?.includeSend) {
    tempFile = writeFile(buildKeywordsFile(choice, data, options));
    keywordsFile = tempFile;
  }

  const spotter = createSpotter({
    featSampleRate: 16000,
    featDim: 80,
    encoder: paths.encoder,
    decoder: paths.decoder,
    joiner: paths.joiner,
    tokens: paths.tokens,
    keywordsFile,
    keywordsScore: tuning.keywordsScore,
    keywordsThreshold: tuning.keywordsThreshold,
  });
  const streamLive = spotter.createStream();
  const streamLag = spotter.createStream();
  const lagSamples = Math.round(SPOTTER_SAMPLE_RATE * STAGGER_LAG_S);
  // Samples accepted but not yet fed to the staggered stream; the tail of
  // length lagSamples is always withheld so the lag stream trails the live
  // stream by STAGGER_LAG_S of content.
  let pending: Float32Array[] = [];
  let pendingSamples = 0;
  let lastFire = Number.NEGATIVE_INFINITY;
  let closed = false;

  function clearPending(): void {
    pending = [];
    pendingSamples = 0;
  }

  function resetBoth(): void {
    spotter.reset(streamLive);
    spotter.reset(streamLag);
    clearPending();
  }

  function handleDetection(keyword: string): void {
    resetBoth();
    const phrase = mapKeywordToPhrase(keyword, data);
    const group = mapKeywordToGroup(keyword, data);
    const at = now();
    if (at - lastFire >= refractoryMs) {
      lastFire = at;
      onWake(phrase, group);
    }
  }

  function drainStream(stream: SpotterStream): void {
    let guard = 0;
    while (spotter.isReady(stream) && guard++ < 32) {
      spotter.decode(stream);
      const result = spotter.getResult(stream);
      if (!result.keyword) continue;
      handleDetection(result.keyword);
    }
  }

  return {
    push(frame: Buffer): void {
      if (closed || frame.length < 2) return;
      const count = Math.floor(frame.length / 2);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = frame.readInt16LE(i * 2) / 32768;
      streamLive.acceptWaveform({ samples, sampleRate: SPOTTER_SAMPLE_RATE });
      pending.push(samples);
      pendingSamples += samples.length;
      let releasable = pendingSamples - lagSamples;
      while (releasable > 0 && pending.length > 0) {
        const first = pending[0] as Float32Array;
        if (first.length <= releasable) {
          streamLag.acceptWaveform({ samples: first, sampleRate: SPOTTER_SAMPLE_RATE });
          pending.shift();
          pendingSamples -= first.length;
          releasable -= first.length;
        } else {
          streamLag.acceptWaveform({
            samples: first.subarray(0, releasable),
            sampleRate: SPOTTER_SAMPLE_RATE,
          });
          pending[0] = first.subarray(releasable);
          pendingSamples -= releasable;
          releasable = 0;
        }
      }
      drainStream(streamLive);
      drainStream(streamLag);
    },
    reset(): void {
      if (!closed) resetBoth();
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        resetBoth();
      } catch {
        /* ignore reset errors during teardown */
      }
      if (tempFile) {
        removeFile(tempFile);
        tempFile = undefined;
      }
    },
  };
}
