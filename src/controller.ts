/**
 * Lane E voice pipeline state machine (controller).
 *
 * Phases: off → preparing → wake → capture → submit → wake,
 * with `speaking` while TTS audio plays. One AudioSource feeds the wake
 * detector in wake/speaking and the STT utterance only in capture.
 * index.ts adapts the real Pi API to the narrow Host interface below;
 * tests inject fakes. Nothing here spawns processes directly.
 */

import { spawn } from "node:child_process";
import type { AudioSink, AudioSource, VoiceFailure, VoicePhase, VoicePreferences } from "./contracts.ts";
import { parseTranscriptIntent } from "./intent.ts";
import { analyzePcm, LevelMeter, meterBar } from "./level.ts";
import { MicError } from "./mic.ts";
import { createSpeechChunker, type SpeechChunker } from "./speech-text.ts";
import type { SttEndInfo, SttHandlers, Utterance } from "./stt.ts";
import { startSpeech, DEFAULT_TTS_MODEL, type Speech } from "./tts.ts";
import type { Endpointer, EndpointerEvents } from "./vad.ts";
import type { WakeDetector, WakeGroup } from "./wake.ts";

/** Narrow host surface the controller needs from Pi (adapted in index.ts). */
export type VoiceHost = {
  sendUserMessage(text: string, opts?: { deliverAs?: "steer" | "followUp" }): void;
  isIdle(): boolean;
  setStatus(text: string | undefined): void;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  pasteToEditor(text: string): void;
  getEditorText(): string;
  setEditorText(text: string): void;
};

/** Injectable factories and environment probes. */
export type ControllerDeps = {
  getPrefs: () => VoicePreferences;
  getKey: () => string | undefined;
  isModelProvisioned: () => Promise<boolean>;
  ensureModel: (signal: AbortSignal) => Promise<{ encoder: string; decoder: string; joiner: string; tokens: string; keywordsFile: string }>;
  createSource: (mic: VoicePreferences["mic"], onNotice: (msg: string) => void) => AudioSource;
  createDetector: (
    paths: { encoder: string; decoder: string; joiner: string; tokens: string; keywordsFile: string },
    choice: VoicePreferences["wake"],
    sensitivity: VoicePreferences["sensitivity"],
    onWake: (phrase: string, group: WakeGroup | undefined) => void,
    options: { includeSend: boolean },
  ) => WakeDetector;
  openUtterance: (key: string, handlers: SttHandlers) => Utterance;
  ensureVadModel: (signal: AbortSignal) => Promise<string>;
  createEndpointer: (modelPath: string, events: EndpointerEvents) => Endpointer;
  log?: (event: string, data?: Record<string, unknown>) => void;
  playErrorCue?: () => void;
  noSpeechMs?: number;
  now?: () => number;
  openSpeech: (
    opts: { key: string; voiceId: string; modelId: string; onDone: () => void; onFailure: (f: VoiceFailure) => void },
  ) => Speech;
  createSink?: () => AudioSink;
  playCue?: () => void;
  /** Post-playback cooldown before wake resumes (default ~700 ms). */
  cooldownMs?: number;
  /** Retryable-failure backoff before returning to wake (default 2000 ms). */
  retryBackoffMs?: number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
};

export const CUE_PATH = "/System/Library/Sounds/Tink.aiff";
export const ERROR_CUE_PATH = "/System/Library/Sounds/Basso.aiff";
export const COOLDOWN_MS = 700;
export const RETRY_BACKOFF_MS = 2000;
export const NO_SPEECH_MS_DEFAULT = 5000;
export const STATUS_THROTTLE_MS = 100;
export const FAILURE_NOTIFY_DEDUP_MS = 60_000;
export const MIC_RESTART_BACKOFFS_MS = [1000, 2000, 4000] as const;
export const ZERO_PCM_WARN_BYTES = 3 * 16000 * 2;
export const TRANSIENT_STATUS_MS = 2000;

export function defaultPlayCue(): void {
  try {
    const child = spawn("/usr/bin/afplay", [CUE_PATH], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Cue is best-effort; wake proceeds regardless.
  }
}

export function defaultPlayErrorCue(): void {
  try {
    const child = spawn("/usr/bin/afplay", [ERROR_CUE_PATH], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Error cue is advisory; capture continues without it.
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One assistant message awaiting or undergoing speech. Only the head holds live chunker/speech. */
type QueuedSpeech = {
  gen: number;
  deltas: string[];
  ended: boolean;
  chunker: SpeechChunker | null;
  speech: Speech | null;
};

export class VoiceController {
  private phase: VoicePhase = "off";
  private generation = 0;
  private closed = false;
  private starting = false;
  private source: AudioSource | null = null;
  private detector: WakeDetector | null = null;
  private utterance: Utterance | null = null;
  private speech: Speech | null = null;
  private chunker: SpeechChunker | null = null;
  /** Ordered per-message speech queue; head (index 0) owns chunker/speech. */
  private speechQueue: QueuedSpeech[] = [];
  private timer: unknown = null;
  private noSpeechTimer: unknown = null;
  private micTimer: unknown = null;
  private submitted = false;
  private committed = false;
  private endpointer: Endpointer | null = null;
  private vadPath: string | null = null;
  private speechHeard = false;
  private lastPartial = "";
  private meter = new LevelMeter();
  private lastStatusAt = 0;
  private micFailures = 0;
  private failureNotifiedAt = new Map<string, number>();
  private zeroBytes = 0;
  private zeroWarned = false;
  private readonly host: VoiceHost;
  private readonly deps: ControllerDeps;

  constructor(host: VoiceHost, deps: ControllerDeps) {
    this.host = host;
    this.deps = deps;
  }

  getPhase(): VoicePhase {
    return this.phase;
  }

  private get timers(): { set: (cb: () => void, ms: number) => unknown; clear: (id: unknown) => void } {
    const setFn = this.deps.setTimeout ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));
    const clearFn =
      this.deps.clearTimeout ?? ((id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>));
    return { set: setFn, clear: clearFn };
  }

  private log(event: string, data?: Record<string, unknown>): void {
    try {
      this.deps.log?.(event, data);
    } catch {
      // Debug sink must never break the pipeline.
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private playErrorCue(): void {
    try {
      (this.deps.playErrorCue ?? defaultPlayErrorCue)();
    } catch {
      // Cue is advisory; capture continues without it.
    }
  }

  private closeEndpointer(): void {
    const ep = this.endpointer;
    this.endpointer = null;
    if (!ep) return;
    try {
      ep.close();
    } catch {
      // Endpointer teardown is best-effort.
    }
  }

  private later(cb: () => void, ms: number): void {
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      cb();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private clearNoSpeechTimer(): void {
    if (this.noSpeechTimer !== null) {
      this.timers.clear(this.noSpeechTimer);
      this.noSpeechTimer = null;
    }
  }

  private clearMicTimer(): void {
    if (this.micTimer !== null) {
      this.timers.clear(this.micTimer);
      this.micTimer = null;
    }
  }

  private setPhase(next: VoicePhase, status: string | undefined): void {
    if (this.phase !== next) this.log("phase", { from: this.phase, to: next });
    this.phase = next;
    this.host.setStatus(status);
  }

  /** Begin wake listening. Idempotent; safe to call from autostart or /voice on. */
  async start(): Promise<void> {
    if (this.closed || this.starting) return;
    if (this.phase === "wake" || this.phase === "capture" || this.phase === "speaking" || this.phase === "submit") return;
    this.starting = true;
    const gen = ++this.generation;
    this.micFailures = 0;
    this.zeroBytes = 0;
    this.zeroWarned = false;
    this.setPhase("preparing", "voice starting…");
    const prefs = this.deps.getPrefs();
    const ctrl = new AbortController();
    try {
      const paths = await this.deps.ensureModel(ctrl.signal);
      this.vadPath = await this.deps.ensureVadModel(ctrl.signal);
      if (this.closed || gen !== this.generation) return;
      this.detector?.close();
      this.detector = this.deps.createDetector(
        paths,
        prefs.wake,
        prefs.sensitivity,
        (phrase, group) => this.onWake(phrase, group),
        { includeSend: prefs.sendMode === "review" },
      );
      const source = this.deps.createSource(prefs.mic, (msg) => this.host.notify(msg, "warning"));
      this.source = source;
      await source.start(
        (chunk) => this.onFrame(chunk),
        (err) => this.onSourceError(err),
      );
      if (this.closed || gen !== this.generation) {
        await source.stop().catch(() => undefined);
        return;
      }
      this.setPhase("wake", "🎙 listening");
    } catch (err) {
      if (this.closed || gen !== this.generation) return;
      await this.stopQuiet();
      const message = err instanceof Error ? err.message : String(err);
      this.setPhase("off", "voice off");
      this.host.notify(`Voice failed to start: ${message}`, "error");
    } finally {
      this.starting = false;
    }
  }

  /** Stop listening and cancel in-flight audio. Idempotent. */
  async stop(): Promise<void> {
    this.generation++;
    this.clearTimer();
    await this.stopQuiet();
    this.setPhase("off", "voice off");
  }

  private async stopQuiet(): Promise<void> {
    this.submitted = false;
    this.clearNoSpeechTimer();
    this.clearMicTimer();
    this.closeEndpointer();
    const utterance = this.utterance;
    this.utterance = null;
    if (utterance) await utterance.close().catch(() => undefined);
    this.cancelSpeech();
    const source = this.source;
    this.source = null;
    if (source) await source.stop().catch(() => undefined);
    const detector = this.detector;
    this.detector = null;
    try {
      detector?.close();
    } catch {
      // Best-effort teardown.
    }
  }

  /** Idempotent session teardown: no orphaned resources, no status left behind. */
  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.stopQuiet().catch(() => undefined);
      return;
    }
    this.closed = true;
    this.generation++;
    this.clearTimer();
    await this.stopQuiet().catch(() => undefined);
    this.phase = "off";
    this.host.setStatus(undefined);
  }

  /** Restart listening when a live-relevant preference changed. */
  async restartIfListening(): Promise<void> {
    if (this.phase === "off" || this.phase === "preparing") return;
    this.generation++;
    this.clearTimer();
    await this.stopQuiet();
    // stopQuiet preserves the phase; start() refuses to run while capture/
    // speaking/submit is set. Drop to off without touching status (start
    // reports "preparing" next) so restart works mid-capture. The bumped
    // generation above already invalidates the canceled utterance: its late
    // partials/finals can no longer submit.
    this.phase = "off";
    await this.start();
  }

  private onSourceError(err: Error): void {
    const gen = this.generation;
    if (this.closed || gen !== this.generation) return;
    if (err instanceof MicError && err.code === "permission") {
      this.log("mic-error", { code: err.code });
      void (async (): Promise<void> => {
        if (this.closed || gen !== this.generation) return;
        this.generation += 1;
        await this.stopQuiet();
        if (this.closed || gen + 1 !== this.generation) return;
        this.setPhase("off", "voice off");
        this.host.notify(
          "Microphone access denied. Grant the terminal app Microphone access in System Settings › Privacy & Security › Microphone, then turn voice back on.",
          "error",
        );
      })();
      return;
    }
    if (err instanceof MicError) {
      this.scheduleMicRestart(err, gen);
      return;
    }
    void (async (): Promise<void> => {
      if (this.closed || gen !== this.generation) return;
      this.generation += 1;
      await this.stopQuiet();
      if (this.closed || gen + 1 !== this.generation) return;
      this.setPhase("off", "voice off");
      this.host.notify(`Microphone failed: ${err.message}`, "error");
    })();
  }

  private scheduleMicRestart(err: MicError, gen: number): void {
    if (this.closed || gen !== this.generation) return;
    if (this.micFailures >= MIC_RESTART_BACKOFFS_MS.length) {
      this.log("mic-error", { code: err.code, gaveUp: true });
      void (async (): Promise<void> => {
        if (this.closed || gen !== this.generation) return;
        this.generation += 1;
        await this.stopQuiet();
        if (this.closed || gen + 1 !== this.generation) return;
        this.setPhase("off", "voice off");
        this.host.notify(`Microphone failed after 3 restarts — voice off: ${err.message}`, "error");
      })();
      return;
    }
    const delay = MIC_RESTART_BACKOFFS_MS[this.micFailures] ?? 1000;
    this.micFailures += 1;
    if (this.micFailures === 1) this.host.notify("Microphone stalled — restarting", "warning");
    this.log("mic-restart", { code: err.code, attempt: this.micFailures, delayMs: delay });
    this.clearMicTimer();
    this.micTimer = this.timers.set(() => {
      this.micTimer = null;
      void this.restartSource(gen);
    }, delay);
  }

  private async restartSource(gen: number): Promise<void> {
    if (this.closed || gen !== this.generation) return;
    try {
      await this.source?.stop();
    } catch {
      // Old source teardown is best-effort; starting fresh below.
    }
    if (this.closed || gen !== this.generation) return;
    const prefs = this.deps.getPrefs();
    try {
      const next = this.deps.createSource(prefs.mic, (msg) => this.host.notify(msg, "warning"));
      this.source = next;
      await next.start(
        (chunk) => this.onFrame(chunk),
        (error) => this.onSourceError(error),
      );
      this.log("mic-restart", { attempt: this.micFailures, started: true });
    } catch (err) {
      this.onSourceError(
        err instanceof MicError ? err : new MicError("spawn", err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private onFrame(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    this.trackAudioHealth(chunk);
    if (this.phase === "wake" || this.phase === "speaking") {
      try {
        this.detector?.push(chunk);
      } catch {
        // A bad frame must not kill the session.
      }
      return;
    }
    if (this.phase === "capture") {
      try {
        this.utterance?.push(chunk);
      } catch {
        // Ignore push errors; STT failure paths report on their own.
      }
      try {
        this.endpointer?.push(chunk);
      } catch {
        // VAD must never break the capture.
      }
      try {
        this.meter.push(chunk);
      } catch {
        // Metering is advisory.
      }
      this.maybeCaptureStatus();
    }
  }

  private trackAudioHealth(chunk: Buffer): void {
    let allZero = false;
    try {
      allZero = analyzePcm(chunk).allZero;
    } catch {
      return;
    }
    if (!allZero) {
      this.zeroBytes = 0;
      this.micFailures = 0;
      return;
    }
    this.zeroBytes += chunk.length;
    if (!this.zeroWarned && this.zeroBytes >= ZERO_PCM_WARN_BYTES) {
      this.zeroWarned = true;
      this.log("mic-silent", { zeroBytes: this.zeroBytes });
      this.host.notify(
        "Microphone is delivering pure silence — macOS likely denied microphone access to the terminal app.",
        "warning",
      );
    }
  }

  private captureStatusText(): string {
    const bar = meterBar(this.meter.db);
    if (this.lastPartial === "") return `🎙 ${bar} listening…`;
    return `🎙 ${bar} ${truncate(this.lastPartial, 60)}`;
  }

  private maybeCaptureStatus(): void {
    if (this.phase !== "capture") return;
    if (this.committed) return;
    if (this.now() - this.lastStatusAt < STATUS_THROTTLE_MS) return;
    this.lastStatusAt = this.now();
    this.host.setStatus(this.captureStatusText());
  }

  private onWake(phrase: string, group: WakeGroup | undefined): void {
    if (this.closed) return;
    if (this.phase !== "wake" && this.phase !== "speaking") return;
    this.log("wake", { group: group ?? "unknown", phraseLength: phrase.length });
    if (group === "send-to-pi") {
      this.onSendSpotter();
      return;
    }
    const gen = ++this.generation;
    this.clearTimer();
    this.clearNoSpeechTimer();
    this.closeEndpointer();
    this.cancelSpeech();
    const key = this.deps.getKey();
    if (!key) {
      this.host.notify("Export ELEVENLABS_API_KEY and restart Pi.", "warning");
      this.setPhase("wake", "🎙 listening");
      return;
    }
    (this.deps.playCue ?? defaultPlayCue)();
    const old = this.utterance;
    this.utterance = null;
    if (old) void old.close().catch(() => undefined);
    this.submitted = false;
    this.committed = false;
    this.speechHeard = false;
    this.lastPartial = "";
    this.meter.reset();
    this.detector?.reset();
    try {
      this.utterance = this.deps.openUtterance(key, {
        onPartial: (text) => this.onPartial(text, gen),
        onFinal: (text) => this.onFinal(text, gen),
        onFailure: (f) => this.onSttFailure(f, gen),
        onEnd: (info) => this.onEnd(info, gen),
        onEvent: (type, info) => this.logSttEvent(type, info),
      });
    } catch (err) {
      this.onSttFailure(
        { code: "network", message: err instanceof Error ? err.message : String(err), retryable: true },
        gen,
      );
      return;
    }
    this.openEndpointer(gen);
    this.setPhase("capture", this.captureStatusText());
    this.lastStatusAt = this.now();
    this.armNoSpeechTimer(gen);
  }

  private onSendSpotter(): void {
    this.log("wake", { group: "send-to-pi" });
    const draft = this.editorText().trim();
    if (draft === "") return;
    this.submitDraft();
  }

  private openEndpointer(gen: number): void {
    this.closeEndpointer();
    if (!this.vadPath || typeof this.deps.createEndpointer !== "function") return;
    try {
      this.endpointer = this.deps.createEndpointer(this.vadPath, {
        onSpeechStart: (atSec) => {
          if (this.closed || gen !== this.generation || this.phase !== "capture") return;
          this.speechHeard = true;
          this.clearNoSpeechTimer();
          this.log("vad-start", { atSec });
        },
        onSpeechEnd: (atSec) => {
          if (this.closed || gen !== this.generation || this.phase !== "capture") return;
          this.log("vad-end", { atSec });
          try {
            this.utterance?.commit();
          } catch {
            // Commit failure surfaces via STT failure paths.
          }
          // The utterance is committed: freeze the transcribing status until
          // the utterance resolves. Late frames/partials must not repaint
          // the capture meter over it.
          this.committed = true;
          this.lastStatusAt = this.now();
          this.host.setStatus("🎙 transcribing…");
        },
      });
    } catch (err) {
      this.log("vad-error", { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private armNoSpeechTimer(gen: number): void {
    this.clearNoSpeechTimer();
    const ms = this.deps.noSpeechMs ?? NO_SPEECH_MS_DEFAULT;
    this.noSpeechTimer = this.timers.set(() => {
      this.noSpeechTimer = null;
      if (this.closed || gen !== this.generation || this.phase !== "capture" || this.speechHeard) return;
      this.log("no-speech", { timeoutMs: ms });
      this.closeUtterance();
      this.closeEndpointer();
      this.playErrorCue();
      if (this.closed || gen !== this.generation) return;
      this.setPhase("wake", "🎙 didn't hear anything");
      this.later(() => {
        if (!this.closed && gen === this.generation && this.phase === "wake") this.host.setStatus("🎙 listening");
      }, TRANSIENT_STATUS_MS);
    }, ms);
  }

  private editorText(): string {
    try {
      return this.host.getEditorText?.() ?? "";
    } catch {
      return "";
    }
  }

  private setEditorText(text: string): void {
    try {
      this.host.setEditorText?.(text);
    } catch {
      // Editor sync is best-effort.
    }
  }

  private closeUtterance(): void {
    const after = this.utterance;
    this.utterance = null;
    if (after) void after.close().catch(() => undefined);
  }

  private submitText(clean: string, mode: string): void {
    const busy = !this.host.isIdle();
    this.log("delivery", { mode, followUp: busy, length: clean.length });
    try {
      if (busy) this.host.sendUserMessage(clean, { deliverAs: "followUp" });
      else this.host.sendUserMessage(clean);
    } catch (err) {
      this.host.notify(`Voice submit failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    (this.deps.playCue ?? defaultPlayCue)();
    this.closeUtterance();
    if (!this.closed) this.setPhase("wake", "🎙 listening");
  }

  private submitDraft(): boolean {
    const draft = this.editorText().trim();
    if (draft === "") return false;
    const busy = !this.host.isIdle();
    this.log("delivery", { mode: "draft", followUp: busy, length: draft.length });
    try {
      if (busy) this.host.sendUserMessage(draft, { deliverAs: "followUp" });
      else this.host.sendUserMessage(draft);
      this.setEditorText("");
    } catch (err) {
      this.host.notify(`Voice submit failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    (this.deps.playCue ?? defaultPlayCue)();
    this.closeUtterance();
    if (!this.closed) this.setPhase("wake", "🎙 listening");
    return true;
  }

  private finishBlank(partialFallback: boolean): void {
    this.closeUtterance();
    this.playErrorCue();
    this.log("stt-end", partialFallback ? { reason: "blank", source: "partial-fallback" } : { reason: "blank" });
    if (this.closed) return;
    const gen = this.generation;
    this.setPhase("wake", "🎙 didn't catch that");
    this.later(() => {
      if (!this.closed && gen === this.generation && this.phase === "wake") this.host.setStatus("🎙 listening");
    }, TRANSIENT_STATUS_MS);
  }

  private logSttEvent(type: string, info?: Record<string, unknown>): void {
    const { text: _dropped, ...rest } = info ?? {};
    void _dropped;
    this.log("stt-event", { type, ...rest });
  }

  private onPartial(text: string, gen: number): void {
    if (this.closed || gen !== this.generation || this.phase !== "capture") return;
    if (this.committed) return;
    this.lastPartial = text.trim();
    this.maybeCaptureStatus();
  }

  private onFinal(text: string, gen: number): void {
    if (this.closed || gen !== this.generation) return;
    if (this.submitted) return;
    this.submitted = true;
    this.clearNoSpeechTimer();
    this.closeEndpointer();
    const clean = text.trim();
    const intent = parseTranscriptIntent(text);
    this.log("intent", { kind: intent.kind, length: clean.length });
    if (intent.kind === "empty" || clean === "") {
      this.finishBlank(false);
      return;
    }
    if (intent.kind === "send") {
      if (this.submitDraft()) return;
      if (this.closed) return;
      this.setPhase("wake", "📝 nothing to send");
      const g = this.generation;
      this.later(() => {
        if (!this.closed && g === this.generation && this.phase === "wake") this.host.setStatus("🎙 listening");
      }, TRANSIENT_STATUS_MS);
      return;
    }
    const prefs = this.deps.getPrefs();
    if (prefs.sendMode === "review") {
      if (intent.thenSend) {
        const combined = `${this.editorText()} ${intent.text}`.trim();
        this.setEditorText("");
        if (combined === "") {
          this.finishBlank(false);
          return;
        }
        this.submitText(combined, "review-send");
        return;
      }
      const draft = this.editorText();
      this.setEditorText(draft === "" ? intent.text : `${draft} ${intent.text}`);
      this.log("delivery", { mode: "review-append", length: intent.text.length });
      this.closeUtterance();
      if (!this.closed) this.setPhase("wake", '📝 draft · Enter or say "send to pi"');
      return;
    }
    this.submitText(intent.text, "auto");
  }

  private onEnd(info: SttEndInfo, gen: number): void {
    if (this.closed || gen !== this.generation) return;
    this.clearNoSpeechTimer();
    this.closeEndpointer();
    if (info.source === "partial-fallback") this.log("stt-end", { reason: info.reason, source: info.source });
    if (this.submitted) return;
    if (info.reason === "final" && info.text.trim() !== "") {
      this.onFinal(info.text, gen);
      return;
    }
    if (info.reason === "blank" || (info.reason === "final" && info.text.trim() === "")) {
      this.submitted = true;
      this.finishBlank(info.source === "partial-fallback");
      return;
    }
    this.closeUtterance();
  }

  private onSttFailure(f: VoiceFailure, gen: number): void {
    if (this.closed || gen !== this.generation) return;
    this.clearNoSpeechTimer();
    this.closeEndpointer();
    this.closeUtterance();
    this.log("failure", { code: f.code, messageLength: f.message.length, retryable: f.retryable });
    if (
      !f.retryable ||
      f.code === "auth" ||
      f.code === "terms" ||
      f.code === "quota" ||
      f.code === "mic" ||
      f.code === "key_missing"
    ) {
      void (async (): Promise<void> => {
        await this.stopQuiet();
        if (!this.closed && gen === this.generation) {
          this.setPhase("off", "voice off");
          this.host.notify(`Voice stopped: ${f.message}`, "error");
        }
      })();
      return;
    }
    const at = this.now();
    const last = this.failureNotifiedAt.get(f.code) ?? Number.NEGATIVE_INFINITY;
    if (at - last >= FAILURE_NOTIFY_DEDUP_MS) {
      this.failureNotifiedAt.set(f.code, at);
      this.host.notify(f.message, "warning");
    }
    this.playErrorCue();
    this.setPhase("wake", `⚠ ${truncate(f.message, 80)}`);
    const backoff = this.deps.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.later(() => {
      if (!this.closed && gen === this.generation && this.phase === "wake") this.host.setStatus("🎙 listening");
    }, backoff);
  }

  // ---- TTS ----

  private ttsActive(): boolean {
    const prefs = this.deps.getPrefs();
    return prefs.tts && this.deps.getKey() !== undefined && (prefs.voiceId ?? "") !== "";
  }

  /** Stream an assistant text delta into speech. Only text_delta qualifies. */
  onMessageUpdate(message: { role?: string }, eventType: string, delta: string): void {
    if (this.closed) return;
    if (message.role !== "assistant" || eventType !== "text_delta") return;
    if (!this.ttsActive() || delta === "") return;
    const tail = this.speechQueue[this.speechQueue.length - 1];
    if (tail && !tail.ended) {
      tail.deltas.push(delta);
      try {
        tail.chunker?.push(delta);
      } catch {
        // Chunker never throws for text; guard anyway.
      }
      return;
    }
    // New assistant message. Buffer its text until the active message finishes:
    // only the head owns a socket/chunker, so later deltas can never land in
    // a finished chunker. (Text buffered, socket opened at promotion: one live
    // TTS socket keeps cancellation/ownership single-context.)
    const entry: QueuedSpeech = { gen: this.generation, deltas: [delta], ended: false, chunker: null, speech: null };
    this.speechQueue.push(entry);
    if (this.speechQueue[0] === entry) this.startQueued(entry);
  }

  /** Finish or cancel speech at the end of an assistant message. */
  onMessageEnd(message: { role?: string; stopReason?: string }, isAssistant: boolean): void {
    if (this.closed || !isAssistant) return;
    if (message.role !== undefined && message.role !== "assistant") return;
    const stop = message.stopReason;
    if (stop === "aborted" || stop === "error") {
      // Cancel that message's speech and everything queued after it; earlier
      // messages already playing keep their audio.
      let at = this.speechQueue.length - 1;
      for (let i = this.speechQueue.length - 1; i >= 0; i--) {
        if (!this.speechQueue[i]?.ended) at = i;
      }
      if (at >= 0) {
        const dropped = this.speechQueue.splice(at);
        for (const item of dropped) {
          try {
            item.chunker?.cancel();
          } catch {
            // Ignore teardown errors.
          }
          if (item.speech) {
            const s = item.speech;
            item.speech = null;
            try {
              s.cancel();
            } catch {
              // Already settled.
            }
          }
        }
        if (at === 0) {
          this.speech = null;
          this.chunker = null;
        }
      }
      if (this.phase === "speaking") this.setPhase("wake", "\u{1F399} listening");
      return;
    }
    const last = this.speechQueue[this.speechQueue.length - 1];
    if (!last || last.ended) return;
    last.ended = true;
    if (last !== this.speechQueue[0]) return; // replayed + finished at promotion
    const gen = this.generation;
    try {
      this.chunker?.finish();
    } catch {
      // Finish is best-effort; speech completes via onDone/onFailure.
    }
    try {
      this.speech?.finish();
    } catch {
      this.onSpeechFailure({ code: "protocol", message: "speech failed (protocol)", retryable: true }, gen);
    }
  }

  /** A new user turn cancels playback (barge-in by typing). */
  onInput(): void {
    if (this.closed) return;
    if (this.speechQueue.length === 0) return;
    this.cancelSpeech();
    if (this.phase === "speaking") this.setPhase("wake", "🎙 listening");
  }

  /** Cancel speech from /voice tts off, /voice off, wake, or shutdown. */
  cancelSpeech(): void {
    for (const item of this.speechQueue) {
      try {
        item.chunker?.cancel();
      } catch {
        // Ignore teardown errors.
      }
      if (item.speech) {
        try {
          item.speech.cancel();
        } catch {
          // Already settled.
        }
      }
    }
    this.speechQueue = [];
    this.chunker = null;
    this.speech = null;
  }

  private onSpeechDone(gen: number, entry?: QueuedSpeech): void {
    if (this.closed || gen !== this.generation) return;
    if (entry) {
      if (this.speechQueue[0] !== entry) return;
      this.speechQueue.shift();
    }
    this.speech = null;
    this.chunker = null;
    this.advanceSpeechQueue(gen);
  }

  private onSpeechFailure(f: VoiceFailure, gen: number, entry?: QueuedSpeech): void {
    if (this.closed || gen !== this.generation) return;
    if (entry) {
      if (this.speechQueue[0] !== entry) return;
      this.speechQueue.shift();
    }
    this.speech = null;
    this.chunker = null;
    if (this.isTerminalSpeechFailure(f)) {
      // Auth/quota/non-retryable: queued items would fail the same way, so
      // drop them without opening new sockets and notify once.
      const rest = this.speechQueue.splice(0);
      for (const item of rest) {
        try {
          item.chunker?.cancel();
        } catch {
          // Ignore teardown errors.
        }
        if (item.speech) {
          try {
            item.speech.cancel();
          } catch {
            // Already settled.
          }
        }
      }
      if (this.phase === "speaking") this.setPhase("wake", "🎙 listening");
      this.host.notify(`Speech failed: ${f.message}`, "warning");
      this.advanceSpeechQueue(gen);
      return;
    }
    if (this.phase === "speaking") this.setPhase("wake", "🎙 listening");
    this.host.notify(`Speech failed: ${f.message}`, "warning");
    this.advanceSpeechQueue(gen);
  }

  /** Non-retryable TTS failures: retrying queued items would fail the same way. */
  private isTerminalSpeechFailure(f: VoiceFailure): boolean {
    return !f.retryable || f.code === "auth" || f.code === "quota";
  }

  /** Promote the next queued entry, or cooldown + detector reset when empty. */
  private advanceSpeechQueue(gen: number): void {
    if (this.speechQueue.length > 0) {
      this.promoteQueued();
      return;
    }
    const cooldown = this.deps.cooldownMs ?? COOLDOWN_MS;
    this.later(() => {
      if (this.closed || gen !== this.generation) return;
      try {
        this.detector?.reset();
      } catch {
        // Reset is best-effort.
      }
      if (this.phase === "speaking" || this.phase === "submit") this.setPhase("wake", "🎙 listening");
    }, cooldown);
  }

  /** Open socket + chunker for the head entry and replay its buffered deltas. */
  private startQueued(entry: QueuedSpeech): void {
    const prefs = this.deps.getPrefs();
    const key = this.deps.getKey();
    if (!key || !prefs.voiceId) {
      this.speechQueue.splice(this.speechQueue.indexOf(entry), 1);
      return;
    }
    const gen = entry.gen;
    const chunker = createSpeechChunker((chunk) => {
      if (!this.closed && gen === this.generation && this.speechQueue[0] === entry) {
        try {
          this.speech?.push(chunk);
        } catch {
          // Push errors surface via onFailure.
        }
      }
    });
    this.chunker = chunker;
    entry.chunker = chunker;
    const modelId = prefs.ttsModel && prefs.ttsModel.length > 0 ? prefs.ttsModel : DEFAULT_TTS_MODEL;
    try {
      entry.speech = this.deps.openSpeech({
        key,
        voiceId: prefs.voiceId,
        modelId,
        onDone: () => this.onSpeechDone(gen, entry),
        onFailure: (f) => this.onSpeechFailure(f, gen, entry),
      });
    } catch {
      entry.chunker = null;
      this.chunker = null;
      this.speechQueue.splice(this.speechQueue.indexOf(entry), 1);
      this.promoteQueued();
      return;
    }
    this.speech = entry.speech;
    if (this.phase === "wake" || this.phase === "capture" || this.phase === "submit") {
      this.setPhase("speaking", "🔊 speaking");
    }
    for (const d of entry.deltas) {
      try {
        chunker.push(d);
      } catch {
        // Guard anyway.
      }
    }
    if (entry.ended) {
      try {
        chunker.finish();
      } catch {
        // Finish is best-effort; speech completes via onDone/onFailure.
      }
      try {
        entry.speech.finish();
      } catch {
        this.onSpeechFailure({ code: "protocol", message: "speech failed (protocol)", retryable: true }, gen, entry);
      }
    }
  }

  /** Promote the next queued message to the live socket. */
  private promoteQueued(): void {
    const next = this.speechQueue[0];
    if (!next || this.closed) return;
    if (!this.ttsActive()) {
      this.cancelSpeech();
      return;
    }
    this.startQueued(next);
  }
}
