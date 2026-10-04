/**
 * Lane E `/voice` slash surface: subcommand parser, context-aware
 * completions, and the command handler. Pure logic over an injected
 * environment so tests run with fakes (no network, mic, or key).
 */

import type { MicDevice, TtsProvider, VoicePreferences } from "./contracts.ts";
import { speakerThresholdFor } from "./contracts.ts";
import { cosineSimilarity, LEARN, MIN_ENROLL_CLIPS, addCorrection, learnedCount, resetLearning, scoreSample, type SpeakerProfile } from "./speaker.ts";
import { DEFAULT_TTS_MODEL } from "./tts.ts";
import { DEFAULT_INWORLD_MODEL, DEFAULT_INWORLD_VOICE, INWORLD_TTS_MODELS } from "./inworld-tts.ts";
import type { VoiceController } from "./controller.ts";
import { DEFAULT_PUSH_TO_TALK, parseHotkeyCombo } from "./hotkey.ts";
import { OFFLINE_TTS_MODELS, type VoiceEntry } from "./elevenlabs-api.ts";
import { resolveTtsModelId, resolveTtsVoiceId, ttsProviderOf } from "./preferences.ts";

export const MISSING_KEY_MESSAGE = "Export ELEVENLABS_API_KEY and restart Pi.";
export const MISSING_INWORLD_KEY_MESSAGE = "Export INWORLD_API_KEY and restart Pi.";

export type AutocompleteItem = { value: string; label: string; description?: string };

export type CommandCtx = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
};

/** Guided-enrollment prompt count: 6 clips target, minimum 5 kept. */
const ENROLL_CLIP_COUNT = 6;

/** Minimum enrollment clips kept before a profile is built. */
const ENROLL_MIN_KEPT = 5;

/**
 * Longer natural sentences, each yielding >= 3 s of VAD speech when read
 * aloud at a normal pace. Never written to disk.
 */
const ENROLL_PHRASES: readonly string[] = [
  "The quick brown fox jumps over the lazy dog while the river flows quietly behind the old wooden fence",
  "Pack my box with five dozen liquor jugs before the delivery truck leaves the warehouse this afternoon",
  "She sells seashells by the seashore every sunny morning while the waves crash against the rocks",
  "The five boxing wizards jump quickly across the stage as the excited crowd cheers loudly for more",
  "Weave a circle round him thrice while the evening bells ring softly across the quiet village green",
  "How vexingly quick daft zebras jump when the safari guide opens the gate at sunrise every day",
];

/** Minimum speech per enrollment clip in ms; shorter captures are repeated. */
const ENROLL_MIN_SPEECH_MS = 2500;

/** A clip whose mean cosine to the others is below this is flagged for re-recording. Provisional. */
const ENROLL_OUTLIER_CUTOFF = 0.6;

/** Max re-record retries per phrase after an outlier flag. */
const ENROLL_OUTLIER_RETRIES = 2;

/** A final pairwise mean below this warns the audio path may be degraded. */
const ENROLL_MATRIX_WARN_MEAN = 0.65;

/** Mean/min over the off-diagonal of the pairwise cosine matrix. */
function pairwiseSummary(embeddings: Float32Array[]): { mean: number; min: number } {
  let sum = 0;
  let count = 0;
  let min = 1;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const s = cosineSimilarity(embeddings[i] as Float32Array, embeddings[j] as Float32Array);
      sum += s;
      count += 1;
      if (s < min) min = s;
    }
  }
  return { mean: count === 0 ? 1 : sum / count, min: count === 0 ? 1 : min };
}

/** Retries per phrase before enrollment aborts. */
const ENROLL_MAX_REPEATS = 3;

export type CommandEnv = {
  controller: VoiceController;
  loadPrefs: () => Promise<{ prefs: VoicePreferences; warning?: string }>;
  savePrefs: (prefs: VoicePreferences) => Promise<void>;
  mutatePrefs: (fn: (prefs: VoicePreferences) => void) => Promise<VoicePreferences>;
  getPrefs: () => VoicePreferences;
  keyPresent: () => boolean;
  keyLast4: () => string | undefined;
  isProvisioned: () => Promise<boolean>;
  ensureModel: (signal: AbortSignal) => Promise<unknown>;
  isVadProvisioned: () => Promise<boolean>;
  ensureVadModel: (signal: AbortSignal) => Promise<string>;
  hasFfmpeg: () => Promise<boolean>;
  hasFfplay: () => Promise<boolean>;
  listDevices: () => Promise<MicDevice[]>;
  listVoices: (key: string) => Promise<VoiceEntry[]>;
  listModels: (key: string) => Promise<string[]>;
  getKey: () => string | undefined;
  getTtsProvider: () => TtsProvider;
  getInworldKey: () => string | undefined;
  inworldKeyPresent: () => boolean;
  inworldKeyLast4: () => string | undefined;
  listInworldVoices: (key: string) => Promise<VoiceEntry[]>;
  runTest: (kind: "mic" | "wake" | "tts" | "stt") => Promise<string>;
  /** Active capture path for speaker audio: "processed" (helper VP) or "raw" (AVFoundation/ffmpeg). Injected from the entry point so it matches the actual source selection (isolation pref + fallback + helper availability), not merely the preference. Absent in older harnesses; commands derive from prefs/voiceIo instead. */
  getSpeakerCapturePath?: () => "raw" | "processed";
  /** Voice-isolation helper state. Absent in older harnesses; commands degrade to prefs-only output. */
  voiceIo?: {
    helperBuilt(): boolean;
    isActive(): boolean;
    hadFallback(): boolean;
    ensureHelper(signal: AbortSignal): Promise<string>;
  };
  /** Push-to-talk hotkey helper state. Absent in older harnesses; setup skips the hotkey build. */
  hotkey?: {
    helperBuilt(): boolean;
    ensureHelper(signal: AbortSignal): Promise<string>;
  };
  /** Owner-voice enrollment and verification. Absent in older harnesses. */
  speaker?: {
    loadProfile(): Promise<SpeakerProfile | undefined>;
    saveProfile(profile: SpeakerProfile): Promise<void>;
    deleteProfile(): Promise<void>;
    ensureModel(signal: AbortSignal): Promise<string>;
    modelCachedPath(): string | undefined;
    createEmbedder(modelPath: string): { embed(pcm: Buffer): Float32Array };
    buildProfile(embeddings: Float32Array[], model: string): SpeakerProfile;
    capturePhrase(
      prompt: string,
      opts: { signal: AbortSignal },
    ): Promise<
      | { status: "ok"; pcm: Buffer; speechMs: number }
      | { status: "too-short"; speechMs: number }
      | { status: "cancelled" }
    >;
  };
};

export type ParsedVoiceCommand =
  | { sub: "status" | "on" | "off" | "setup" | "help" }
  | { sub: "tts" | "autostart" | "send" | "provider" | "isolation" | "speaker"; value?: string }
  | { sub: "model" | "wake" | "sensitivity" | "mic" | "test" | "list" | "id" | "ptt"; value?: string }
  | { sub: "enroll" };

/** Split raw slash args into a subcommand and its remainder. */
export function parseVoiceArgs(args: string): ParsedVoiceCommand {
  const parts = args.trim().split(/\s+/).filter((p) => p.length > 0);
  const head = (parts[0] ?? "").toLowerCase();
  const rest = parts.slice(1).join(" ");
  const value = rest === "" ? undefined : rest;
  switch (head) {
    case "":
    case "status":
      return { sub: "status" };
    case "on":
    case "off":
    case "setup":
    case "help":
      return { sub: head };
    case "tts":
    case "autostart":
    case "send":
    case "provider":
    case "isolation":
    case "speaker":
    case "ptt":
    case "list":
    case "model":
    case "wake":
    case "sensitivity":
    case "mic":
    case "test":
    case "id":
    case "enroll":
      return { sub: head, value };
    default:
      return { sub: "id", value: args.trim() };
  }
}

const SUBCOMMANDS = [
  "status",
  "on",
  "off",
  "setup",
  "tts",
  "voice",
  "model",
  "wake",
  "sensitivity",
  "mic",
  "autostart",
  "send",
  "provider",
  "isolation",
  "enroll",
  "ptt",
  "speaker",
  "test",
  "list",
  "id",
  "help",
];

async function matchVoices(
  list: (key: string) => Promise<VoiceEntry[]>,
  key: string,
  current: string,
): Promise<AutocompleteItem[] | null> {
  let voices: VoiceEntry[];
  try {
    voices = await list(key);
  } catch {
    return null;
  }
  const needle = current.toLowerCase().replace(/^"|"$/g, "");
  return voices
    .filter((v) => v.name.toLowerCase().includes(needle) || v.id.toLowerCase().includes(needle))
    .slice(0, 20)
    .map((v) => ({ value: v.id, label: `${v.name} (…${v.id.slice(-6)})` }));
}

function tokenize(input: string): { tokens: string[]; trailingSpace: boolean } {
  const trailingSpace = /\s$/.test(input);
  const tokens = input.trim().split(/\s+/).filter((t) => t.length > 0);
  return { tokens, trailingSpace };
}

function quoteName(name: string): string {
  return /\s/.test(name) ? `"${name}"` : name;
}

/** Environment needed for completions; provider fields optional so legacy probes keep working. */
export type CompletionEnv = Pick<CommandEnv, "listDevices" | "listVoices" | "listModels" | "getKey"> & {
  getTtsProvider?: () => TtsProvider;
  getInworldKey?: () => string | undefined;
  listInworldVoices?: (key: string) => Promise<VoiceEntry[]>;
};

/** Voice lister and key for the active TTS provider (ElevenLabs when unknown). */
function activeVoiceSource(
  env: CompletionEnv,
): { list: (key: string) => Promise<VoiceEntry[]>; key: string | undefined } {
  if (env.getTtsProvider?.() === "inworld" && env.listInworldVoices) {
    return { list: (key) => (env.listInworldVoices as (key: string) => Promise<VoiceEntry[]>)(key), key: env.getInworldKey?.() };
  }
  return { list: (key) => env.listVoices(key), key: env.getKey() };
}
/**
 * Context-aware completions. Network-backed voice/model listings only run
 * while completing that same subcommand; every other position is local.
 */
export async function getVoiceCompletions(
  argumentPrefix: string,
  env: CompletionEnv,
): Promise<AutocompleteItem[] | null> {
  const { tokens, trailingSpace } = tokenize(argumentPrefix);
  const current = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const head = (tokens[0] ?? "").toLowerCase();
  const completingFirst = tokens.length === 0 || (tokens.length === 1 && !trailingSpace);

  if (completingFirst) {
    const hits = SUBCOMMANDS.filter((s) => s.startsWith(current.toLowerCase()));
    const items = hits.map((value) => ({ value, label: value }));
    const { list, key } = activeVoiceSource(env);
    if (key && !hits.includes(current.toLowerCase())) {
      const voices = await matchVoices(list, key, current);
      if (voices) items.push(...voices);
    }
    return items;
  }

  // Pi replaces the entire argument text with item.value, so values must
  // carry the already-typed tokens ("tts on", not "on" → "/voice on").
  const lead = argumentPrefix.slice(0, argumentPrefix.length - current.length);
  const items = await completeArgumentValue(head, current, env);
  return items?.map((item) => ({ ...item, value: lead + item.value })) ?? null;
}

async function completeArgumentValue(
  head: string,
  current: string,
  env: CompletionEnv,
): Promise<AutocompleteItem[] | null> {
  const completeValues = (options: string[]): AutocompleteItem[] | null => {
    const hits = options.filter((o) => o.toLowerCase().startsWith(current.toLowerCase()));
    return hits.map((value) => ({ value, label: value }));
  };

  switch (head) {
    case "on":
    case "off":
    case "status":
    case "setup":
    case "help":
      return null;
    case "tts":
    case "autostart":
    case "isolation":
      return completeValues(["on", "off"]);
    case "ptt":
      return completeValues(["off", DEFAULT_PUSH_TO_TALK]);
    case "wake":
      return completeValues(["hey-pi", "hi-pi", "both"]);
    case "sensitivity":
      return completeValues(["low", "normal", "high"]);
    case "send":
      return completeValues(["auto", "review"]);
    case "speaker":
      return completeValues([
        "off",
        "low",
        "normal",
        "high",
        "forget",
        "learn on",
        "learn off",
        "that-was-me",
        "reset-learning",
      ]);
    case "provider":
      return completeValues(["inworld", "elevenlabs"]);
    case "test":
      return completeValues(["mic", "wake", "tts", "stt", "speaker"]);
    case "mic": {
      const base = ["list", "default"];
      let devices: MicDevice[] = [];
      try {
        devices = await env.listDevices();
      } catch {
        devices = [];
      }
      const names = devices.map((d) => quoteName(d.name));
      const needle = current.replace(/^"/, "").toLowerCase();
      const hits = [...base, ...names].filter((o) => o.replace(/^"/, "").toLowerCase().startsWith(needle));
      return hits.map((value) => ({ value, label: value }));
    }
    case "list":
    case "id": {
      const { list, key } = activeVoiceSource(env);
      if (!key) return null;
      const voices = await matchVoices(list, key, current);
      return voices;
    }
    case "model": {
      if (env.getTtsProvider?.() === "inworld") return completeValues([...INWORLD_TTS_MODELS]);
      const key = env.getKey();
      let models: string[];
      try {
        models = key ? await env.listModels(key) : [...OFFLINE_TTS_MODELS];
      } catch {
        models = [...OFFLINE_TTS_MODELS];
      }
      return completeValues(models);
    }
    default:
      return null;
  }
}

function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

export type KeySuffix = { present: boolean; last4?: string };

function prefsSummary(
  prefs: VoicePreferences,
  eleven: KeySuffix,
  inworld: KeySuffix,
): string {
  const mic = prefs.mic.kind === "default" ? "default" : prefs.mic.name;
  const provider = ttsProviderOf(prefs);
  const voice = resolveTtsVoiceId(prefs);
  const keyLine = (label: string, k: KeySuffix): string =>
    `  ${label} key: ${k.present ? `present ••••${k.last4 ?? "????"}` : "missing"}`;
  return [
    "voice status:",
    `  mic: ${mic}`,
    `  wake: ${prefs.wake}`,
    `  sensitivity: ${prefs.sensitivity}`,
    `  tts: ${prefs.tts ? "on" : "off"}${prefs.tts && provider === "elevenlabs" && !prefs.voiceId ? " (no voice selected)" : ""}`,
    `  provider: ${provider}`,
    `  voice: ${voice ?? "(none)"}`,
    `  tts model: ${resolveTtsModelId(prefs)}`,
    `  autostart: ${prefs.autostart ? "on" : "off"}`,
    `  send mode: ${prefs.sendMode}`,
    `  isolation: ${prefs.isolation ? "on" : "off"}`,
    `  speaker check: ${prefs.speakerCheck}${prefs.speakerCheck === "off" ? " (off by default, experimental)" : ""}`,
    `  push-to-talk: ${prefs.pushToTalk ?? DEFAULT_PUSH_TO_TALK}`,
    keyLine("elevenlabs", eleven),
    keyLine("inworld", inworld),
  ].join("\n");
}

/** Execute one parsed `/voice` invocation. Preference changes persist. */

type EnrollmentSession = { abort: AbortController };

let activeEnrollment: EnrollmentSession | null = null;

/** Cancel a running guided enrollment, if any. Wired into `/voice off`. */
export function cancelVoiceEnrollment(): void {
  activeEnrollment?.abort.abort();
  activeEnrollment = null;
}

function describeIsolation(env: CommandEnv): string {
  const prefs = env.getPrefs();
  const base = `isolation: ${prefs.isolation ? "on" : "off"}`;
  const io = env.voiceIo;
  if (!io) return base;
  const built = io.helperBuilt() ? "helper built" : "helper not built (run /voice setup)";
  const route = !prefs.isolation ? "ffmpeg/ffplay" : io.hadFallback() ? "ffmpeg/ffplay (helper fallback)" : io.isActive() ? "helper active" : "helper";
  return `${base} (${built}, ${route})`;
}

/**
 * Authoritative in-memory speaker profile.
 *
 * The controller learns in memory and persists debounced, while speaker
 * commands (forget / that-was-me / reset-learning / enroll) write the disk
 * profile directly. Without a single owner, a pending debounced save can
 * resurrect a forgotten profile or overwrite a correction when it flushes
 * later (voice off / shutdown / the post-command flush). Every disk write
 * and every learning update flows through this store: command paths use
 * saveAndSet/clearAndDelete, the controller's setSpeakerProfile maps to
 * setCurrent, and the controller's debounced persist maps to flushDirty,
 * which only writes when the flushed snapshot is still current.
 *
 * Disk operations are serialized through a single queue so a delete
 * always runs after any in-flight save settles. Deletes also bump a
 * generation counter; a save that started under an older generation
 * either skips publishing (when the snapshot is no longer current) or
 * is followed by a delete so a forgotten profile can never come back.
 */
export function createSpeakerStore(persist: {
  save: (profile: SpeakerProfile) => Promise<void>;
  remove: () => Promise<void>;
}): {
  get: () => SpeakerProfile | undefined;
  setCurrent: (profile: SpeakerProfile | undefined) => void;
  saveAndSet: (profile: SpeakerProfile) => Promise<void>;
  clearAndDelete: () => Promise<void>;
  flushDirty: (dirty: SpeakerProfile) => Promise<boolean>;
} {
  let current: SpeakerProfile | undefined;
  let generation = 0;
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    get: () => current,
    setCurrent: (profile) => {
      current = profile;
    },
    saveAndSet: (profile) => {
      current = profile;
      const seen = generation;
      return enqueue(async () => {
        await persist.save(profile);
        if (seen !== generation && current === undefined) {
          await persist.remove();
        }
      });
    },
    clearAndDelete: () => {
      current = undefined;
      generation += 1;
      return enqueue(() => persist.remove());
    },
    flushDirty: (dirty) => {
      if (current === undefined || current !== dirty) return Promise.resolve(false);
      const seen = generation;
      return enqueue(async () => {
        if (current !== dirty) return false;
        await persist.save(dirty);
        if (seen !== generation && current === undefined) {
          await persist.remove();
        }
        return true;
      });
    },
  };
}

/** Legacy default capture path (voice-processed session audio). Prefer currentSpeakerCapture(env), which reflects the actual selected source. */
export const CURRENT_SPEAKER_CAPTURE = "processed" as const;

/**
 * Capture path of the currently selected session source. Uses the injected
 * getter when present (matches the entry point's actual source selection);
 * otherwise derives from prefs + helper state the same way ensureVoiceIo
 * does: processed only when isolation is on, the helper is built, and no
 * fallback has occurred. Legacy profiles with capture undefined stay silent.
 */
export function currentSpeakerCapture(env: CommandEnv): "raw" | "processed" {
  if (env.getSpeakerCapturePath) return env.getSpeakerCapturePath();
  const prefs = env.getPrefs();
  const io = env.voiceIo;
  if (!prefs.isolation) return "raw";
  if (io && (io.hadFallback() || !io.helperBuilt())) return "raw";
  return "processed";
}

/**
 * Fixed ~4 s test sentence. Root cause of the old always-failing test:
 * capture needs >= 2.5 s of VAD speech (same floor as enrollment and the
 * gate), but the prompt asked for "one short phrase", so normal speech
 * came back too-short and the test reported a generic "no usable speech
 * captured" with no speech ms. The test now asks for ~4 s up front and
 * reports the captured speech ms on a short take.
 */
const SPEAKER_TEST_PHRASE =
  "Pack my box with five dozen liquor jugs before the delivery truck leaves the warehouse this afternoon";

/** Current push-to-talk combo and listener state for `/voice ptt` and status. */
function describePushToTalk(env: CommandEnv): string {
  const prefs = env.getPrefs();
  const combo = typeof prefs.pushToTalk === "string" ? prefs.pushToTalk : DEFAULT_PUSH_TO_TALK;
  if (combo === "off") return "push-to-talk: off";
  let label = combo;
  try {
    label = parseHotkeyCombo(combo).label;
  } catch {
    // Stored value predates validation; show it raw.
  }
  const listening = typeof env.controller.getPhase === "function" ? env.controller.getPhase() !== "off" : true;
  return `push-to-talk: ${label} — hold to talk, release to send (${listening ? "listening" : "not listening"})`;
}

async function describeSpeaker(env: CommandEnv): Promise<string> {
  const prefs = env.getPrefs();
  const sp = env.speaker;
  if (!sp) return `speaker: ${prefs.speakerCheck}, learning ${prefs.speakerLearn ?? true ? "on" : "off"} (unavailable)`;
  const profile = await sp.loadProfile().catch(() => undefined);
  if (!profile) return `speaker: ${prefs.speakerCheck}, learning ${prefs.speakerLearn ?? true ? "on" : "off"} (not enrolled — run /voice enroll)`;
  const threshold = speakerThresholdFor(profile.suggestedThreshold, prefs.speakerCheck);
  const modelNote = sp.modelCachedPath() ? "" : "; model missing, check is off";
  const captureNote =
    profile.capture !== undefined && profile.capture !== currentSpeakerCapture(env)
      ? `; capture ${profile.capture} vs current ${currentSpeakerCapture(env)} — re-enroll for best accuracy`
      : "";
  return `speaker: ${prefs.speakerCheck}, learning ${prefs.speakerLearn ?? true ? "on" : "off"}, enrolled ${profile.enrolledAt}, learned ${learnedCount(profile)}/${LEARN.maxLearned}, threshold ${threshold.toFixed(2)}${modelNote}${captureNote}`;
}

async function runSpeakerTest(ctx: CommandCtx, env: CommandEnv): Promise<void> {
  const sp = env.speaker;
  if (!sp) {
    ctx.notify("Speaker check is unavailable in this session.", "warning");
    return;
  }
  const prefs = env.getPrefs();
  const profile = await sp.loadProfile().catch(() => undefined);
  if (!profile || prefs.speakerCheck === "off") {
    ctx.notify("Speaker check is off (no profile enrolled).", "info");
    return;
  }
  const modelPath = sp.modelCachedPath();
  if (!modelPath) {
    ctx.notify("Speaker check is off: model missing (run /voice setup).", "warning");
    return;
  }
  ctx.notify(`Speaker test: read aloud (~4 s) — "${SPEAKER_TEST_PHRASE}"`, "info");
  const capture = await sp.capturePhrase(SPEAKER_TEST_PHRASE, { signal: new AbortController().signal });
  if (capture.status === "cancelled") {
    ctx.notify("Speaker test cancelled.", "warning");
    return;
  }
  if (capture.status !== "ok") {
    ctx.notify(
      `Speaker test: only ${Math.round(capture.speechMs)} ms of speech captured — read a longer phrase (~4 s) and try again.`,
      "warning",
    );
    return;
  }
  const embedder = sp.createEmbedder(modelPath);
  const score = scoreSample(profile, embedder.embed(capture.pcm));
  const threshold = speakerThresholdFor(profile.suggestedThreshold, prefs.speakerCheck);
  const decision = score >= threshold ? "accept" : "reject";
  ctx.notify(
    `speaker test: score ${score.toFixed(2)} vs threshold ${threshold.toFixed(2)} (${prefs.speakerCheck}) — ${decision} (nothing submitted, speech ${Math.round(capture.speechMs)} ms)`,
    "info",
  );
}

/** Learn the last rejected utterance as the owner's voice (explicit correction). */
async function runSpeakerCorrection(ctx: CommandCtx, env: CommandEnv): Promise<void> {
  const sp = env.speaker;
  if (!sp) {
    ctx.notify("Speaker corrections are unavailable in this session.", "warning");
    return;
  }
  const ctrl = env.controller as unknown as {
    getSpeakerCorrectionCandidate?: () => unknown;
    clearSpeakerCorrectionCandidate?: () => void;
  };
  const candidate = ctrl.getSpeakerCorrectionCandidate?.() as Float32Array | undefined;
  if (!candidate) {
    ctx.notify("Nothing recent to learn from: no rejected utterance in the last 2 minutes.", "info");
    return;
  }
  const profile = await sp.loadProfile().catch(() => undefined);
  if (!profile) {
    ctx.notify("Speaker profile not enrolled — run /voice enroll first.", "warning");
    return;
  }
  const result = addCorrection(profile, candidate);
  ctrl.clearSpeakerCorrectionCandidate?.();
  if (!result.adapted) {
    ctx.notify("That sample is too different from your enrollment — nothing learned.", "warning");
    return;
  }
  await sp.saveProfile(result.profile);
  ctx.notify(
    `Learned that sample as your voice (learned ${learnedCount(result.profile)}/${LEARN.maxLearned}).`,
    "info",
  );
}

/** Drop learned samples, keeping the enrollment anchors. */
async function runSpeakerResetLearning(ctx: CommandCtx, env: CommandEnv): Promise<void> {
  const sp = env.speaker;
  if (!sp) {
    ctx.notify("Speaker check is unavailable in this session.", "warning");
    return;
  }
  const profile = await sp.loadProfile().catch(() => undefined);
  if (!profile) {
    ctx.notify("Speaker profile not enrolled — run /voice enroll first.", "warning");
    return;
  }
  const before = learnedCount(profile);
  await sp.saveProfile(resetLearning(profile));
  ctx.notify(`Reset learning: cleared ${before} learned sample(s); enrollment anchors kept.`, "info");
}

async function runEnrollment(ctx: CommandCtx, env: CommandEnv): Promise<void> {
  const sp = env.speaker;
  if (!sp) {
    ctx.notify("Enrollment is unavailable in this session.", "warning");
    return;
  }
  if (activeEnrollment) {
    ctx.notify("Enrollment already in progress.", "warning");
    return;
  }
  const session: EnrollmentSession = { abort: new AbortController() };
  activeEnrollment = session;
  // Snapshot the actual capture source at enrollment start so the saved
  // profile metadata is stable even if the source selection changes
  // mid-enrollment (isolation toggles are rejected while active, but the
  // helper fallback state could still flip under us).
  // Every throwable operation after claiming activeEnrollment (capture-path
  // snapshot, phase check, controller.stop, and the enrollment body) runs
  // inside this try so a throw still clears activeEnrollment in `finally`
  // and never wedges later isolation changes. Stop/start errors propagate
  // (no broad catch) — cleanup still runs.
  let enrollmentCapture: "raw" | "processed";
  let wasListening = false;
  try {
    enrollmentCapture = currentSpeakerCapture(env);
    wasListening =
      (env.controller as { getPhase?: () => string }).getPhase?.() !== "off";
    await env.controller.stop();
    let modelPath: string;
    try {
      modelPath = await sp.ensureModel(session.abort.signal);
    } catch (err) {
      if (session.abort.signal.aborted) ctx.notify("Enrollment cancelled.", "warning");
      else ctx.notify(`Enrollment failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }
    const embedder = sp.createEmbedder(modelPath);
    const count = Math.min(ENROLL_CLIP_COUNT, ENROLL_PHRASES.length);
    const phrases = ENROLL_PHRASES.slice(0, count);
    const embeddings: Float32Array[] = [];
    let index = 0;
    const repeats = new Map<number, number>();
    const outlierRetries = new Map<number, number>();
    const meanCosineTo = (candidate: Float32Array, others: Float32Array[]): number => {
      if (others.length === 0) return 1;
      let sum = 0;
      for (const other of others) sum += cosineSimilarity(candidate, other);
      return sum / others.length;
    };
    while (index < phrases.length) {
      if (session.abort.signal.aborted) {
        ctx.notify("Enrollment cancelled.", "warning");
        return;
      }
      const phrase = phrases[index] as string;
      ctx.notify(`Enroll ${index + 1}/${phrases.length}: read aloud — "${phrase}"`, "info");
      let capture: Awaited<ReturnType<NonNullable<CommandEnv["speaker"]>["capturePhrase"]>>;
      try {
        capture = await sp.capturePhrase(phrase, { signal: session.abort.signal });
      } catch {
        if (session.abort.signal.aborted) ctx.notify("Enrollment cancelled.", "warning");
        else ctx.notify("Enrollment capture failed.", "error");
        return;
      }
      if (capture.status === "cancelled" || session.abort.signal.aborted) {
        ctx.notify("Enrollment cancelled.", "warning");
        return;
      }
      if (capture.status === "too-short") {
        const seen = (repeats.get(index) ?? 0) + 1;
        repeats.set(index, seen);
        if (seen > ENROLL_MAX_REPEATS) {
          ctx.notify("Enrollment aborted: phrase too short three times.", "warning");
          return;
        }
        ctx.notify(`Too short — please repeat: "${phrase}"`, "warning");
        continue;
      }
      // Enrollment audio stays in memory; it is embedded and never written to disk.
      const candidate = embedder.embed(capture.pcm);
      if (embeddings.length >= 2) {
        const mean = meanCosineTo(candidate, embeddings);
        ctx.notify(`Clip ${embeddings.length + 1} mean similarity to the others: ${mean.toFixed(2)}.`, "info");
        if (mean < ENROLL_OUTLIER_CUTOFF) {
          const seen = (outlierRetries.get(index) ?? 0) + 1;
          outlierRetries.set(index, seen);
          if (seen <= ENROLL_OUTLIER_RETRIES) {
            ctx.notify(
              `Clip ${embeddings.length + 1} looks different from the others (mean similarity ${mean.toFixed(2)} < ${ENROLL_OUTLIER_CUTOFF.toFixed(2)}) — please re-record: "${phrase}"`,
              "warning",
            );
            continue;
          }
          ctx.notify(
            `Clip ${embeddings.length + 1} still differs (mean similarity ${mean.toFixed(2)}); keeping it after ${ENROLL_OUTLIER_RETRIES} re-tries.`,
            "warning",
          );
        }
      }
      embeddings.push(candidate);
      index += 1;
    }
    const minKept = Math.max(MIN_ENROLL_CLIPS, ENROLL_MIN_KEPT);
    if (embeddings.length < minKept) {
      ctx.notify(`Enrollment needs at least ${minKept} clips; got ${embeddings.length}.`, "warning");
      return;
    }
    const pairwise = pairwiseSummary(embeddings);
    const profile = sp.buildProfile(embeddings, modelPath);
    // Tag the profile with the source actually used for this enrollment
    // session (helper VP vs raw fallback); the live gate compares against
    // the same current-source value.
    profile.capture = enrollmentCapture;
    await sp.saveProfile(profile);
    const scores = profile.enrollScores.map((s) => s.toFixed(2)).join(", ");
    const effective = speakerThresholdFor(profile.suggestedThreshold, env.getPrefs().speakerCheck);
    ctx.notify(
      `Enrolled ${embeddings.length} clips. Scores: ${scores}. Threshold: suggested ${profile.suggestedThreshold.toFixed(2)} (effective ${effective.toFixed(2)} at ${env.getPrefs().speakerCheck}).`,
      "info",
    );
    ctx.notify(
      `Pairwise clip similarity: mean ${pairwise.mean.toFixed(2)}, min ${pairwise.min.toFixed(2)} (${embeddings.length} clips).`,
      "info",
    );
    if (pairwise.mean < ENROLL_MATRIX_WARN_MEAN) {
      ctx.notify(
        `Enrollment quality is low (mean ${pairwise.mean.toFixed(2)} < ${ENROLL_MATRIX_WARN_MEAN.toFixed(2)}): the audio path may be degraded. Try re-enrolling in a quieter spot with a headset, or run research/speaker-diag/diag.mjs to diagnose.`,
        "warning",
      );
    }
  } finally {
    activeEnrollment = null;
    if (wasListening && !session.abort.signal.aborted) await env.controller.start();
  }
}

/** Execute one parsed `/voice` invocation. Preference changes persist. */
export async function handleVoiceCommand(
  rawArgs: string,
  ctx: CommandCtx,
  env: CommandEnv,
): Promise<void> {
  const parsed = parseVoiceArgs(rawArgs);
  const prefs = env.getPrefs();
  const needKey = (): string | null => {
    const key = env.getKey();
    if (!key) {
      ctx.notify(MISSING_KEY_MESSAGE, "warning");
      return null;
    }
    return key;
  };
  const needTtsKey = (): string | null => {
    if (ttsProviderOf(prefs) === "inworld") {
      const key = env.getInworldKey();
      if (!key) {
        ctx.notify(MISSING_INWORLD_KEY_MESSAGE, "warning");
        return null;
      }
      return key;
    }
    return needKey();
  };

  switch (parsed.sub) {
    case "status": {
      const { warning } = await env.loadPrefs().catch(() => ({ prefs: env.getPrefs(), warning: undefined as string | undefined }));
      if (warning) ctx.notify(warning, "warning");
      ctx.notify(
        prefsSummary(
          env.getPrefs(),
          { present: env.keyPresent(), last4: env.keyLast4() },
          { present: env.inworldKeyPresent(), last4: env.inworldKeyLast4() },
        ),
        "info",
      );
      ctx.notify(describeIsolation(env), "info");
      ctx.notify(await describeSpeaker(env), "info");
      return;
    }
    case "on": {
      if (!needKey()) return;
      try {
        await env.ensureModel(new AbortController().signal);
      } catch (err) {
        ctx.notify(`Model setup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      await env.controller.start();
      return;
    }
    case "off": {
      cancelVoiceEnrollment();
      await env.controller.stop();
      env.controller.cancelSpeech();
      return;
    }
    case "setup": {
      const lines: string[] = [];
      lines.push(`ffmpeg: ${((await env.hasFfmpeg()) ? "found" : "missing — install ffmpeg")}`);
      lines.push(`ffplay: ${((await env.hasFfplay()) ? "found" : "missing — install ffmpeg (includes ffplay)")}`);
      lines.push(`key: ${env.keyPresent() ? "present" : "missing — " + MISSING_KEY_MESSAGE}`);
      try {
        await env.ensureModel(new AbortController().signal);
        lines.push("wake model: provisioned");
      } catch (err) {
        lines.push(`wake model: failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await env.ensureVadModel(new AbortController().signal);
        lines.push("vad model: provisioned");
      } catch (err) {
        lines.push(`vad model: failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (env.voiceIo) {
        try {
          const helperPath = await env.voiceIo.ensureHelper(new AbortController().signal);
          lines.push(`voice isolation helper: built (${helperPath})`);
        } catch (err) {
          lines.push(`voice isolation helper: failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (env.speaker) {
        try {
          await env.speaker.ensureModel(new AbortController().signal);
          lines.push("speaker model: provisioned");
        } catch (err) {
          lines.push(`speaker model: failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (env.hotkey) {
        try {
          const helperPath = await env.hotkey.ensureHelper(new AbortController().signal);
          lines.push(`push-to-talk helper: built (${helperPath})`);
        } catch (err) {
          lines.push(`push-to-talk helper: failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      lines.push("mic permission: grant the terminal app Microphone access in System Settings > Privacy & Security > Microphone, then restart.");
      lines.push("setup does not enable the mic; run /voice on when ready.");
      ctx.notify(lines.join("\n"), "info");
      return;
    }
    case "help": {
      ctx.notify(
        [
          "/voice status|on|off|setup|send|help",
          "/voice provider [inworld|elevenlabs] — show or select the TTS provider (default inworld; STT stays ElevenLabs)",
          "/voice tts on|off — session speech, requires the active provider key (+ ElevenLabs voice)",
          "/voice list — list active-provider voices (needs that provider's key)",
          "/voice <voice-id> — select the active-provider voice (saved, no key needed; Inworld ids are names like Ashley)",
          "/voice id <id> — select the active-provider voice by id (explicit form)",
          "/voice model [id] — list or select the active-provider TTS model",
          "/voice wake hey-pi|hi-pi|both",
          "/voice sensitivity low|normal|high",
          "/voice mic list|default|<name> — names with spaces may be quoted",
          "/voice autostart on|off",
          '/voice send auto|review — review: dictation goes to the editor; Enter or "send to pi" submits; "hey pi, send" also works',
          "/voice isolation on|off — echo-cancelling helper capture + playback (bare shows helper state)",
          "/voice ptt [off|<combo>] — hold-to-talk hotkey (default ctrl+option+space); bare shows the current combo",
          "/voice enroll — guided owner-voice enrollment (cancellable with /voice off)",
          "/voice speaker off|low|normal|high|forget|learn on|off|that-was-me|reset-learning — strictness, delete the voice profile, toggle learning, learn the last rejection as your voice, or clear learned samples",
          "/voice test mic|wake|tts|stt|speaker — tts is billable; speaker submits nothing",
          "Privacy: post-wake audio goes to ElevenLabs (Scribe); assistant prose goes to Inworld (TTS). Wake detection is local.",
        ].join("\n"),
        "info",
      );
      return;
    }
    case "tts": {
      const value = parsed.value?.toLowerCase();
      if (value !== "on" && value !== "off") {
        ctx.notify("Usage: /voice tts on|off", "warning");
        return;
      }
      if (value === "on") {
        const key = needTtsKey();
        if (!key) return;
        if (ttsProviderOf(env.getPrefs()) === "elevenlabs" && !env.getPrefs().voiceId) {
          ctx.notify("Select a voice first: /voice <voice-id>.", "warning");
          return;
        }
      }
      const next = await env.mutatePrefs((p) => {
        p.tts = value === "on";
      });
      if (value === "off") env.controller.cancelSpeech();
      ctx.notify(`tts ${next.tts ? "on" : "off"}`, "info");
      return;
    }
    case "autostart": {
      const value = parsed.value?.toLowerCase();
      if (value !== "on" && value !== "off") {
        ctx.notify("Usage: /voice autostart on|off", "warning");
        return;
      }
      const next = await env.mutatePrefs((p) => {
        p.autostart = value === "on";
      });
      ctx.notify(`autostart ${next.autostart ? "on" : "off"}`, "info");
      return;
    }
    case "send": {
      const value = parsed.value?.toLowerCase();
      if (!value) {
        ctx.notify(`send mode: ${env.getPrefs().sendMode}`, "info");
        return;
      }
      if (value !== "auto" && value !== "review") {
        ctx.notify("Usage: /voice send auto|review", "warning");
        return;
      }
      const next = await env.mutatePrefs((p) => {
        p.sendMode = value;
      });
      await env.controller.restartIfListening();
      ctx.notify(`send mode: ${next.sendMode}`, "info");
      return;
    }
    case "provider": {
      const value = parsed.value?.toLowerCase();
      if (!value) {
        ctx.notify(`provider: ${ttsProviderOf(env.getPrefs())}`, "info");
        return;
      }
      if (value !== "inworld" && value !== "elevenlabs") {
        ctx.notify("Usage: /voice provider [inworld|elevenlabs]", "warning");
        return;
      }
      const next = await env.mutatePrefs((p) => {
        p.ttsProvider = value;
      });
      ctx.notify(`provider: ${next.ttsProvider}`, "info");
      return;
    }
    case "list":
    case "id": {
      const inworld = ttsProviderOf(env.getPrefs()) === "inworld";
      if (!parsed.value || parsed.sub === "list") {
        const key = inworld ? needTtsKey() : needKey();
        if (!key) return;
        let voices: VoiceEntry[];
        try {
          voices = inworld ? await env.listInworldVoices(key) : await env.listVoices(key);
        } catch (err) {
          ctx.notify(`Voice list failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        const lines = voices.slice(0, 10).map((v) => `  ${v.name} — ${v.id}`);
        ctx.notify(["Select with /voice <voice-id>:", ...lines].join("\n"), "info");
        return;
      }
      const id = unquote(parsed.value);
      if (inworld) {
        const next = await env.mutatePrefs((p) => {
          p.inworldVoiceId = id;
        });
        ctx.notify(`voice: ${next.inworldVoiceId}`, "info");
        return;
      }
      const next = await env.mutatePrefs((p) => {
        p.voiceId = id;
      });
      ctx.notify(`voice: ${next.voiceId}`, "info");
      return;
    }
    case "model": {
      const inworld = ttsProviderOf(env.getPrefs()) === "inworld";
      if (!parsed.value) {
        if (inworld) {
          ctx.notify(`Select with /voice model <id>. Known: ${INWORLD_TTS_MODELS.join(", ")}`, "info");
          return;
        }
        let models: string[];
        try {
          const key = env.getKey();
          models = key ? await env.listModels(key) : [...OFFLINE_TTS_MODELS];
        } catch {
          models = [...OFFLINE_TTS_MODELS];
        }
        ctx.notify(`Select with /voice model <id>. Known: ${models.join(", ")}`, "info");
        return;
      }
      const id = unquote(parsed.value);
      if (inworld) {
        const next = await env.mutatePrefs((p) => {
          p.inworldModel = id;
        });
        ctx.notify(`tts model: ${next.inworldModel}`, "info");
        return;
      }
      const next = await env.mutatePrefs((p) => {
        p.ttsModel = id;
      });
      ctx.notify(`tts model: ${next.ttsModel}`, "info");
      return;
    }
    case "wake": {
      const value = parsed.value?.toLowerCase();
      if (value !== "hey-pi" && value !== "hi-pi" && value !== "both") {
        ctx.notify("Usage: /voice wake hey-pi|hi-pi|both", "warning");
        return;
      }
      await env.mutatePrefs((p) => {
        p.wake = value;
      });
      await env.controller.restartIfListening();
      ctx.notify(`wake: ${value}`, "info");
      return;
    }
    case "sensitivity": {
      const value = parsed.value?.toLowerCase();
      if (value !== "low" && value !== "normal" && value !== "high") {
        ctx.notify("Usage: /voice sensitivity low|normal|high", "warning");
        return;
      }
      await env.mutatePrefs((p) => {
        p.sensitivity = value;
      });
      await env.controller.restartIfListening();
      ctx.notify(`sensitivity: ${value}`, "info");
      return;
    }
    case "mic": {
      const value = parsed.value;
      if (!value || value.toLowerCase() === "list") {
        let devices: MicDevice[];
        try {
          devices = await env.listDevices();
        } catch (err) {
          ctx.notify(`Mic list failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        const current = env.getPrefs().mic;
        const lines = devices.map(
          (d) => `  ${quoteName(d.name)}${current.kind === "named" && current.name === d.name ? " (current)" : ""}`,
        );
        ctx.notify(["Microphones:", ...lines, "Select with /voice mic default|<name>."].join("\n"), "info");
        return;
      }
      const name = unquote(value);
      if (name.toLowerCase() === "default") {
        await env.mutatePrefs((p) => {
          p.mic = { kind: "default" };
        });
        await env.controller.restartIfListening();
        ctx.notify("mic: default", "info");
        return;
      }
      let devices: MicDevice[];
      try {
        devices = await env.listDevices();
      } catch (err) {
        ctx.notify(`Mic list failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      const matches = devices.filter((d) => d.name === name);
      if (matches.length > 1) {
        ctx.notify(`Multiple microphones named "${name}"; rename one in Audio MIDI Setup.`, "warning");
        return;
      }
      if (matches.length === 0) {
        ctx.notify(`Microphone "${name}" not found; keeping the current selection.`, "warning");
        return;
      }
      await env.mutatePrefs((p) => {
        p.mic = { kind: "named", name };
      });
      await env.controller.restartIfListening();
      ctx.notify(`mic: ${name}`, "info");
      return;
    }
    case "isolation": {
      const value = parsed.value?.toLowerCase();
      if (value === undefined) {
        ctx.notify(describeIsolation(env), "info");
        return;
      }
      if (value !== "on" && value !== "off") {
        ctx.notify("Usage: /voice isolation on|off", "warning");
        return;
      }
      if (activeEnrollment) {
        ctx.notify("Isolation cannot be changed while enrollment is in progress — wait until enrollment completes or cancel with /voice off.", "warning");
        return;
      }
      await env.mutatePrefs((prefs) => {
        prefs.isolation = value === "on";
      });
      await env.controller.restartIfListening();
      ctx.notify(describeIsolation(env), "info");
      return;
    }
    case "enroll": {
      await runEnrollment(ctx, env);
      return;
    }
    case "speaker": {
      const value = parsed.value?.toLowerCase();
      if (value === undefined) {
        ctx.notify(await describeSpeaker(env), "info");
        return;
      }
      if (value === "forget") {
        await env.speaker?.deleteProfile().catch(() => undefined);
        ctx.notify("Speaker profile deleted.", "info");
        return;
      }
      if (value === "learn" || value === "learn on" || value === "learn off") {
        if (value === "learn") {
          ctx.notify(`speaker learning: ${env.getPrefs().speakerLearn ?? true ? "on" : "off"}`, "info");
          return;
        }
        const next = await env.mutatePrefs((prefs) => {
          prefs.speakerLearn = value === "learn on";
        });
        ctx.notify(`speaker learning: ${next.speakerLearn ? "on" : "off"}`, "info");
        return;
      }
      if (value === "that-was-me") {
        await runSpeakerCorrection(ctx, env);
        return;
      }
      if (value === "reset-learning") {
        await runSpeakerResetLearning(ctx, env);
        return;
      }
      if (value !== "off" && value !== "low" && value !== "normal" && value !== "high") {
        ctx.notify("Usage: /voice speaker off|low|normal|high|forget|learn on|off|that-was-me|reset-learning", "warning");
        return;
      }
      await env.mutatePrefs((prefs) => {
        prefs.speakerCheck = value;
      });
      await env.controller.restartIfListening();
      ctx.notify(await describeSpeaker(env), "info");
      return;
    }
    case "ptt": {
      const value = parsed.value;
      if (value === undefined) {
        ctx.notify(describePushToTalk(env), "info");
        return;
      }
      if (value.toLowerCase() === "off") {
        const next = await env.mutatePrefs((prefs) => {
          prefs.pushToTalk = "off";
        });
        void next;
        ctx.notify("push-to-talk: off", "info");
        return;
      }
      let label: string;
      try {
        label = parseHotkeyCombo(value).label;
      } catch (err) {
        ctx.notify(err instanceof Error ? err.message : String(err), "warning");
        return;
      }
      const next = await env.mutatePrefs((prefs) => {
        prefs.pushToTalk = value.trim().toLowerCase();
      });
      void next;
      ctx.notify(`push-to-talk: ${label} — hold to talk, release to send`, "info");
      return;
    }
    case "test": {
      const value = parsed.value?.toLowerCase();
      if (value !== "mic" && value !== "wake" && value !== "tts" && value !== "stt" && value !== "speaker") {
        ctx.notify("Usage: /voice test mic|wake|tts|stt|speaker", "warning");
        return;
      }
      if (value === "speaker") {
        await runSpeakerTest(ctx, env);
        return;
      }
      if (value === "tts") {
        const key = needTtsKey();
        if (!key) return;
        if (ttsProviderOf(env.getPrefs()) === "elevenlabs" && !env.getPrefs().voiceId) {
          ctx.notify("Select a voice first: /voice <voice-id>.", "warning");
          return;
        }
        ctx.notify("Note: /voice test tts is billable.", "warning");
      }
      if (value === "stt") {
        const key = needKey();
        if (!key) return;
        ctx.notify("stt test: speak now (up to 8 s)…", "info");
      }
      if (value === "wake") ctx.notify("Listening up to ~10 s for the wake word; nothing is submitted.", "info");
      try {
        const result = await env.runTest(value);
        ctx.notify(result, "info");
      } catch (err) {
        ctx.notify(`Test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
      return;
    }
  }
}
