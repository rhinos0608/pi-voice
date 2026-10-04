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
import { DEFAULT_PREFERENCES, type AudioSource, type ModelPaths, type VoiceFailure, type VoicePreferences } from "./contracts.ts";
import { VoiceController, type VoiceHost } from "./controller.ts";
import { createDebugLog } from "./debuglog.ts";
import { analyzePcm, classifyCapture } from "./level.ts";
import { createAvFoundationSource, FFMPEG_PATH, listMicrophones, withSessionFallback, withSinkFallback } from "./mic.ts";
import { ensureVadModel, ensureWakeModel, isVadModelProvisioned, isWakeModelProvisioned, ensureSpeakerModel, speakerModelCachedPath } from "./model.ts";
import { buildProfile, createSpeakerEmbedder, createSpeakerGate, deleteSpeakerProfile, loadSpeakerProfile, saveSpeakerProfile, type SpeakerProfile } from "./speaker.ts";
import { createVoiceIo, ensureVoiceIoHelper, VoiceIoError, voiceIoHelperPath, type VoiceIoHandle } from "./voice-io.ts";
import { createFfplaySink, FFPLAY_PATH } from "./player.ts";
import { keyStatus, inworldKeyStatus, loadPreferences, resolveTtsKey, resolveTtsModelId, resolveTtsVoiceId, savePreferences, ttsProviderOf } from "./preferences.ts";
import { startUtterance } from "./stt.ts";
import { startSpeech, type StartSpeechOptions } from "./tts.ts";
import { startInworldSpeech } from "./inworld-tts.ts";
import { createEndpointer, type EndpointerEvents } from "./vad.ts";
import { createWakeDetector, type WakeGroup } from "./wake.ts";
import {
  getVoiceCompletions,
  handleVoiceCommand,
  createSpeakerStore,
  type CommandEnv,
} from "./commands.ts";
import { listTtsModels, listVoices } from "./elevenlabs-api.ts";
import { listInworldVoices } from "./inworld-api.ts";

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
  const key = resolveTtsKey(prefs);
  const voiceId = resolveTtsVoiceId(prefs);
  if (!key || !voiceId) {
    throw new Error(
      ttsProviderOf(prefs) === "inworld"
        ? "TTS test needs INWORLD_API_KEY."
        : "TTS test needs a key and a selected voice.",
    );
  }
  const sink = createFfplaySink();
  const inworld = ttsProviderOf(prefs) === "inworld";
  await new Promise<void>((resolve, reject) => {
    const opts: StartSpeechOptions = {
      key,
      voiceId,
      modelId: resolveTtsModelId(prefs),
      onDone: () => resolve(),
      onFailure: (f) => reject(new Error(f.message)),
    };
    const speech = inworld
      ? startInworldSpeech(opts, { sinkFactory: () => sink })
      : startSpeech(opts, { sinkFactory: () => sink });
    speech.push(TTS_TEST_PHRASE);
    speech.finish();
  });
  return "tts test: playback finished.";
}

export default function voiceExtension(pi: ExtensionAPI): void {
  let prefs: VoicePreferences = { ...DEFAULT_PREFERENCES };
  let liveCtx: ExtensionContext | ExtensionCommandContext | null = null;
  const debug = createDebugLog();

  let voiceIoHandle: VoiceIoHandle | null = null;
  let voiceIoRouteKey: string | null = null;
  let voiceIoFallback = false;
  let voiceIoWarned = false;
  let voiceIoInUse = false;
  /** Single owner of the in-memory speaker profile; see createSpeakerStore. */
  const speakerStore = createSpeakerStore({
    save: (profile) => saveSpeakerProfile(profile),
    remove: () => deleteSpeakerProfile(),
  });
  let speakerEmbedder: { embed(pcm: Buffer): Float32Array } | undefined;
  let speakerEmbedderKey: string | undefined;

  function noteVoiceIoFallback(notify: (message: string, type: "info" | "warning" | "error") => void): void {
    voiceIoFallback = true;
    if (!voiceIoWarned) {
      voiceIoWarned = true;
      notify("Voice isolation helper failed; using ffmpeg capture and ffplay playback for this session.", "warning");
    }
  }
  function voiceIoRouteKeyFor(helperPath: string): string {
    return `${helperPath}|${prefs.mic.kind === "named" ? prefs.mic.name : "default"}`;
  }

  /** Shared helper handle. Probes only — never compiles (setup owns the build). */
  function ensureVoiceIo(): VoiceIoHandle | null {
    if (!prefs.isolation || voiceIoFallback) return null;
    const helperPath = voiceIoHelperPath();
    if (!helperPath) return null;
    const key = voiceIoRouteKeyFor(helperPath);
    if (!voiceIoHandle || voiceIoRouteKey !== key) {
      const stale = voiceIoHandle;
      voiceIoHandle = null;
      if (stale) void stale.close().catch(() => undefined);
      voiceIoHandle = createVoiceIo({
        helperPath,
        ...(prefs.mic.kind === "named" ? { input: prefs.mic.name } : {}),
        voiceProcessing: true,
        ...(debug.enabled
          ? {
              log: (event: string, data?: unknown): void => {
                debug.log(event, (data ?? {}) as Record<string, unknown>);
              },
            }
          : {}),
      });
      voiceIoRouteKey = key;
    }
    return voiceIoHandle;
  }

  async function refreshSpeakerState(): Promise<void> {
    try {
      speakerStore.setCurrent(await loadSpeakerProfile());
    } catch {
      speakerStore.setCurrent(undefined);
    }
    if (!speakerStore.get() || !speakerModelCachedPath()) {
      speakerEmbedder = undefined;
      speakerEmbedderKey = undefined;
    }
  }

  /** Lazily create the session embedder from the cached model path; undefined when the model is missing. */
  function ensureSpeakerEmbedder(): ((pcm: Buffer) => Float32Array) | undefined {
    if (!speakerStore.get()) return undefined;
    const cached = speakerModelCachedPath();
    if (!cached) return undefined;
    if (!speakerEmbedder || speakerEmbedderKey !== cached) {
      try {
        speakerEmbedder = createSpeakerEmbedder(cached);
        speakerEmbedderKey = cached;
      } catch {
        speakerEmbedder = undefined;
        speakerEmbedderKey = undefined;
        return undefined;
      }
    }
    const embedder = speakerEmbedder;
    return (pcm: Buffer) => embedder.embed(pcm);
  }

  /** Record one enrollment phrase in memory (never written to disk) until VAD end-of-speech, max ~6 s. */
  async function captureEnrollmentPhrase(
    _prompt: string,
    opts: { signal: AbortSignal },
  ): Promise<
    | { status: "ok"; pcm: Buffer; speechMs: number }
    | { status: "too-short"; speechMs: number }
    | { status: "cancelled" }
  > {
    const vadPath = await ensureVadModel(opts.signal);
    const io = ensureVoiceIo();
    const source = io ? io.source : createAvFoundationSource(prefs.mic);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let speechBytes = 0;
      let heard = false;
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const endpointer = createEndpointer(vadPath, {
        onSpeechStart: () => {
          heard = true;
        },
        onSpeechEnd: () => {
          finishOk();
        },
      });
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        endpointer.close();
      };
      const finishOk = (): void => {
        if (done) return;
        done = true;
        cleanup();
        void source.stop().catch(() => undefined);
        const speechMs = speechBytes / 32;
        if (!heard || speechMs < 1500) resolve({ status: "too-short", speechMs });
        else resolve({ status: "ok", pcm: Buffer.concat(chunks), speechMs });
      };
      const onAbort = (): void => {
        if (done) return;
        done = true;
        cleanup();
        void source.stop().catch(() => undefined);
        resolve({ status: "cancelled" });
      };
      const onError = (err: Error): void => {
        if (done) return;
        done = true;
        cleanup();
        void source.stop().catch(() => undefined);
        reject(err);
      };
      if (opts.signal.aborted) {
        cleanup();
        resolve({ status: "cancelled" });
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        finishOk();
      }, 6000);
      void source
        .start(
          (chunk) => {
            if (done) return;
            try {
              endpointer.push(chunk);
            } catch {
              finishOk();
              return;
            }
            if (heard) {
              chunks.push(chunk);
              speechBytes += chunk.length;
            }
          },
          onError,
        )
        .catch(onError);
    });
  }

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
    getTtsKey: () => resolveTtsKey(prefs),
    isModelProvisioned: () => isWakeModelProvisioned(),
    ensureModel: (signal) => ensureWakeModel(signal),
    createSource: (mic, onNotice) => {
      const io = ensureVoiceIo();
      if (!io) return createAvFoundationSource(mic, { onNotice });
      return withSessionFallback({
        primary: io.source,
        createFallback: () => createAvFoundationSource(mic, { onNotice }),
        shouldFallback: (err) =>
          err instanceof VoiceIoError && (err.code === "device" || err.code === "engine" || err.code === "exited"),
        onFallback: () => {
          noteVoiceIoFallback(onNotice);
        },
        onPrimaryStart: () => {
          voiceIoInUse = true;
        },
      });
    },
    createDetector: (
      paths: ModelPaths,
      choice: VoicePreferences["wake"],
      sensitivity: VoicePreferences["sensitivity"],
      onWake: (phrase: string, group: WakeGroup | undefined) => void,
      options: { includeSend: boolean },
    ) => createWakeDetector(paths, choice, sensitivity, onWake, undefined, options),
    openUtterance: (key, handlers) => startUtterance(key, handlers),
    openSpeech: (opts) => {
      const speechDeps = {
        sinkFactory: () => {
          const io = ensureVoiceIo();
          if (!io) return createFfplaySink();
          return withSinkFallback({
            primary: io.createSink(),
            createFallback: () => createFfplaySink(),
            shouldFallback: () => true,
            onFallback: () => noteVoiceIoFallback((message, type) => host.notify(message, type)),
          });
        },
        ...(debug.enabled ? { log: (event: string, data?: Record<string, unknown>) => debug.log(event, data) } : {}),
      };
      return ttsProviderOf(prefs) === "inworld" ? startInworldSpeech(opts, speechDeps) : startSpeech(opts, speechDeps);
    },
    ensureVadModel: (signal: AbortSignal) => ensureVadModel(signal),
    createEndpointer: (modelPath: string, events: EndpointerEvents) => createEndpointer(modelPath, events),
    getSpeakerCheck: () => (speakerStore.get() && speakerModelCachedPath() ? prefs.speakerCheck : "off"),
    getSpeakerProfile: () => speakerStore.get(),
    getSpeakerEmbed: () => ensureSpeakerEmbedder(),
    createSpeakerGate: (opts) => createSpeakerGate(opts as unknown as Parameters<typeof createSpeakerGate>[0]),
    setSpeakerProfile: (profile) => {
      speakerStore.setCurrent(profile);
    },
    saveSpeakerProfile: (profile) => speakerStore.flushDirty(profile).then(() => undefined),
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
      getTtsProvider: () => ttsProviderOf(prefs),
      getInworldKey: () => process.env["INWORLD_API_KEY"],
      inworldKeyPresent: () => inworldKeyStatus().present,
      inworldKeyLast4: () => inworldKeyStatus().last4,
      listInworldVoices: (key) => listInworldVoices(key),
      runTest: (kind) => runLiveTest(kind, prefs),
      voiceIo: {
        helperBuilt: () => voiceIoHelperPath() !== undefined,
        isActive: () => voiceIoInUse,
        hadFallback: () => voiceIoFallback,
        ensureHelper: (signal) => ensureVoiceIoHelper({ signal }),
      },
      speaker: {
        loadProfile: () => loadSpeakerProfile(),
        saveProfile: (profile) => speakerStore.saveAndSet(profile),
        deleteProfile: () => speakerStore.clearAndDelete(),
        ensureModel: (signal) => ensureSpeakerModel(signal),
        modelCachedPath: () => speakerModelCachedPath(),
        createEmbedder: (modelPath) => createSpeakerEmbedder(modelPath),
        buildProfile: (embeddings, model) => buildProfile(embeddings, model),
        capturePhrase: (prompt, opts) => captureEnrollmentPhrase(prompt, opts),
      },
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
        getTtsProvider: () => ttsProviderOf(prefs),
        getInworldKey: () => process.env["INWORLD_API_KEY"],
        listInworldVoices: (key: string) => listInworldVoices(key),
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
      await refreshSpeakerState();
      await handleVoiceCommand(args, ctxView, buildEnv(cmdCtx));
      // Flush debounced learning before reloading, so a that-was-me or
      // reset-learning in this command sees the latest profile, not a stale disk copy.
      await controller.flushSpeakerLearning();
      await refreshSpeakerState();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    liveCtx = ctx;
    if (!ctx.hasUI) return;
    const loaded = await loadPreferences();
    prefs = loaded.prefs;
    if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
    // Fresh session: forget any fallback, but never compile here (setup owns builds).
    voiceIoFallback = false;
    voiceIoWarned = false;
    voiceIoInUse = false;
    await refreshSpeakerState();
    const key = process.env["ELEVENLABS_API_KEY"];
    const provisioned = (await isWakeModelProvisioned()) && (await isVadModelProvisioned());
    if (prefs.autostart && provisioned && key) {
      await controller.start();
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, SETUP_HINT);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    liveCtx = ctx;
    await controller.shutdown();
    const io = voiceIoHandle;
    voiceIoHandle = null;
    voiceIoRouteKey = null;
    await io?.close().catch(() => undefined);
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
