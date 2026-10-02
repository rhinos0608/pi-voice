import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startUtterance, STT_URL, type SttSocket, type SttTimers } from "../src/stt.ts";
import type { VoiceFailure } from "../src/contracts.ts";

const KEY = "test-key-abc123";

class FakeSocket implements SttSocket {
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  failOnSend = false;

  url: string;
  opts: { headers: Record<string, string> };

  constructor(url: string, opts: { headers: Record<string, string> }) {
    this.url = url;
    this.opts = opts;
  }

  send(data: string): void {
    if (this.failOnSend) throw new Error("send dead");
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return undefined;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  serverMessage(obj: unknown): void {
    this.emit("message", JSON.stringify(obj));
  }
}

class FakeTimers implements SttTimers {
  now = 0;
  nextId = 1;
  pending = new Map<unknown, { at: number; cb: () => void }>();

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, cb });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.pending.delete(id);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let best: { id: unknown; at: number; cb: () => void } | null = null;
      for (const [id, t] of this.pending) {
        if (t.at <= end && (best === null || t.at < best.at)) best = { id, ...t };
      }
      if (best === null) break;
      this.pending.delete(best.id);
      this.now = best.at;
      best.cb();
    }
    this.now = end;
  }

  count(): number {
    return this.pending.size;
  }
}

type Setup = {
  socket: FakeSocket;
  timers: FakeTimers;
  partials: string[];
  finals: string[];
  failures: VoiceFailure[];
  ends: { reason: string; text: string }[];
};

function setup(limits?: { silenceMs?: number; noSpeechMs?: number; capMs?: number; capGraceMs?: number }): Setup & {
  u: ReturnType<typeof startUtterance>;
} {
  let sock: FakeSocket | null = null;
  const timers = new FakeTimers();
  const partials: string[] = [];
  const finals: string[] = [];
  const failures: VoiceFailure[] = [];
  const ends: { reason: string; text: string }[] = [];
  const u = startUtterance(
    KEY,
    {
      onPartial: (t) => partials.push(t),
      onFinal: (t) => finals.push(t),
      onFailure: (f) => failures.push(f),
      onEnd: (info) => ends.push({ reason: info.reason, text: info.text }),
    },
    {
      socketFactory: (url, opts) => {
        sock = new FakeSocket(url, opts);
        return sock;
      },
      timers,
      limits,
    },
  );
  assert.ok(sock !== null);
  return { socket: sock as FakeSocket, timers, partials, finals, failures, ends, u };
}

function pcm(bytes: number, fill = 1): Buffer {
  return Buffer.alloc(bytes, fill);
}

describe("stt", () => {
  it("uses header auth and the documented URL query", () => {
    const s = setup();
    assert.equal(s.socket.opts.headers["xi-api-key"], KEY);
    const url = new URL(s.socket.url);
    assert.equal(`${url.origin}${url.pathname}`, "wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
    assert.equal(url.searchParams.get("commit_strategy"), "vad");
    assert.ok(!s.socket.url.includes(KEY));
    assert.ok(!url.searchParams.has("token"));
  });

  it("buffers at most 2s of PCM while connecting, then sends ~8KiB base64 chunks", () => {
    const s = setup();
    s.u.push(pcm(100000, 7));
    assert.equal(s.socket.sent.length, 0);
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "session_started" });
    // 2s cap = 64000 bytes -> 7 full 8192 chunks + 4864 remainder held back
    assert.equal(s.socket.sent.length, 7);
    for (const raw of s.socket.sent) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(m["message_type"], "input_audio_chunk");
      assert.equal(m["commit"], false);
      assert.equal(m["sample_rate"], 16000);
      assert.equal(Buffer.from(m["audio_base_64"] as string, "base64").length, 8192);
    }
    // Remainder flushes on next push: 4864 + 4000 = 8864 -> one more 8192 chunk, 672 held
    s.u.push(pcm(4000, 7));
    assert.equal(s.socket.sent.length, 8);
    const last = JSON.parse(s.socket.sent[s.socket.sent.length - 1] as string) as Record<string, unknown>;
    assert.equal(Buffer.from(last["audio_base_64"] as string, "base64").length, 8192);
  });

  it("routes partial transcripts to onPartial", () => {
    const s = setup();
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "partial_transcript", text: "hello" });
    assert.deepEqual(s.partials, ["hello"]);
    assert.deepEqual(s.finals, []);
  });

  it("ignores committed_transcript_with_timestamps duplicates", () => {
    const s = setup({ silenceMs: 1200 });
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "committed_transcript", text: "hello world" });
    s.socket.serverMessage({ message_type: "committed_transcript_with_timestamps", text: "hello world" });
    s.timers.advance(1200);
    assert.deepEqual(s.finals, ["hello world"]);
  });

  it("fires onFinal exactly once after the silence gap, then onEnd(final)", () => {
    const s = setup({ silenceMs: 1200 });
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "committed_transcript", text: "one" });
    s.timers.advance(500);
    s.socket.serverMessage({ message_type: "partial_transcript", text: "one two" });
    s.socket.serverMessage({ message_type: "committed_transcript", text: "two" });
    s.timers.advance(1100);
    assert.deepEqual(s.finals, []);
    s.timers.advance(200);
    assert.deepEqual(s.finals, ["one two"]);
    assert.deepEqual(s.ends, [{ reason: "final", text: "one two" }]);
    // Late commit after final is suppressed
    s.socket.serverMessage({ message_type: "committed_transcript", text: "three" });
    s.timers.advance(5000);
    assert.deepEqual(s.finals, ["one two"]);
    assert.equal(s.ends.length, 1);
  });

  it("ends blank on the no-speech timeout with no onFinal and no onFailure", () => {
    const s = setup({ noSpeechMs: 8000 });
    s.socket.emit("open");
    s.timers.advance(8000);
    assert.deepEqual(s.finals, []);
    assert.deepEqual(s.failures, []);
    assert.deepEqual(s.ends, [{ reason: "blank", text: "" }]);
    assert.equal(s.socket.closed, true);
  });

  it("sends a manual commit at the capture cap and finalizes after the grace wait", () => {
    const s = setup({ capMs: 30000, capGraceMs: 1000, silenceMs: 1200 });
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "committed_transcript", text: "early" });
    s.timers.advance(20000);
    // Silence gap fires first here; use a fresh utterance that stays active instead
    void s;
    const t = setup({ capMs: 30000, capGraceMs: 1000, silenceMs: 60000, noSpeechMs: 60000 });
    t.socket.emit("open");
    t.u.push(pcm(8192, 3));
    t.socket.serverMessage({ message_type: "committed_transcript", text: "kept talking" });
    t.timers.advance(30000);
    const commit = JSON.parse(t.socket.sent[t.socket.sent.length - 1] as string) as Record<string, unknown>;
    assert.equal(commit["message_type"], "input_audio_chunk");
    assert.equal(commit["commit"], true);
    assert.deepEqual(t.finals, []);
    t.timers.advance(1000);
    assert.deepEqual(t.finals, ["kept talking"]);
    assert.deepEqual(t.ends, [{ reason: "final", text: "kept talking" }]);
  });

  it("maps error message types to VoiceFailure codes", () => {
    const cases: { type: string; code: string; retryable: boolean }[] = [
      { type: "auth_error", code: "auth", retryable: false },
      { type: "unaccepted_terms", code: "auth", retryable: false },
      { type: "quota_exceeded", code: "quota", retryable: false },
      { type: "rate_limited", code: "rate", retryable: true },
      { type: "commit_throttled", code: "rate", retryable: true },
      { type: "queue_overflow", code: "rate", retryable: true },
      { type: "resource_exhausted", code: "rate", retryable: true },
      { type: "transcriber_error", code: "protocol", retryable: false },
      { type: "input_error", code: "protocol", retryable: false },
      { type: "invalid_request", code: "protocol", retryable: false },
      { type: "error", code: "protocol", retryable: false },
      { type: "session_time_limit_exceeded", code: "protocol", retryable: false },
      { type: "chunk_size_exceeded", code: "protocol", retryable: false },
      { type: "insufficient_audio_activity", code: "protocol", retryable: false },
    ];
    for (const c of cases) {
      const s = setup();
      s.socket.serverMessage({ message_type: c.type, error: "boom" });
      assert.equal(s.failures.length, 1, c.type);
      assert.equal(s.failures[0]?.code, c.code, c.type);
      assert.equal(s.failures[0]?.retryable, c.retryable, c.type);
      assert.equal(s.ends.length, 1, c.type);
      assert.equal(s.ends[0]?.reason, "error", c.type);
    }
  });

  it("treats a socket close before the final as a retryable network failure", () => {
    const s = setup();
    s.socket.emit("open");
    s.socket.emit("close");
    assert.equal(s.failures.length, 1);
    assert.equal(s.failures[0]?.code, "network");
    assert.equal(s.failures[0]?.retryable, true);
  });

  it("suppresses late events after close() and close() is idempotent", async () => {
    const s = setup();
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "partial_transcript", text: "hi" });
    await s.u.close();
    await s.u.close();
    assert.equal(s.socket.closed, true);
    s.socket.serverMessage({ message_type: "committed_transcript", text: "late" });
    s.socket.emit("close");
    s.socket.emit("error");
    s.timers.advance(60000);
    assert.deepEqual(s.finals, []);
    assert.deepEqual(s.failures, []);
    assert.deepEqual(s.ends, [{ reason: "closed", text: "" }]);
    assert.equal(s.timers.count(), 0);
  });

  it("never includes the key in failure messages", () => {
    const s = setup();
    s.socket.serverMessage({ message_type: "auth_error", error: KEY });
    assert.ok(s.failures.length === 1);
    assert.ok(!s.failures[0]?.message.includes(KEY));
    const t = setup();
    t.socket.emit("open");
    t.socket.emit("close");
    assert.ok(!t.failures[0]?.message.includes(KEY));
  });

  it("ignores malformed messages without ending the utterance", () => {
    const s = setup({ silenceMs: 1200 });
    s.socket.emit("open");
    s.socket.emit("message", "not json{{{");
    s.socket.serverMessage({ message_type: "committed_transcript", text: "ok" });
    s.timers.advance(1200);
    assert.deepEqual(s.finals, ["ok"]);
  });
});
