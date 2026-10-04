import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_PREFERENCES, type TtsProvider, type VoicePreferences } from "./contracts.ts";
import { DEFAULT_INWORLD_MODEL, DEFAULT_INWORLD_VOICE } from "./inworld-tts.ts";
import { DEFAULT_TTS_MODEL } from "./tts.ts";

const STATE_REL = join("Library", "Application Support", "pi-voice", "state.json");
const API_KEY_ENV = "ELEVENLABS_API_KEY";
/** Inworld key: TTS only. STT and wake gating keep using ELEVENLABS_API_KEY. */
export const INWORLD_API_KEY_ENV = "INWORLD_API_KEY";

function stateFile(dirOverride?: string): string {
  return dirOverride ? join(dirOverride, "state.json") : join(homedir(), STATE_REL);
}

export function stateDir(dirOverride?: string): string {
  return dirname(stateFile(dirOverride));
}

function withDefaults(raw: unknown): VoicePreferences {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    version: 1,
    ttsProvider: r["ttsProvider"] === "inworld" || r["ttsProvider"] === "elevenlabs" ? r["ttsProvider"] : DEFAULT_PREFERENCES.ttsProvider,
    voiceId: typeof r["voiceId"] === "string" ? r["voiceId"] : undefined,
    ttsModel: typeof r["ttsModel"] === "string" && r["ttsModel"].length > 0 ? r["ttsModel"] : DEFAULT_PREFERENCES.ttsModel,
    inworldVoiceId:
      typeof r["inworldVoiceId"] === "string" && r["inworldVoiceId"].length > 0 ? r["inworldVoiceId"] : undefined,
    inworldModel:
      typeof r["inworldModel"] === "string" && r["inworldModel"].length > 0 ? r["inworldModel"] : undefined,
    wake: r["wake"] === "hey-pi" || r["wake"] === "hi-pi" || r["wake"] === "both" ? r["wake"] : DEFAULT_PREFERENCES.wake,
    sensitivity:
      r["sensitivity"] === "low" || r["sensitivity"] === "normal" || r["sensitivity"] === "high"
        ? r["sensitivity"]
        : DEFAULT_PREFERENCES.sensitivity,
    mic:
      typeof r["mic"] === "object" && r["mic"] !== null &&
      (r["mic"] as { kind?: unknown }).kind === "named" &&
      typeof (r["mic"] as { name?: unknown }).name === "string"
        ? { kind: "named", name: (r["mic"] as { name: string }).name }
        : { kind: "default" },
    autostart: typeof r["autostart"] === "boolean" ? r["autostart"] : DEFAULT_PREFERENCES.autostart,
    tts: typeof r["tts"] === "boolean" ? r["tts"] : DEFAULT_PREFERENCES.tts,
    sendMode: r["sendMode"] === "auto" || r["sendMode"] === "review" ? r["sendMode"] : DEFAULT_PREFERENCES.sendMode,
    isolation: typeof r["isolation"] === "boolean" ? r["isolation"] : DEFAULT_PREFERENCES.isolation,
    speakerCheck:
      r["speakerCheck"] === "off" ||
      r["speakerCheck"] === "low" ||
      r["speakerCheck"] === "normal" ||
      r["speakerCheck"] === "high"
        ? r["speakerCheck"]
        : DEFAULT_PREFERENCES.speakerCheck,
  };
}

export type LoadResult = {
  prefs: VoicePreferences;
  warning?: string;
};

/**
 * Load preferences. Never throws: missing file, corrupt JSON, or an
 * unknown schema version falls back to defaults plus a warning string.
 */
export async function loadPreferences(dirOverride?: string): Promise<LoadResult> {
  const file = stateFile(dirOverride);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { prefs: { ...DEFAULT_PREFERENCES } };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { prefs: { ...DEFAULT_PREFERENCES }, warning: `Ignoring corrupt preferences at ${file}; using defaults.` };
  }
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) {
    return { prefs: { ...DEFAULT_PREFERENCES }, warning: `Unknown preferences version in ${file}; using defaults.` };
  }
  return { prefs: withDefaults(raw) };
}

/** Injectable filesystem surface for savePreferences (tests inject a failing chmod). */
export type PreferencesFs = {
  mkdir: typeof mkdir;
  chmod: typeof chmod;
  writeFile: typeof writeFile;
  rename: typeof rename;
};

const defaultPreferencesFs: PreferencesFs = { mkdir, chmod, writeFile, rename };

/** Save preferences atomically (temp file + rename) with mode 0600. */
export async function savePreferences(
  value: VoicePreferences,
  dirOverride?: string,
  fsOverride?: Partial<PreferencesFs>,
): Promise<void> {
  const fs = { ...defaultPreferencesFs, ...fsOverride };
  const file = stateFile(dirOverride);
  const dir = dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Tighten pre-existing dirs (mkdir mode only applies on creation).
  // A chmod failure must reject: saving into an insecure dir is not an option.
  try {
    await fs.chmod(dir, 0o700);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot secure preferences directory ${dir} with mode 0700: ${detail}`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

export type KeyStatus = {
  present: boolean;
  last4?: string;
};

/** Report API key presence (suffix only; never the key itself). */
export function keyStatus(): KeyStatus {
  const key = process.env[API_KEY_ENV];
  if (!key) return { present: false };
  return { present: true, last4: key.slice(-4) };
}

/** Return the API key or throw with restart guidance. Never logs the key. */
export function requireApiKey(): string {
  const key = process.env[API_KEY_ENV];
  if (!key) throw new Error("Export ELEVENLABS_API_KEY and restart Pi.");
  return key;
}

/** Report Inworld key presence (suffix only; never the key itself). */
export function inworldKeyStatus(): KeyStatus {
  const key = process.env[INWORLD_API_KEY_ENV];
  if (!key) return { present: false };
  return { present: true, last4: key.slice(-4) };
}

/** Return the Inworld key or throw with restart guidance. Never logs the key. */
export function requireInworldKey(): string {
  const key = process.env[INWORLD_API_KEY_ENV];
  if (!key) throw new Error("Export INWORLD_API_KEY and restart Pi.");
  return key;
}

/** Active provider, defaulting to inworld for legacy files. */
export function ttsProviderOf(prefs: VoicePreferences): TtsProvider {
  return prefs.ttsProvider === "elevenlabs" ? "elevenlabs" : "inworld";
}

/** Effective TTS voice id. Inworld always resolves (default voice applies). */
export function resolveTtsVoiceId(prefs: VoicePreferences): string | undefined {
  if (ttsProviderOf(prefs) === "inworld") return prefs.inworldVoiceId ?? DEFAULT_INWORLD_VOICE;
  return prefs.voiceId;
}

/** Effective TTS model id for the active provider. */
export function resolveTtsModelId(prefs: VoicePreferences): string {
  if (ttsProviderOf(prefs) === "inworld") return prefs.inworldModel ?? DEFAULT_INWORLD_MODEL;
  return prefs.ttsModel && prefs.ttsModel.length > 0 ? prefs.ttsModel : DEFAULT_TTS_MODEL;
}

/** API key for the active TTS provider (STT always uses ELEVENLABS_API_KEY). */
export function resolveTtsKey(prefs: VoicePreferences): string | undefined {
  if (ttsProviderOf(prefs) === "inworld") return process.env[INWORLD_API_KEY_ENV];
  return process.env[API_KEY_ENV];
}
