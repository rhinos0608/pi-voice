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
};

export const DEFAULT_TTS_MODEL = "eleven_v4_turbo";
export const FALLBACK_TTS_MODEL = "eleven_flash_v2_5";
const OUTPUT_FORMAT = "pcm_24000";

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
  const createSocket =
    deps?.socketFactory ??
    ((url: string, init: { headers: Record<string, string> }): TtsSocket => {
      const ws = new WebSocket(url, { headers: init.headers });
      return {
        send: (data: string): void => {
          ws.send(data);
        },
        close: (): void => {
          ws.close();
        },
        on: (event: "open" | "message" | "error" | "close", handler: (arg: unknown) => void): void => {
          if (event === "message") {
            ws.on("message", (data: unknown) => handler(data));
          } else {
            ws.on(event, handler);
          }
        },
      };
    });

  const withModelHint = (failure: VoiceFailure, rawText: string): VoiceFailure => {
    if (failure.message.includes("/voice model")) return failure;
    if (!/model/i.test(rawText)) return failure;
    return {
      ...failure,
      message: `${failure.message}; if the model was rejected, try /voice model ${FALLBACK_TTS_MODEL}`,
    };
  };
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}` +
    `/stream-input?model_id=${encodeURIComponent(modelId)}&output_format=${OUTPUT_FORMAT}`;
  const socket = createSocket(url, { headers: { "xi-api-key": key } });

  let settled = false;
  let cancelled = false;
  let finished = false;
  let chain: Promise<void> = Promise.resolve();
  let generation = 0;

  void sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" }).catch((err: unknown) => {
    failOnce(classifyUnknown(err));
  });

  function failOnce(failure: VoiceFailure): void {
    if (settled || cancelled) return;
    settled = true;
    generation += 1;
    try {
      socket.close();
    } catch {
      // socket already closed
    }
    void sink.stop().catch(() => undefined);
    onFailure(failure);
  }

  function classifyUnknown(err: unknown): VoiceFailure {
    if (err instanceof Error) {
      const text = `${err.name} ${err.message}`;
      return withModelHint(classifyErrorText(text), text);
    }
    return fail("protocol", true);
  }

  function doneOnce(): void {
    if (settled || cancelled) return;
    settled = true;
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
      failOnce(withModelHint(classifyErrorText(serverError), serverError));
      return;
    }
    const finalFlag = msg.isFinal === true || msg.is_final === true;
    if (typeof msg.audio === "string" && msg.audio.length > 0) {
      const bytes = Buffer.from(msg.audio, "base64");
      chain = chain.then(() => {
        if (settled || cancelled || gen !== generation) return;
        return sink.write(bytes);
      });
    }
    if (finalFlag || msg.audio === null || msg.audio === undefined) {
      if (finalFlag || msg.audio === null) {
        finished = true;
        chain = chain.then(async () => {
          if (settled || cancelled || gen !== generation) return;
          try {
            await sink.finish();
          } catch (err: unknown) {
            failOnce(classifyUnknown(err));
            return;
          }
          doneOnce();
        });
      }
    }
  }

  socket.on("open", () => {
    if (cancelled) return;
    try {
      sendInit();
    } catch (err: unknown) {
      failOnce(classifyUnknown(err));
    }
  });
  socket.on("message", (data: unknown) => handleRawMessage(data));
  socket.on("error", (err: unknown) => {
    failOnce(classifyUnknown(err));
  });
  socket.on("close", (info: unknown) => {
    if (settled || cancelled) return;
    const detail = info as { code?: unknown; reason?: unknown } | number | null;
    const code = typeof detail === "number" ? detail : typeof detail?.code === "number" ? detail.code : 0;
    if (finished) {
      const seen = generation;
      chain = chain.then(async () => {
        if (settled || cancelled || seen !== generation) return;
        try {
          await sink.finish();
        } catch (err: unknown) {
          failOnce(classifyUnknown(err));
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
          failOnce(classifyUnknown(err));
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
      try {
        socket.send(JSON.stringify({ text: `${text} `, try_trigger_generation: false, flush: false }));
      } catch (err: unknown) {
        failOnce(classifyUnknown(err));
      }
    },
    finish(): void {
      if (settled || cancelled || finished) return;
      finished = true;
      try {
        socket.send(JSON.stringify({ text: "" }));
      } catch (err: unknown) {
        failOnce(classifyUnknown(err));
      }
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
