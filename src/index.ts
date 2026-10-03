/**
 * Lane E entry point: thin Pi wiring around the VoiceController.
 * The factory registers one `/voice` command and event handlers only;
 * it never starts audio. Session-scoped resources start from
 * session_start (autostart) or /voice on, and stop on session_shutdown.
 */

import { execFile } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_PREFERENCES, type ModelPaths, type VoiceFailure, type VoicePreferences } from "./contracts.ts";
import { VoiceController, type VoiceHost } from "./controller.ts";
import { createDebugLog } from "./debuglog.ts";
import { analyzePcm, classifyCapture } from "./level.ts";
import { createAvFoundationSource, FFMPEG_PATH, listMicrophones } from "./mic.ts";
import { ensureVadModel, ensureWakeModel, isVadModelProvisioned, isWakeModelProvisioned } from "./model.ts";
import { createFfplaySink, FFPLAY_PATH } from "./player.ts";
import { keyStatus, loadPreferences, savePreferences } from "./preferences.ts";
import { startUtterance } from "./stt.ts";
import { DEFAULT_TTS_MODEL, startSpeech } from "./tts.ts";
import { createEndpointer, type EndpointerEvents } from "./vad.ts";
import { createWakeDetector, type WakeGroup } from "./wake.ts";
import {
  getVoiceCompletions,
  handleVoiceCommand,
  type CommandEnv,
} from "./commands.ts";
import { listTtsModels, listVoices } from "./elevenlabs-api.ts";

const STATUS_KEY = "voice";
const SETUP_HINT = "voice: run /voice setup";
const TTS_TEST_PHRASE = "Voice test. Playback works.";

function checkBinary(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, ["-version"], { timeout: 5000 }, (err) => resolve(!err));
  });
}

async function runLiveTest(kind: "mic" | "wake" | "tts" | "stt", prefs: VoicePreferences): Promise<string> {
  if (kind === "mic") {
    const source = createAvFoundationSource(prefs.mic);
    const chunks: Buffer[] = [];
    const micState: { error: Error | null } = { error: null };
    await source.start(
      (chunk) => {
        chunks.push(chunk);
      },
      (err) => {
        micState.error = err;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await source.stop();
    if (micState.error) throw new Error(micState.error.message);
    const stats = analyzePcm(Buffer.concat(chunks));
    const health = classifyCapture(stats);
    if (health === "silent-zero") {
      return "mic test: pure digital silence — macOS is denying microphone access to this terminal (System Settings › Privacy & Security › Microphone).";
    }
    const peak = stats.peakDbfs.toFixed(1);
    if (health === "very-quiet") {
      return `mic test: very quiet (peak ${peak} dBFS) — check the input device or gain.`;
    }
    const device = prefs.mic.kind === "named" ? prefs.mic.name : "default";
    const rms = stats.rmsDbfs.toFixed(1);
    return `mic test: ${device} · level ${rms} dBFS (peak ${peak}) · ok`;
  }
  if (kind === "wake") {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10000);
    try {
      const paths = await ensureWakeModel(abort.signal);
      let heard: string | null = null;
      const detector = createWakeDetector(paths, prefs.wake, prefs.sensitivity, (phrase) => {
        heard = phrase;
      });
      const source = createAvFoundationSource(prefs.mic);
      await source.start(
        (chunk) => detector.push(chunk),
        () => {},
      );
      const deadline = Date.now() + 10000;
      while (heard === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await source.stop();
      detector.close();
      return heard === null ? "wake test: no wake word heard in ~10 s." : `wake test: heard "${heard}".`;
    } finally {
      clearTimeout(timer);
    }
  }
  if (kind === "stt") {
    const sttKey = process.env["ELEVENLABS_API_KEY"];
    if (!sttKey) throw new Error("STT test needs a key.");
    const modelPath = await ensureVadModel(new AbortController().signal);
    const source = createAvFoundationSource(prefs.mic);
    let speechStarted = false;
    let commitAt = 0;
    let lastFinal = "";
    let endSource: "committed" | "partial-fallback" | undefined;
    let endText = "";
    const failureState: { failure: VoiceFailure | null } = { failure: null };
    const sttMicState: { error: Error | null } = { error: null };
    let settled = false;
    let resolveOutcome: () => void = () => {};
    const outcome = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });
    const settle = (): void => {
      if (!settled) {
        settled = true;
        resolveOutcome();
      }
    };
    const endpointer = createEndpointer(modelPath, {
      onSpeechStart: () => {
        speechStarted = true;
      },
      onSpeechEnd: () => {
        if (commitAt === 0) commitAt = Date.now();
        try {
          utterance.commit();
        } catch {
          // Commit failure surfaces via STT failure paths.
        }
      },
    });
    const utterance = startUtterance(sttKey, {
      onPartial: () => {},
      onFinal: (text) => {
        lastFinal = text;
      },
      onFailure: (f) => {
        failureState.failure = f;
        settle();
      },
      onEnd: (info) => {
        endText = info.text;
        endSource = info.source;
        if (info.reason === "final" && info.text.trim() !== "") lastFinal = info.text;
        settle();
      },
    });
    try {
      await source.start(
        (chunk) => {
          endpointer.push(chunk);
          utterance.push(chunk);
        },
        (err) => {
          sttMicState.error = err;
          settle();
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 8000));
      function throwIfTestFailed(): void {
        const micErr = sttMicState.error;
        if (micErr) throw new Error(micErr.message);
        const sttFailed = failureState.failure;
        if (sttFailed) throw new Error(`stt test failed (${sttFailed.code}): ${sttFailed.message}`);
      }
      throwIfTestFailed();
      if (speechStarted && commitAt === 0) {
        commitAt = Date.now();
        try {
          utterance.commit();
        } catch {
          // Commit failure surfaces via STT failure paths.
        }
      }
      if (speechStarted && !settled) {
        await Promise.race([outcome, new Promise((resolve) => setTimeout(resolve, 8000))]);
      }
      throwIfTestFailed();
      const transcript = (endText.trim() !== "" ? endText : lastFinal).trim();
      if (transcript !== "") {
        const ms = commitAt === 0 ? 0 : Date.now() - commitAt;
        const fallback = endSource === "partial-fallback" ? " [partial fallback]" : "";
        return `stt test: "${transcript}" (commit → final ${ms} ms)${fallback}`;
      }
      if (!speechStarted) return "stt test: no speech detected in 8 s.";
      return "stt test: speech heard but no transcript.";
    } finally {
      await source.stop().catch(() => undefined);
      endpointer.close();
      await utterance.close().catch(() => undefined);
    }
  }
  const key = process.env["ELEVENLABS_API_KEY"];
  if (!key || !prefs.voiceId) throw new Error("TTS test needs a key and a selected voice.");
  const sink = createFfplaySink();
  await new Promise<void>((resolve, reject) => {
    const speech = startSpeech(
      {
        key,
        voiceId: prefs.voiceId as string,
        modelId: prefs.ttsModel ?? DEFAULT_TTS_MODEL,
        onDone: () => resolve(),
        onFailure: (f) => reject(new Error(f.message)),
      },
      { sinkFactory: () => sink },
    );
    speech.push(TTS_TEST_PHRASE);
    speech.finish();
  });
  return "tts test: playback finished.";
}

export default function voiceExtension(pi: ExtensionAPI): void {
  let prefs: VoicePreferences = { ...DEFAULT_PREFERENCES };
  let liveCtx: ExtensionContext | ExtensionCommandContext | null = null;
  const debug = createDebugLog();

  function editorUi(): ExtensionContext["ui"] | null {
    return liveCtx?.hasUI ? liveCtx.ui : null;
  }

  const host: VoiceHost = {
    sendUserMessage: (text, opts) => {
      if (opts?.deliverAs) pi.sendUserMessage(text, { deliverAs: opts.deliverAs });
      else pi.sendUserMessage(text);
    },
    isIdle: () => liveCtx?.isIdle() ?? true,
    setStatus: (text) => {
      liveCtx?.ui.setStatus(STATUS_KEY, text);
    },
    notify: (message, type) => {
      liveCtx?.ui.notify(message, type ?? "info");
    },
    pasteToEditor: (text) => {
      editorUi()?.pasteToEditor(text);
    },
    getEditorText: () => editorUi()?.getEditorText() ?? "",
    setEditorText: (text) => {
      editorUi()?.setEditorText(text);
    },
  };

  const controller = new VoiceController(host, {
    getPrefs: () => prefs,
    getKey: () => process.env["ELEVENLABS_API_KEY"],
    isModelProvisioned: () => isWakeModelProvisioned(),
    ensureModel: (signal) => ensureWakeModel(signal),
    createSource: (mic, onNotice) => createAvFoundationSource(mic, { onNotice }),
    createDetector: (
      paths: ModelPaths,
      choice: VoicePreferences["wake"],
      sensitivity: VoicePreferences["sensitivity"],
      onWake: (phrase: string, group: WakeGroup | undefined) => void,
      options: { includeSend: boolean },
    ) => createWakeDetector(paths, choice, sensitivity, onWake, undefined, options),
    openUtterance: (key, handlers) => startUtterance(key, handlers),
    openSpeech: (opts) => startSpeech(opts, { sinkFactory: () => createFfplaySink() }),
    ensureVadModel: (signal: AbortSignal) => ensureVadModel(signal),
    createEndpointer: (modelPath: string, events: EndpointerEvents) => createEndpointer(modelPath, events),
    ...(debug.enabled ? { log: (event: string, data?: Record<string, unknown>) => debug.log(event, data) } : {}),
  });

  function buildEnv(cmdCtx: ExtensionCommandContext): CommandEnv {
    return {
      controller,
      loadPrefs: () => loadPreferences(),
      savePrefs: (next) => savePreferences(next),
      mutatePrefs: async (fn) => {
        fn(prefs);
        await savePreferences(prefs);
        return prefs;
      },
      getPrefs: () => prefs,
      keyPresent: () => keyStatus().present,
      keyLast4: () => keyStatus().last4,
      isProvisioned: () => isWakeModelProvisioned(),
      isVadProvisioned: () => isVadModelProvisioned(),
      ensureModel: (signal) => ensureWakeModel(signal),
      ensureVadModel: (signal) => ensureVadModel(signal),
      hasFfmpeg: () => checkBinary(FFMPEG_PATH),
      hasFfplay: () => checkBinary(FFPLAY_PATH),
      listDevices: () => listMicrophones(),
      listVoices: (key) => listVoices(key),
      listModels: (key) => listTtsModels(key),
      getKey: () => process.env["ELEVENLABS_API_KEY"],
      runTest: (kind) => runLiveTest(kind, prefs),
    };
  }

  pi.registerCommand("voice", {
    description: "Voice wake-word input and speech output (/voice help for subcommands)",
    getArgumentCompletions: (argumentPrefix: string) => {
      const probe = {
        listDevices: () => listMicrophones(),
        listVoices: (key: string) => listVoices(key),
        listModels: (key: string) => listTtsModels(key),
        getKey: () => process.env["ELEVENLABS_API_KEY"],
      };
      return getVoiceCompletions(argumentPrefix, probe);
    },
    handler: async (args: string, cmdCtx: ExtensionCommandContext) => {
      liveCtx = cmdCtx;
      const loaded = await loadPreferences();
      prefs = loaded.prefs;
      if (loaded.warning) cmdCtx.ui.notify(loaded.warning, "warning");
      const ctxView = {
        notify: (message: string, type?: "info" | "warning" | "error"): void => {
          cmdCtx.ui.notify(message, type ?? "info");
        },
        setStatus: (key: string, text: string | undefined): void => {
          cmdCtx.ui.setStatus(key, text);
        },
      };
      await handleVoiceCommand(args, ctxView, buildEnv(cmdCtx));
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    liveCtx = ctx;
    if (!ctx.hasUI) return;
    const loaded = await loadPreferences();
    prefs = loaded.prefs;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    const key = process.env["ELEVENLABS_API_KEY"];
    const provisioned = await isWakeModelProvisioned();
    if (prefs.autostart && provisioned && key) {
      await controller.start();
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, SETUP_HINT);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    liveCtx = ctx;
    await controller.shutdown();
  });

  pi.on("message_update", (event, ctx) => {
    liveCtx = ctx;
    const role = (event.message as { role?: string }).role;
    const streamEvent = event.assistantMessageEvent as { type?: string; delta?: string };
    if (streamEvent.type !== "text_delta") return;
    controller.onMessageUpdate({ role }, streamEvent.type, typeof streamEvent.delta === "string" ? streamEvent.delta : "");
  });

  pi.on("message_end", (event, ctx) => {
    liveCtx = ctx;
    const message = event.message as { role?: string; stopReason?: string };
    controller.onMessageEnd({ role: message.role, stopReason: message.stopReason }, message.role === "assistant");
  });

  pi.on("input", (_event, ctx) => {
    liveCtx = ctx;
    controller.onInput();
  });
}
