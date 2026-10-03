/**
 * Lane E `/voice` slash surface: subcommand parser, context-aware
 * completions, and the command handler. Pure logic over an injected
 * environment so tests run with fakes (no network, mic, or key).
 */

import type { MicDevice, VoicePreferences } from "./contracts.ts";
import { DEFAULT_TTS_MODEL } from "./tts.ts";
import type { VoiceController } from "./controller.ts";
import { OFFLINE_TTS_MODELS, type VoiceEntry } from "./elevenlabs-api.ts";

export const MISSING_KEY_MESSAGE = "Export ELEVENLABS_API_KEY and restart Pi.";

export type AutocompleteItem = { value: string; label: string; description?: string };

export type CommandCtx = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
};

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
  runTest: (kind: "mic" | "wake" | "tts" | "stt") => Promise<string>;
};

export type ParsedVoiceCommand =
  | { sub: "status" | "on" | "off" | "setup" | "help" }
  | { sub: "tts" | "autostart" | "send"; value?: string }
  | { sub: "model" | "wake" | "sensitivity" | "mic" | "test" | "list" | "id"; value?: string };

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
    case "list":
    case "model":
    case "wake":
    case "sensitivity":
    case "mic":
    case "test":
    case "id":
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
  "test",
  "list",
  "id",
  "help",
];

async function matchVoices(
  env: Pick<CommandEnv, "listVoices">,
  key: string,
  current: string,
): Promise<AutocompleteItem[] | null> {
  let voices: VoiceEntry[];
  try {
    voices = await env.listVoices(key);
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

/**
 * Context-aware completions. Network-backed voice/model listings only run
 * while completing that same subcommand; every other position is local.
 */
export async function getVoiceCompletions(
  argumentPrefix: string,
  env: Pick<CommandEnv, "listDevices" | "listVoices" | "listModels" | "getKey">,
): Promise<AutocompleteItem[] | null> {
  const { tokens, trailingSpace } = tokenize(argumentPrefix);
  const current = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const prev = trailingSpace ? tokens[tokens.length - 1] : tokens[tokens.length - 2];
  const head = (tokens[0] ?? "").toLowerCase();
  const completingFirst = tokens.length === 0 || (tokens.length === 1 && !trailingSpace);

  if (completingFirst) {
    const hits = SUBCOMMANDS.filter((s) => s.startsWith(current.toLowerCase()));
    const items = hits.map((value) => ({ value, label: value }));
    const key = env.getKey();
    if (key && !hits.includes(current.toLowerCase())) {
      const voices = await matchVoices(env, key, current);
      if (voices) items.push(...voices);
    }
    return items;
  }

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
      if (prev === head || (trailingSpace && tokens.length === 1)) return completeValues(["on", "off"]);
      return completeValues(["on", "off"]);
    case "wake":
      return completeValues(["hey-pi", "hi-pi", "both"]);
    case "sensitivity":
      return completeValues(["low", "normal", "high"]);
    case "send":
      return completeValues(["auto", "review"]);
    case "test":
      return completeValues(["mic", "wake", "tts", "stt"]);
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
      const key = env.getKey();
      if (!key) return null;
      const voices = await matchVoices(env, key, current);
      return voices;
    }
    case "model": {
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

function prefsSummary(prefs: VoicePreferences, keyPresent: boolean, last4: string | undefined): string {
  const mic = prefs.mic.kind === "default" ? "default" : prefs.mic.name;
  return [
    "voice status:",
    `  mic: ${mic}`,
    `  wake: ${prefs.wake}`,
    `  sensitivity: ${prefs.sensitivity}`,
    `  tts: ${prefs.tts ? "on" : "off"}${prefs.tts && !prefs.voiceId ? " (no voice selected)" : ""}`,
    `  voice: ${prefs.voiceId ?? "(none)"}`,
    `  tts model: ${prefs.ttsModel ?? DEFAULT_TTS_MODEL}`,
    `  autostart: ${prefs.autostart ? "on" : "off"}`,
    `  send mode: ${prefs.sendMode}`,
    `  key: ${keyPresent ? `present ••••${last4 ?? "????"}` : "missing"}`,
  ].join("\n");
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

  switch (parsed.sub) {
    case "status": {
      const { warning } = await env.loadPrefs().catch(() => ({ prefs: env.getPrefs(), warning: undefined as string | undefined }));
      if (warning) ctx.notify(warning, "warning");
      ctx.notify(prefsSummary(env.getPrefs(), env.keyPresent(), env.keyLast4()), "info");
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
      lines.push("mic permission: grant the terminal app Microphone access in System Settings > Privacy & Security > Microphone, then restart.");
      lines.push("setup does not enable the mic; run /voice on when ready.");
      ctx.notify(lines.join("\n"), "info");
      return;
    }
    case "help": {
      ctx.notify(
        [
          "/voice status|on|off|setup|send|help",
          "/voice tts on|off — session speech, requires key + voice",
          "/voice list — list ElevenLabs voices (needs key)",
          "/voice <voice-id> — select ElevenLabs voice (saved, no key needed)",
          "/voice id <id> — select ElevenLabs voice by id",
          "/voice model [id] — list or select TTS model",
          "/voice wake hey-pi|hi-pi|both",
          "/voice sensitivity low|normal|high",
          "/voice mic list|default|<name> — names with spaces may be quoted",
          "/voice autostart on|off",
          '/voice send auto|review — review: dictation goes to the editor; Enter or "send to pi" submits; "hey pi, send" also works',
          "/voice test mic|wake|tts|stt — tts is billable",
          "Privacy: post-wake audio and assistant prose go to ElevenLabs; wake detection is local.",
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
        const key = needKey();
        if (!key) return;
        if (!env.getPrefs().voiceId) {
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
    case "list":
    case "id": {
      if (!parsed.value || parsed.sub === "list") {
        const key = needKey();
        if (!key) return;
        let voices: VoiceEntry[];
        try {
          voices = await env.listVoices(key);
        } catch (err) {
          ctx.notify(`Voice list failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          return;
        }
        const lines = voices.slice(0, 10).map((v) => `  ${v.name} — ${v.id}`);
        ctx.notify(["Select with /voice <voice-id>:", ...lines].join("\n"), "info");
        return;
      }
      const id = unquote(parsed.value);
      const next = await env.mutatePrefs((p) => {
        p.voiceId = id;
      });
      ctx.notify(`voice: ${next.voiceId}`, "info");
      return;
    }
    case "model": {
      if (!parsed.value) {
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
    case "test": {
      const value = parsed.value?.toLowerCase();
      if (value !== "mic" && value !== "wake" && value !== "tts" && value !== "stt") {
        ctx.notify("Usage: /voice test mic|wake|tts|stt", "warning");
        return;
      }
      if (value === "tts") {
        const key = needKey();
        if (!key) return;
        if (!env.getPrefs().voiceId) {
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
