/** Inworld streaming TTS over one WebSocket per assistant message. */

import type { AudioSink, VoiceFailure } from "./contracts.ts";
import { createWsTtsSocket, TtsHttpError } from "./tts.ts";
import type { Speech, StartSpeechDeps, StartSpeechOptions } from "./tts.ts";

/** Quality model (~100 ms TTFB) and low-latency flash model (~20 ms). */
export const INWORLD_TTS_MODELS: readonly string[] = ["inworld-tts-2", "inworld-tts-2-flash"];
export const DEFAULT_INWORLD_MODEL = "inworld-tts-2";
export const DEFAULT_INWORLD_VOICE = "Ashley";
export const INWORLD_TTS_URL = "wss://api.inworld.ai/tts/v1/voice:streamBidirectional";

const CONTEXT_ID = "c1";
const MAX_TEXT_UNITS = 2000;
const MAX_REASON = 200;

function fail(code: VoiceFailure["code"], retryable: boolean): VoiceFailure {
  return { code, message: `speech failed (${code})`, retryable };
}

function withReason(base: VoiceFailure, reason: string): VoiceFailure {
  const trimmed = reason.trim();
  if (trimmed === "") return base;
  const short = trimmed.length > MAX_REASON ? `${trimmed.slice(0, MAX_REASON)}…` : trimmed;
  return { ...base, message: `${base.message}: ${short}` };
}

function withVoiceHint(failure: VoiceFailure, serverMessage: string): VoiceFailure {
  if (!/voice/i.test(serverMessage)) return failure;
  if (failure.message.includes("/voice list")) return failure;
  return { ...failure, message: `${failure.message}; try /voice list to see available voices` };
}

/** Classify by HTTP status, never by body digits. */
function classifyHttpRejection(err: TtsHttpError): VoiceFailure {
  if (err.status === 401 || err.status === 403) return fail("auth", false);
  if (err.status === 402) return fail("quota", false);
  if (err.status === 429) return fail("rate", true);
  if (err.status >= 500) return fail("network", true);
  return fail("protocol", false);
}

function classifyGrpc(code: number, message: string): VoiceFailure {
  if (code === 16 || code === 7) return withReason(fail("auth", false), message);
  if (code === 8) {
    if (/quota|credit|billing|balance/i.test(message)) return withReason(fail("quota", false), message);
    return withReason(fail("rate", true), message);
  }
  if (code === 3 || code === 5) return withVoiceHint(withReason(fail("protocol", false), message), message);
  if (code === 14 || code === 4 || code === 13) return withReason(fail("network", true), message);
  return withReason(fail("protocol", false), message);
}

/** Split text longer than the server limit, preferring whitespace boundaries. */
/** True when slicing at `end` would split a surrogate pair (keeps chunks <=2000 units). */
function isSplitSurrogate(text: string, end: number): boolean {
  if (end <= 0 || end >= text.length) return false;
  const prev = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

function splitText(text: string): string[] {
  if (text.length <= MAX_TEXT_UNITS) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + MAX_TEXT_UNITS, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      let cut = -1;
      for (let i = window.length - 1; i >= 0; i--) {
        if (/\s/.test(window[i])) {
          cut = i;
          break;
        }
      }
      if (cut > 0) end = start + cut + 1;
      else if (isSplitSurrogate(text, end)) end -= 1;
    }
    out.push(text.slice(start, end));
    if (end <= start) break;
    start = end;
  }
  return out;
}

function fallbackMissingSink(): AudioSink {
  return {
    async start(): Promise<void> {
      throw new Error("speech sink unavailable");
    },
    async write(): Promise<void> {
      throw new Error("speech sink unavailable");
    },
    async finish(): Promise<void> {
      throw new Error("speech sink unavailable");
    },
    async stop(): Promise<void> {
      // nothing to stop
    },
  };
}

/**
 * Start one Inworld streaming TTS generation. Opens a single-context
 * socket, streams sentence chunks with flushContext, decodes base64 PCM
 * audio into the sink in order, and calls onDone after the sink drains.
 * cancel() closes the socket, stops the sink, and suppresses later callbacks.
 */
export function startInworldSpeech(options: StartSpeechOptions, deps?: StartSpeechDeps): Speech {
  const { key, voiceId, modelId = DEFAULT_INWORLD_MODEL, onDone, onFailure } = options;
  const sink: AudioSink = deps?.sinkFactory !== undefined ? deps.sinkFactory() : fallbackMissingSink();
  const createSocket = deps?.socketFactory ?? createWsTtsSocket;
  const startedAt = Date.now();
  let chunks = 0;
  let bytes = 0;
  const log = (event: string, data?: Record<string, unknown>): void => {
    try {
      deps?.log?.(event, data);
    } catch {
      // Debug sink must never break speech.
    }
  };
  const elapsed = (): number => Date.now() - startedAt;

  log("tts-ws-connect", { modelId, voiceId });
  const socket = createSocket(INWORLD_TTS_URL, { headers: { Authorization: `Basic ${key}` } });

  let settled = false;
  let cancelled = false;
  let finishSent = false;
  let closedReceived = false;
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  let opened = false;
  const outbox: string[] = [];

  void sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" }).catch((err: unknown) => {
    failFrom("sink-start", err);
  });

  /** Log the raw cause (classification alone loses it), then fail. */
  function failFrom(stage: string, err: unknown): void {
    if (settled || cancelled) return;
    log("tts-ws-cause", { stage, detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    failOnce(classifyUnknown(err));
  }

  function sendFrame(payload: Record<string, unknown>): void {
    const data = JSON.stringify(payload);
    if (!opened) {
      outbox.push(data);
      return;
    }
    try {
      socket.send(data);
    } catch (err: unknown) {
      failFrom("send", err);
    }
  }

  function failOnce(failure: VoiceFailure): void {
    if (settled || cancelled) return;
    settled = true;
    generation += 1;
    log("tts-ws-failure", { code: failure.code, retryable: failure.retryable, detail: failure.message, ms: elapsed() });
    try {
      socket.close();
    } catch {
      // socket already closed
    }
    void sink.stop().catch(() => undefined);
    onFailure(failure);
  }

  function classifyUnknown(err: unknown): VoiceFailure {
    if (err instanceof TtsHttpError) return classifyHttpRejection(err);
    return fail("network", true);
  }

  function doneOnce(): void {
    if (settled || cancelled) return;
    settled = true;
    log("tts-ws-done", { chunks, bytes, ms: elapsed() });
    try {
      socket.close();
    } catch {
      // socket already closed
    }
    onDone();
  }

  function sendCreate(): void {
    socket.send(
      JSON.stringify({
        contextId: CONTEXT_ID,
        create: {
          voiceId,
          modelId,
          audioConfig: { audioEncoding: "PCM", sampleRateHertz: 24000 },
        },
      }),
    );
  }

  function handleRawMessage(data: unknown): void {
    if (settled || cancelled) return;
    const gen = generation;
    let text: string;
    if (typeof data === "string") text = data;
    else if (Buffer.isBuffer(data)) text = data.toString("utf8");
    else return;
    let msg: {
      error?: unknown;
      result?: unknown;
    };
    try {
      msg = JSON.parse(text) as { error?: unknown; result?: unknown };
    } catch {
      failOnce(fail("protocol", true));
      return;
    }
    const topError = msg.error as { code?: unknown; message?: unknown } | undefined;
    if (topError !== null && typeof topError === "object" && topError !== undefined) {
      const code = typeof topError.code === "number" ? topError.code : Number(topError.code);
      const message = typeof topError.message === "string" ? topError.message : "";
      if (Number.isFinite(code)) {
        failOnce(classifyGrpc(code, message));
        return;
      }
      failOnce(withReason(fail("protocol", false), message));
      return;
    }
    const result = msg.result as
      | {
          audioChunk?: unknown;
          audioContent?: unknown;
          contextCreated?: unknown;
          flushCompleted?: unknown;
          contextClosed?: unknown;
          status?: unknown;
        }
      | undefined;
    if (result === null || typeof result !== "object" || result === undefined) return;
    const status = result.status as { code?: unknown; message?: unknown } | undefined;
    if (status !== null && typeof status === "object" && status !== undefined) {
      const code = typeof status.code === "number" ? status.code : Number(status.code);
      if (Number.isFinite(code) && code !== 0) {
        const message = typeof status.message === "string" ? status.message : "";
        failOnce(classifyGrpc(code, message));
        return;
      }
    }
    if (result.contextClosed !== undefined && result.contextClosed !== null) {
      closedReceived = true;
      log("tts-ws-final", { chunks, bytes, ms: elapsed() });
      const seen = gen;
      chain = chain.then(async () => {
        if (settled || cancelled || seen !== generation) return;
        try {
          await sink.finish();
        } catch (err: unknown) {
          failFrom("sink-finish", err);
          return;
        }
        doneOnce();
      });
      return;
    }
    let audioBase64: string | null = null;
    const chunk = result.audioChunk as { audioContent?: unknown } | undefined;
    if (chunk !== null && typeof chunk === "object" && chunk !== undefined && typeof chunk.audioContent === "string") {
      audioBase64 = chunk.audioContent;
    } else if (typeof result.audioContent === "string") {
      audioBase64 = result.audioContent;
    }
    if (audioBase64 !== null && audioBase64.length > 0) {
      const audio = Buffer.from(audioBase64, "base64");
      if (chunks === 0) log("tts-ws-first-audio", { bytes: audio.length, ms: elapsed() });
      chunks += 1;
      bytes += audio.length;
      chain = chain
        .then(async () => {
          if (settled || cancelled || gen !== generation) return;
          try {
            await sink.write(audio);
          } catch (err: unknown) {
            failFrom("sink-write", err);
          }
        })
        .catch(() => undefined);
    }
  }

  socket.on("open", () => {
    if (settled || cancelled) return;
    log("tts-ws-open", { ms: elapsed(), queued: outbox.length });
    try {
      sendCreate();
      opened = true;
      for (const data of outbox.splice(0)) socket.send(data);
    } catch (err: unknown) {
      failFrom("open", err);
    }
  });
  socket.on("message", (data: unknown) => handleRawMessage(data));
  socket.on("error", (err: unknown) => {
    if (settled || cancelled) return;
    if (err instanceof TtsHttpError) {
      log("tts-ws-rejected", { status: err.status, ms: elapsed() });
    } else {
      log("tts-ws-error", { detail: err instanceof Error ? err.message : String(err), ms: elapsed() });
    }
    failOnce(classifyUnknown(err));
  });
  socket.on("close", () => {
    if (settled || cancelled || closedReceived) return;
    log("tts-ws-close", { ms: elapsed() });
    failOnce(fail("network", true));
  });

  return {
    push(text: string): void {
      if (settled || cancelled || finishSent || text.length === 0) return;
      for (const part of splitText(text)) {
        if (settled || cancelled || finishSent) return;
        sendFrame({ contextId: CONTEXT_ID, sendText: { text: part, flushContext: {} } });
      }
    },
    finish(): void {
      if (settled || cancelled || finishSent) return;
      finishSent = true;
      sendFrame({ contextId: CONTEXT_ID, closeContext: {} });
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      generation += 1;
      settled = true;
      try {
        socket.close();
      } catch {
        // socket already closed
      }
      void sink.stop().catch(() => undefined);
    },
  };
}
