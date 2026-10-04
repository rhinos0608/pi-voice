/** ElevenLabs streaming TTS over one WebSocket per assistant message (lane D). */

import WebSocket from "ws";
import type { AudioSink, VoiceFailure } from "./contracts.ts";

export type Speech = {
  push(text: string): void;
  finish(): void;
  cancel(): void;
};

export type StartSpeechOptions = {
  key: string;
  voiceId: string;
  modelId?: string;
  onDone: () => void;
  onFailure: (failure: VoiceFailure) => void;
};

export type TtsSocket = {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "error" | "close", handler: (arg: unknown) => void): void;
};

export type StartSpeechDeps = {
  socketFactory?: (url: string, options: { headers: Record<string, string> }) => TtsSocket;
  sinkFactory?: () => AudioSink;
  log?: (event: string, data?: Record<string, unknown>) => void;
};

/** eleven_v4_* models are rejected by stream-input (HTTP 400 unsupported_model; text-to-dialogue only). */
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
export const FALLBACK_TTS_MODEL = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_24000";
const MAX_REJECTION_BODY = 2000;
const MAX_REASON = 200;

/** The server refused the WebSocket upgrade; carries the response body that says why. */
export class TtsHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}`);
    this.name = "TtsHttpError";
    this.status = status;
    this.body = body;
  }
}

/** Default ws-backed socket. Upgrade rejections surface as TtsHttpError via the error handlers. */
export function createWsTtsSocket(url: string, init: { headers: Record<string, string> }): TtsSocket {
  const ws = new WebSocket(url, { headers: init.headers });
  const errorHandlers: ((arg: unknown) => void)[] = [];
  const emitError = (err: unknown): void => {
    for (const handler of errorHandlers) handler(err);
  };
  // Without this listener ws reports only "Unexpected server response: 400"
  // and discards the body naming the cause (e.g. unsupported_model).
  ws.on("unexpected-response", (_req, res) => {
    let body = "";
    let reported = false;
    const report = (): void => {
      if (reported) return;
      reported = true;
      emitError(new TtsHttpError(res.statusCode ?? 0, body.slice(0, MAX_REJECTION_BODY)));
      ws.terminate();
    };
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      if (body.length < MAX_REJECTION_BODY) body += chunk;
    });
    res.on("end", report);
    res.on("error", report);
  });
  ws.on("error", emitError);
  return {
    send: (data: string): void => {
      ws.send(data);
    },
    close: (): void => {
      ws.close();
    },
    on: (event: "open" | "message" | "error" | "close", handler: (arg: unknown) => void): void => {
      if (event === "error") errorHandlers.push(handler);
      else if (event === "message") ws.on("message", (data: unknown) => handler(data));
      else ws.on(event, handler);
    },
  };
}

/** Human-readable reason from an ElevenLabs error body ({detail: {message}} or {detail: "..."}). */
function serverReason(body: string): string {
  let reason = body.trim();
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
    const detail = parsed.detail as { message?: unknown } | string | undefined;
    if (typeof detail === "string") reason = detail;
    else if (typeof detail?.message === "string") reason = detail.message;
    else if (typeof parsed.message === "string") reason = parsed.message;
  } catch {
    // Not JSON: keep the raw text.
  }
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason;
}

/** Classify by HTTP status, never by body digits (request ids can contain "401"/"429"). */
function classifyHttpRejection(err: TtsHttpError): VoiceFailure {
  const base =
    err.status === 401 || err.status === 403
      ? fail("auth", false)
      : err.status === 402
        ? fail("quota", false)
        : err.status === 429
          ? fail("rate", true)
          : err.status >= 500
            ? fail("network", true)
            : fail("protocol", false);
  const reason = serverReason(err.body);
  return { ...base, message: `${base.message}: ${reason === "" ? `HTTP ${err.status}` : reason}` };
}

/** v4 models accept only stability + similarity_boost; style/speed/speaker boost are unavailable. */
function voiceSettingsFor(modelId: string): Record<string, number | boolean> {
  if (modelId.startsWith("eleven_v4")) return { stability: 0.5, similarity_boost: 0.8 };
  return { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false };
}

function fail(code: VoiceFailure["code"], retryable: boolean): VoiceFailure {
  return { code, message: `speech failed (${code})`, retryable };
}

function classifyErrorText(text: string): VoiceFailure {
  const lower = text.toLowerCase();
  if (lower.includes("invalid_api_key") || lower.includes("unauthorized") || lower.includes("401")) {
    return fail("auth", false);
  }
  if (lower.includes("quota") || lower.includes("payment") || lower.includes("402") || lower.includes("unaccepted_terms")) {
    return fail("quota", false);
  }
  if (lower.includes("rate_limited") || lower.includes("429") || lower.includes("throttle")) {
    return fail("rate", true);
  }
  if (lower.includes("econn") || lower.includes("enotfound") || lower.includes("etimedout") || lower.includes("network") || lower.includes("socket")) {
    return fail("network", true);
  }
  return fail("protocol", true);
}

/**
 * Start one streaming TTS generation. Opens a single-context socket,
 * streams text chunks with trailing spaces, decodes base64 audio into the
 * sink in order, and calls onDone after the sink drains. cancel() closes
 * the socket, stops the sink, and suppresses later callbacks.
 */
export function startSpeech(options: StartSpeechOptions, deps?: StartSpeechDeps): Speech {
  const { key, voiceId, modelId = DEFAULT_TTS_MODEL, onDone, onFailure } = options;
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

  const withModelHint = (failure: VoiceFailure, rawText: string): VoiceFailure => {
    if (failure.message.includes("/voice model") || modelId === FALLBACK_TTS_MODEL) return failure;
    if (!/model/i.test(rawText)) return failure;
    return {
      ...failure,
      message: `${failure.message}; if the model was rejected, try /voice model ${FALLBACK_TTS_MODEL}`,
    };
  };
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}` +
    `/stream-input?model_id=${encodeURIComponent(modelId)}&output_format=${OUTPUT_FORMAT}`;
  log("tts-ws-connect", { modelId, voiceId });
  const socket = createSocket(url, { headers: { "xi-api-key": key } });

  let settled = false;
  let cancelled = false;
  let finished = false;
  let chain: Promise<void> = Promise.resolve();
  let generation = 0;
  // ws throws on send() while CONNECTING, and init must be the first frame,
  // so text pushed before open waits here.
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

  function send(payload: Record<string, unknown>): void {
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
    if (err instanceof TtsHttpError) return withModelHint(classifyHttpRejection(err), err.body);
    if (err instanceof Error) {
      const text = `${err.name} ${err.message}`;
      return withModelHint(classifyErrorText(text), text);
    }
    return fail("protocol", true);
  }

  function doneOnce(): void {
    if (settled || cancelled) return;
    settled = true;
    log("tts-ws-done", { chunks, bytes, ms: elapsed() });
    onDone();
  }

  function sendInit(): void {
    socket.send(
      JSON.stringify({
        text: " ",
        voice_settings: voiceSettingsFor(modelId),
        generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
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
      audio?: unknown;
      isFinal?: unknown;
      is_final?: unknown;
      error?: unknown;
      message_type?: unknown;
    };
    try {
      msg = JSON.parse(text) as {
        audio?: unknown;
        isFinal?: unknown;
        is_final?: unknown;
        error?: unknown;
        message_type?: unknown;
      };
    } catch {
      log("tts-ws-bad-frame", { length: text.length });
      failOnce(fail("protocol", true));
      return;
    }
    const serverError =
      typeof msg.error === "string"
        ? msg.error
        : typeof msg.message_type === "string" && /error|invalid|reject|unsupported/i.test(msg.message_type)
          ? msg.message_type
          : null;
    if (serverError !== null) {
      log("tts-ws-server-error", { detail: serverError.slice(0, MAX_REASON) });
      failOnce(withModelHint(classifyErrorText(serverError), serverError));
      return;
    }
    const finalFlag = msg.isFinal === true || msg.is_final === true;
    if (typeof msg.audio === "string" && msg.audio.length > 0) {
      const audio = Buffer.from(msg.audio, "base64");
      if (chunks === 0) log("tts-ws-first-audio", { bytes: audio.length, ms: elapsed() });
      chunks += 1;
      bytes += audio.length;
      chain = chain.then(() => {
        if (settled || cancelled || gen !== generation) return;
        return sink.write(audio);
      });
    }
    if (finalFlag || msg.audio === null || msg.audio === undefined) {
      if (finalFlag || msg.audio === null) {
        finished = true;
        log("tts-ws-final", { chunks, bytes, ms: elapsed() });
        chain = chain.then(async () => {
          if (settled || cancelled || gen !== generation) return;
          try {
            await sink.finish();
          } catch (err: unknown) {
            failFrom("sink-finish", err);
            return;
          }
          doneOnce();
        });
      }
    }
  }

  socket.on("open", () => {
    if (settled || cancelled) return;
    log("tts-ws-open", { ms: elapsed(), queued: outbox.length });
    try {
      sendInit();
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
      log("tts-ws-rejected", { status: err.status, detail: serverReason(err.body), ms: elapsed() });
    } else {
      log("tts-ws-error", { detail: err instanceof Error ? err.message : String(err), ms: elapsed() });
    }
    failOnce(classifyUnknown(err));
  });
  socket.on("close", (info: unknown) => {
    if (settled || cancelled) return;
    const detail = info as { code?: unknown; reason?: unknown } | number | null;
    const code = typeof detail === "number" ? detail : typeof detail?.code === "number" ? detail.code : 0;
    log("tts-ws-close", { code, finished, ms: elapsed() });
    if (!opened) {
      failOnce(fail("network", true));
      return;
    }
    if (finished) {
      const seen = generation;
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
    if (code === 1000 || code === 0) {
      const gen = generation;
      chain = chain.then(async () => {
        if (settled || cancelled || gen !== generation) return;
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
    if (code === 1008 || code === 4001) failOnce(fail("auth", false));
    else if (code === 4029 || code === 4020) failOnce(fail("quota", false));
    else if (code === 4027 || code === 4290) failOnce(fail("rate", true));
    else failOnce(fail("network", true));
  });

  return {
    push(text: string): void {
      if (settled || cancelled || finished || text.length === 0) return;
      send({ text: `${text} `, try_trigger_generation: false, flush: false });
    },
    finish(): void {
      if (settled || cancelled || finished) return;
      finished = true;
      send({ text: "" });
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
