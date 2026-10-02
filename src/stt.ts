import * as WebSocket from "ws";
import type { VoiceFailure } from "./contracts.ts";

export const STT_URL =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime" +
  "?model_id=scribe_v2_realtime" +
  "&audio_format=pcm_16000" +
  "&commit_strategy=vad" +
  "&include_timestamps=false" +
  "&vad_threshold=0.4" +
  "&vad_silence_threshold_secs=1.5" +
  "&min_speech_duration_ms=100" +
  "&min_silence_duration_ms=100";

const SAMPLE_RATE = 16000;
const CHUNK_BYTES = 8192;
const CONNECT_BUFFER_BYTES = SAMPLE_RATE * 2 * 2;

const DEFAULT_SILENCE_MS = 1200;
const DEFAULT_NO_SPEECH_MS = 8000;
const DEFAULT_CAP_MS = 30000;
const DEFAULT_CAP_GRACE_MS = 1000;

/** How an utterance ended. `text` is the joined committed text (blank unless reason is "final"). */
export type SttEndReason = "final" | "blank" | "error" | "closed";

export type SttEndInfo = {
  reason: SttEndReason;
  text: string;
};

/** Callbacks for one utterance. `onEnd` always fires exactly once per utterance. */
export type SttHandlers = {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onFailure(f: VoiceFailure): void;
  onEnd?(info: SttEndInfo): void;
};

/** Minimal socket surface used by the utterance; satisfied by `ws`. */
export type SttSocket = {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
};

/** Create a socket for `url` with the given handshake headers. */
export type SttSocketFactory = (url: string, opts: { headers: Record<string, string> }) => SttSocket;

/** Injectable clock. Defaults to the global timers. */
export type SttTimers = {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

/** Injectable utterance time limits (milliseconds). */
export type SttLimits = {
  silenceMs?: number;
  noSpeechMs?: number;
  capMs?: number;
  capGraceMs?: number;
};

/** One capture utterance: feed PCM frames, then close. */
export type Utterance = {
  push(frame: Buffer): void;
  close(): Promise<void>;
};

const defaultTimers: SttTimers = {
  setTimeout: (cb: () => void, ms: number): unknown => setTimeout(cb, ms),
  clearTimeout: (id: unknown): void => {
    clearTimeout(id as ReturnType<typeof setTimeout>);
  },
};

function defaultSocketFactory(url: string, opts: { headers: Record<string, string> }): SttSocket {
  const Ctor = WebSocket as unknown as new (url: string, opts: { headers: Record<string, string> }) => SttSocket;
  return new Ctor(url, { headers: opts.headers });
}

function mapErrorType(t: string): { code: VoiceFailure["code"]; retryable: boolean } {
  switch (t) {
    case "auth_error":
    case "unaccepted_terms":
      return { code: "auth", retryable: false };
    case "quota_exceeded":
      return { code: "quota", retryable: false };
    case "rate_limited":
    case "commit_throttled":
    case "queue_overflow":
    case "resource_exhausted":
      return { code: "rate", retryable: true };
    default:
      return { code: "protocol", retryable: false };
  }
}

function failureMessage(t: string, detail: string): string {
  const d = detail.trim().slice(0, 160);
  switch (mapErrorType(t).code) {
    case "auth":
      return `STT rejected credentials (${t}). Export a valid ELEVENLABS_API_KEY and restart Pi.${d ? ` ${d}` : ""}`;
    case "quota":
      return `STT quota exceeded (${t}). Check usage/billing, then retry.${d ? ` ${d}` : ""}`;
    case "rate":
      return `STT throttled (${t}); retry shortly.${d ? ` ${d}` : ""}`;
    default:
      return `STT protocol error (${t}).${d ? ` ${d}` : ""}`;
  }
}

/**
 * Open one Scribe realtime utterance over a fresh socket.
 *
 * VAD query params are chosen example values from the integration guide, not
 * confirmed API defaults (the audit could not verify documented defaults).
 * The API key travels in the `xi-api-key` header only, never in the URL.
 */
export function startUtterance(
  key: string,
  handlers: SttHandlers,
  opts?: { socketFactory?: SttSocketFactory; timers?: SttTimers; limits?: SttLimits },
): Utterance {
  const socketFactory = opts?.socketFactory ?? defaultSocketFactory;
  const timers = opts?.timers ?? defaultTimers;
  const silenceMs = opts?.limits?.silenceMs ?? DEFAULT_SILENCE_MS;
  const noSpeechMs = opts?.limits?.noSpeechMs ?? DEFAULT_NO_SPEECH_MS;
  const capMs = opts?.limits?.capMs ?? DEFAULT_CAP_MS;
  const capGraceMs = opts?.limits?.capGraceMs ?? DEFAULT_CAP_GRACE_MS;

  let done = false;
  let open = false;
  let committed: string[] = [];
  let pending: Buffer = Buffer.alloc(0);
  let socket: SttSocket | null = null;
  let silenceId: unknown = null;
  let noSpeechId: unknown = null;
  let capId: unknown = null;
  let capGraceId: unknown = null;
  let closePromise: Promise<void> | null = null;

  function clearTimer(id: unknown): void {
    if (id !== null) timers.clearTimeout(id);
  }

  function clearAllTimers(): void {
    clearTimer(silenceId);
    clearTimer(noSpeechId);
    clearTimer(capId);
    clearTimer(capGraceId);
    silenceId = noSpeechId = capId = capGraceId = null;
  }

  function committedText(): string {
    return committed.join(" ").replace(/\s+/g, " ").trim();
  }

  function end(info: SttEndInfo): void {
    if (done) return;
    done = true;
    clearAllTimers();
    try {
      socket?.close();
    } catch {
      // Socket already gone; ending anyway.
    }
    handlers.onEnd?.(info);
  }

  function finalize(): void {
    const text = committedText();
    if (text === "") {
      end({ reason: "blank", text: "" });
      return;
    }
    if (done) return;
    done = true;
    clearAllTimers();
    try {
      socket?.close();
    } catch {
      // Socket already gone; finalizing anyway.
    }
    handlers.onFinal(text);
    handlers.onEnd?.({ reason: "final", text });
  }

  function fail(code: VoiceFailure["code"], message: string, retryable: boolean): void {
    if (done) return;
    done = true;
    clearAllTimers();
    try {
      socket?.close();
    } catch {
      // Socket already gone; failing anyway.
    }
    handlers.onFailure({ code, message, retryable });
    handlers.onEnd?.({ reason: "error", text: committedText() });
  }

  function sendChunk(payload: { audio: Buffer; commit: boolean }): void {
    if (!socket || !open) return;
    socket.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: payload.audio.toString("base64"),
        commit: payload.commit,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }

  function flush(fullOnly: boolean): void {
    if (!open) {
      if (pending.length > CONNECT_BUFFER_BYTES) pending = pending.subarray(pending.length - CONNECT_BUFFER_BYTES);
      return;
    }
    while (pending.length >= CHUNK_BYTES) {
      const piece = pending.subarray(0, CHUNK_BYTES);
      pending = pending.subarray(CHUNK_BYTES);
      sendChunk({ audio: piece, commit: false });
    }
    if (!fullOnly && pending.length > 0) {
      const rest = pending;
      pending = Buffer.alloc(0);
      sendChunk({ audio: rest, commit: false });
    }
  }

  function noteActivity(): void {
    clearTimer(noSpeechId);
    noSpeechId = timers.setTimeout(() => finalizeBlank("no-speech"), noSpeechMs);
    if (committed.length > 0) {
      clearTimer(silenceId);
      silenceId = timers.setTimeout(() => finalize(), silenceMs);
    }
  }

  function finalizeBlank(_why: "no-speech" | "cap"): void {
    flush(false);
    const text = committedText();
    if (text !== "") {
      finalize();
      return;
    }
    end({ reason: "blank", text: "" });
  }

  function onCap(): void {
    capId = null;
    flush(false);
    try {
      socket?.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: SAMPLE_RATE,
        }),
      );
    } catch {
      // Send path already dead; grace finalize still runs.
    }
    capGraceId = timers.setTimeout(() => finalizeBlank("cap"), capGraceMs);
  }

  function onMessage(raw: unknown): void {
    if (done) return;
    const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : null;
    if (text === null) return;
    let msg: { message_type?: unknown; text?: unknown; error?: unknown };
    try {
      msg = JSON.parse(text) as { message_type?: unknown; text?: unknown; error?: unknown };
    } catch {
      return;
    }
    const type = typeof msg.message_type === "string" ? msg.message_type : "";
    if (type === "session_started") {
      open = true;
      flush(true);
      return;
    }
    if (type === "partial_transcript") {
      if (typeof msg.text === "string" && msg.text !== "") {
        noteActivity();
        if (!done) handlers.onPartial(msg.text);
      }
      return;
    }
    if (type === "committed_transcript") {
      if (typeof msg.text === "string" && msg.text.trim() !== "") {
        committed.push(msg.text.trim());
        noteActivity();
      }
      return;
    }
    if (type === "committed_transcript_with_timestamps") return;
    if (type === "") return;
    const mapped = mapErrorType(type);
    const rawDetail = typeof msg.error === "string" ? msg.error : "";
    const detail = rawDetail.includes(key) ? "" : rawDetail;
    fail(mapped.code, failureMessage(type, detail), mapped.retryable);
  }

  function onSocketClose(): void {
    if (done) return;
    fail("network", "STT connection closed before the final transcript.", true);
  }

  function onSocketError(): void {
    if (done) return;
    fail("network", "STT connection failed.", true);
  }

  try {
    socket = socketFactory(STT_URL, { headers: { "xi-api-key": key } });
  } catch {
    fail("network", "STT connection failed.", true);
    return {
      push: (_frame: Buffer): void => {},
      close: (): Promise<void> => Promise.resolve(),
    };
  }
  const s = socket;
  s.on("message", (...args: unknown[]) => {
    onMessage(args[0]);
  });
  s.on("close", () => {
    onSocketClose();
  });
  s.on("error", () => {
    onSocketError();
  });
  s.on("open", () => {
    if (!done) flush(true);
  });

  noSpeechId = timers.setTimeout(() => finalizeBlank("no-speech"), noSpeechMs);
  capId = timers.setTimeout(() => onCap(), capMs);

  return {
    push(frame: Buffer): void {
      if (done || frame.length === 0) return;
      pending = pending.length === 0 ? frame : Buffer.concat([pending, frame]);
      flush(true);
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = Promise.resolve().then(() => {
        if (!done) end({ reason: "closed", text: committedText() });
        else {
          try {
            s.close();
          } catch {
            // Already closed.
          }
        }
      });
      return closePromise;
    },
  };
}
