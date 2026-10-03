import WebSocket from "ws";
import type { VoiceFailure } from "./contracts.ts";

export const STT_URL =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime" +
  "?model_id=scribe_v2_realtime" +
  "&audio_format=pcm_16000" +
  "&commit_strategy=manual" +
  "&include_timestamps=false";

const SAMPLE_RATE = 16000;
const CHUNK_BYTES = 8192;
const CONNECT_BUFFER_BYTES = SAMPLE_RATE * 2 * 2;

const DEFAULT_CAP_MS = 30000;
const DEFAULT_COMMIT_GRACE_MS = 3000;

/** How an utterance ended. `text` is the joined committed text (blank unless reason is "final"). */
export type SttEndReason = "final" | "blank" | "error" | "closed";

export type SttEndInfo = {
  reason: SttEndReason;
  text: string;
  source?: "committed" | "partial-fallback";
};

/** Callbacks for one utterance. `onEnd` always fires exactly once per utterance. */
export type SttHandlers = {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onFailure(f: VoiceFailure): void;
  onEnd?(info: SttEndInfo): void;
  onSession?(): void;
  onEvent?(type: string, info?: Record<string, unknown>): void;
};

/** Minimal socket surface used by the utterance; satisfied by `ws`. */
export type SttSocket = {
  send(data: string): void;
  close(): void;
  on(
    event: "open" | "message" | "close" | "error" | "unexpected-response",
    listener: (...args: unknown[]) => void,
  ): unknown;
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
  capMs?: number;
  commitGraceMs?: number;
};

export type SttOptions = {
  socketFactory?: SttSocketFactory;
  timers?: SttTimers;
  limits?: SttLimits;
  url?: string;
  capMs?: number;
  commitGraceMs?: number;
};

/** One capture utterance: feed PCM frames, commit when speech ends, then close. */
export type Utterance = {
  push(frame: Buffer): void;
  commit(): void;
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

/** Attach the required Scribe realtime query params to any base URL (including test overrides). */
function buildUrl(base: string): string {
  const u = new URL(base);
  u.searchParams.set("model_id", "scribe_v2_realtime");
  u.searchParams.set("audio_format", "pcm_16000");
  u.searchParams.set("commit_strategy", "manual");
  u.searchParams.set("include_timestamps", "false");
  return u.toString();
}

function mapErrorType(t: string): { code: VoiceFailure["code"]; retryable: boolean } {
  switch (t) {
    case "auth_error":
      return { code: "auth", retryable: false };
    case "unaccepted_terms":
      return { code: "terms", retryable: false };
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

const SK_LIKE_PATTERN = /\bsk_[A-Za-z0-9]{16,}/g;
const REDACTED = "[redacted]";

function redactSecrets(value: string, key: string): string {
  let out = value;
  if (key !== "") out = out.split(key).join(REDACTED);
  SK_LIKE_PATTERN.lastIndex = 0;
  out = out.replace(SK_LIKE_PATTERN, REDACTED);
  return out;
}

function failureMessage(t: string, detail: string): string {
  const d = detail.trim().slice(0, 160);
  switch (mapErrorType(t).code) {
    case "auth":
      return `STT rejected credentials (${t}). Export a valid ELEVENLABS_API_KEY and restart Pi.${d ? ` ${d}` : ""}`;
    case "terms":
      return `STT terms not accepted (${t}). Accept the Speech-to-Text terms in the ElevenLabs dashboard, then retry.${d ? ` ${d}` : ""}`;
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
 * Commit strategy is manual: the caller (local VAD endpointing) drives
 * commit() when the user stops speaking. The API key travels in the
 * `xi-api-key` header only, never in the URL.
 */
export function startUtterance(key: string, handlers: SttHandlers, opts?: SttOptions): Utterance {
  const socketFactory = opts?.socketFactory ?? defaultSocketFactory;
  const timers = opts?.timers ?? defaultTimers;
  const url = buildUrl(opts?.url ?? STT_URL);
  const capMs = opts?.capMs ?? opts?.limits?.capMs ?? DEFAULT_CAP_MS;
  const commitGraceMs = opts?.commitGraceMs ?? opts?.limits?.commitGraceMs ?? DEFAULT_COMMIT_GRACE_MS;

  let done = false;
  let open = false;
  let committed: string[] = [];
  let lastPartial = "";
  let pending: Buffer = Buffer.alloc(0);
  let socket: SttSocket | null = null;
  let commitSent = false;
  let commitDeferred = false;
  let graceId: unknown = null;
  let capId: unknown = null;
  let closePromise: Promise<void> | null = null;

  const emit = (type: string, info?: Record<string, unknown>): void => {
    try {
      handlers.onEvent?.(type, info);
    } catch {
      // Debug hook must never break the utterance.
    }
  };

  function clearTimer(id: unknown): void {
    if (id !== null) timers.clearTimeout(id);
  }

  function clearAllTimers(): void {
    clearTimer(graceId);
    clearTimer(capId);
    graceId = capId = null;
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

  function finalizeCommitted(): void {
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
    handlers.onEnd?.({ reason: "final", text, source: "committed" });
  }

  function onGraceExpiry(): void {
    graceId = null;
    if (done) return;
    const text = committedText();
    if (text !== "") {
      finalizeCommitted();
      return;
    }
    const partial = lastPartial.trim();
    if (partial !== "") {
      done = true;
      clearAllTimers();
      try {
        socket?.close();
      } catch {
        // Socket already gone; finalizing anyway.
      }
      handlers.onFinal(partial);
      handlers.onEnd?.({ reason: "final", text: partial, source: "partial-fallback" });
      return;
    }
    end({ reason: "blank", text: "" });
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

  function sendAudio(audio: Buffer): void {
    if (!socket || !open) return;
    socket.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: audio.toString("base64"),
        commit: false,
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
      sendAudio(piece);
    }
    if (!fullOnly && pending.length > 0) {
      const rest = pending;
      pending = Buffer.alloc(0);
      sendAudio(rest);
    }
  }

  function sendCommitMessage(): void {
    flush(false);
    socket?.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: SAMPLE_RATE,
      }),
    );
  }

  function startGrace(): void {
    clearTimer(graceId);
    graceId = timers.setTimeout(onGraceExpiry, commitGraceMs);
  }

  function doCommit(): void {
    if (commitSent || done) return;
    commitSent = true;
    commitDeferred = false;
    try {
      sendCommitMessage();
    } catch {
      // Send path dead; grace outcome still resolves the utterance.
    }
    startGrace();
  }

  function onCap(): void {
    capId = null;
    if (commitSent || done) return;
    if (!open) {
      commitDeferred = true;
      return;
    }
    doCommit();
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
      emit("session_started");
      try {
        handlers.onSession?.();
      } catch {
        // Callback error must not break the utterance.
      }
      flush(true);
      if (commitDeferred) doCommit();
      return;
    }
    if (type === "partial_transcript") {
      if (typeof msg.text === "string" && msg.text !== "") {
        lastPartial = msg.text;
        emit("partial_transcript", { length: msg.text.length });
        if (!done) handlers.onPartial(msg.text);
      } else {
        emit("partial_transcript", { length: 0 });
      }
      return;
    }
    if (type === "committed_transcript") {
      if (typeof msg.text === "string" && msg.text.trim() !== "") {
        committed.push(msg.text.trim());
        emit("committed_transcript", { length: msg.text.length });
        if (commitSent) finalizeCommitted();
      } else {
        emit("committed_transcript", { length: 0 });
      }
      return;
    }
    if (type === "committed_transcript_with_timestamps") {
      emit("committed_transcript_with_timestamps");
      return;
    }
    if (type === "") return;
    emit(type);
    const mapped = mapErrorType(type);
    const rawDetail = typeof msg.error === "string" ? msg.error : "";
    const detail = redactSecrets(rawDetail, key);
    fail(mapped.code, failureMessage(type, detail), mapped.retryable);
  }

  function onSocketClose(code: unknown, reason: unknown): void {
    const info: Record<string, unknown> = {};
    if (typeof code === "number") info["code"] = code;
    const reasonText = typeof reason === "string" ? reason : Buffer.isBuffer(reason) ? reason.toString("utf8") : "";
    if (reasonText !== "") info["reason"] = reasonText.slice(0, 160);
    emit("close", info);
    if (done) return;
    const codePart = typeof code === "number" ? ` (code ${code})` : "";
    const reasonPart = reasonText !== "" ? `: ${redactSecrets(reasonText, key).slice(0, 120)}` : "";
    fail("network", `STT connection closed${codePart} before the final transcript${reasonPart}.`, true);
  }

  function onSocketError(err: unknown): void {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    emit("error", message !== "" ? { message: message.slice(0, 160) } : undefined);
    if (done) return;
    const suffix = message !== "" ? `: ${redactSecrets(message, key).slice(0, 120)}` : "";
    fail("network", `STT connection failed${suffix}.`, true);
  }

  function onUnexpectedResponse(status: unknown): void {
    const code = typeof status === "number" ? status : -1;
    emit("unexpected-response", { statusCode: code });
    if (done) return;
    if (code === 401 || code === 403) {
      fail("auth", `STT rejected credentials (HTTP ${code} on upgrade). Export a valid ELEVENLABS_API_KEY and restart Pi.`, false);
    } else if (code === 429) {
      fail("rate", `STT throttled (HTTP ${code} on upgrade); retry shortly.`, true);
    } else {
      fail("network", `STT upgrade failed (HTTP ${code}); retry shortly.`, true);
    }
  }

  try {
    socket = socketFactory(url, { headers: { "xi-api-key": key } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    const suffix = message !== "" ? `: ${redactSecrets(message, key).slice(0, 120)}` : "";
    fail("network", `STT connection failed${suffix}.`, true);
    return {
      push: (_frame: Buffer): void => {},
      commit: (): void => {},
      close: (): Promise<void> => Promise.resolve(),
    };
  }
  const s = socket;
  s.on("message", (...args: unknown[]) => {
    onMessage(args[0]);
  });
  s.on("close", (...args: unknown[]) => {
    onSocketClose(args[0], args[1]);
  });
  s.on("error", (...args: unknown[]) => {
    onSocketError(args[0]);
  });
  s.on("unexpected-response", (...args: unknown[]) => {
    // ws emits (req, res); the status lives on the response.
    const res = args[1] as { statusCode?: unknown } | undefined;
    onUnexpectedResponse(res?.statusCode);
  });
  s.on("open", (...args: unknown[]) => {
    void args;
    emit("open");
    if (!done) flush(true);
  });

  capId = timers.setTimeout(() => onCap(), capMs);

  return {
    push(frame: Buffer): void {
      if (done || frame.length === 0) return;
      pending = pending.length === 0 ? frame : Buffer.concat([pending, frame]);
      flush(true);
    },
    commit(): void {
      if (done || commitSent) return;
      if (!open) {
        commitDeferred = true;
        return;
      }
      doCommit();
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
