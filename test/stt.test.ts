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

  on(event: "open" | "message" | "close" | "error" | "unexpected-response", listener: (...args: unknown[]) => void): unknown {
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
  ends: { reason: string; text: string; source?: string }[];
  events: { type: string; info?: Record<string, unknown> }[];
  sessionCount: { n: number };
};

function setup(opts?: { capMs?: number; commitGraceMs?: number; url?: string }): Setup & {
  u: ReturnType<typeof startUtterance>;
} {
  let sock: FakeSocket | null = null;
  const timers = new FakeTimers();
  const partials: string[] = [];
  const finals: string[] = [];
  const failures: VoiceFailure[] = [];
  const ends: Setup["ends"] = [];
  const events: Setup["events"] = [];
  const sessionCount = { n: 0 };
  const u = startUtterance(
    KEY,
    {
      onPartial: (t) => partials.push(t),
      onFinal: (t) => finals.push(t),
      onFailure: (f) => failures.push(f),
      onEnd: (info) => ends.push({ reason: info.reason, text: info.text, source: info.source }),
      onSession: () => {
        sessionCount.n += 1;
      },
      onEvent: (type, info) => events.push({ type, info }),
    },
    {
      socketFactory: (url, o) => {
        sock = new FakeSocket(url, o);
        return sock;
      },
      timers,
      capMs: opts?.capMs,
      commitGraceMs: opts?.commitGraceMs,
      url: opts?.url,
    },
  );
  assert.ok(sock !== null);
  return { socket: sock as FakeSocket, timers, partials, finals, failures, ends, events, sessionCount, u };
}

function openSession(s: Setup): void {
  s.socket.emit("open");
  s.socket.serverMessage({ message_type: "session_started" });
}

function pcm(bytes: number, fill = 1): Buffer {
  return Buffer.alloc(bytes, fill);
}

describe("stt manual commits", () => {
  it("uses header auth and the manual-commit URL query", () => {
    const s = setup();
    assert.equal(s.socket.opts.headers["xi-api-key"], KEY);
    const url = new URL(s.socket.url);
    assert.equal(`${url.origin}${url.pathname}`, "wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
    assert.equal(url.searchParams.get("commit_strategy"), "manual");
    assert.equal(url.searchParams.get("include_timestamps"), "false");
    assert.ok(!s.socket.url.includes("vad_"));
    assert.ok(!s.socket.url.includes(KEY));
    assert.ok(!url.searchParams.has("token"));
  });

  it("honors an injectable url override (required params are attached)", () => {
    const s = setup({ url: "ws://127.0.0.1:9/realtime" });
    const parsed = new URL(s.socket.url);
    assert.equal(`${parsed.protocol}//${parsed.host}${parsed.pathname}`, "ws://127.0.0.1:9/realtime");
    assert.equal(parsed.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.equal(parsed.searchParams.get("commit_strategy"), "manual");
    assert.equal(parsed.searchParams.get("audio_format"), "pcm_16000");
  });

  it("buffers at most 2s of PCM while connecting, then sends ~8KiB base64 chunks", () => {
    const s = setup();
    s.u.push(pcm(100000, 7));
    assert.equal(s.socket.sent.length, 0);
    openSession(s);
    assert.equal(s.sessionCount.n, 1);
    // 100000 B trimmed to the 64000 B (2 s) connect buffer -> 7 full 8 KiB chunks.
    assert.equal(s.socket.sent.length, 7);
    for (const raw of s.socket.sent) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(m["message_type"], "input_audio_chunk");
      assert.equal(m["commit"], false);
      assert.equal(m["sample_rate"], 16000);
      assert.equal(Buffer.from(m["audio_base_64"] as string, "base64").length, 8192);
    }
    s.u.push(pcm(4000, 7));
    // Remainder 6656 B + 4000 B = 10656 B -> one more full chunk, remainder stays buffered.
    assert.equal(s.socket.sent.length, 8);
    const last = JSON.parse(s.socket.sent[s.socket.sent.length - 1] as string) as Record<string, unknown>;
    assert.equal(Buffer.from(last["audio_base_64"] as string, "base64").length, 8192);
  });

  it("committed transcripts do NOT finalize before commit(); commit message follows all pending audio", () => {
    const s = setup();
    openSession(s);
    s.u.push(pcm(9000, 3));
    s.socket.serverMessage({ message_type: "committed_transcript", text: "early" });
    assert.deepEqual(s.finals, []);
    assert.deepEqual(s.ends, []);
    const sentBefore = s.socket.sent.length;
    s.u.commit();
    const sent = s.socket.sent.slice(sentBefore).map((r) => JSON.parse(r) as Record<string, unknown>);
    assert.ok(sent.length >= 2);
    for (const m of sent.slice(0, -1)) {
      assert.equal(m["message_type"], "input_audio_chunk");
      assert.equal(m["commit"], false);
    }
    const commit = sent[sent.length - 1] as Record<string, unknown>;
    assert.equal(commit["message_type"], "input_audio_chunk");
    assert.equal(commit["commit"], true);
    assert.equal(commit["audio_base_64"], "");
    assert.equal(commit["sample_rate"], 16000);
  });

  it("commit() is idempotent", () => {
    const s = setup();
    openSession(s);
    s.u.commit();
    s.u.commit();
    const commits = s.socket.sent.filter(
      (r) => (JSON.parse(r) as Record<string, unknown>)["commit"] === true,
    );
    assert.equal(commits.length, 1);
  });

  it("commit() before session_started is deferred and sent after pending audio", () => {
    const s = setup();
    s.u.push(pcm(9000, 5));
    s.u.commit();
    assert.equal(s.socket.sent.length, 0);
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "session_started" });
    const sent = s.socket.sent.map((r) => JSON.parse(r) as Record<string, unknown>);
    assert.ok(sent.length >= 2);
    const last = sent[sent.length - 1] as Record<string, unknown>;
    assert.equal(last["commit"], true);
    for (const m of sent.slice(0, -1)) assert.equal(m["commit"], false);
    assert.equal(Buffer.from(sent[0]?.["audio_base_64"] as string, "base64").length, 8192);
  });

  it("finalizes immediately on the next committed_transcript after commit (source committed)", () => {
    const s = setup();
    openSession(s);
    s.u.push(pcm(8192, 3));
    s.u.commit();
    s.socket.serverMessage({ message_type: "committed_transcript", text: "hello world" });
    assert.deepEqual(s.finals, ["hello world"]);
    assert.deepEqual(s.ends, [{ reason: "final", text: "hello world", source: "committed" }]);
  });

  it("falls back to the last partial on grace expiry (source partial-fallback)", () => {
    const s = setup({ commitGraceMs: 3000 });
    openSession(s);
    s.socket.serverMessage({ message_type: "partial_transcript", text: "hel" });
    s.u.commit();
    s.timers.advance(3000);
    assert.deepEqual(s.finals, ["hel"]);
    assert.deepEqual(s.ends, [{ reason: "final", text: "hel", source: "partial-fallback" }]);
  });

  it("ends blank on grace expiry with no committed text and no partial", () => {
    const s = setup({ commitGraceMs: 3000 });
    openSession(s);
    s.u.commit();
    s.timers.advance(3000);
    assert.deepEqual(s.finals, []);
    assert.deepEqual(s.failures, []);
    assert.deepEqual(s.ends, [{ reason: "blank", text: "", source: undefined }]);
  });

  it("uses committed text over partials when both exist at grace expiry", () => {
    const s = setup({ commitGraceMs: 1000 });
    openSession(s);
    s.socket.serverMessage({ message_type: "committed_transcript", text: "early" });
    s.socket.serverMessage({ message_type: "partial_transcript", text: "early plus" });
    s.u.commit();
    s.timers.advance(1000);
    assert.deepEqual(s.finals, ["early"]);
    assert.deepEqual(s.ends, [{ reason: "final", text: "early", source: "committed" }]);
  });

  it("capMs auto-commits without a controller call", () => {
    const s = setup({ capMs: 5000, commitGraceMs: 1000 });
    openSession(s);
    s.u.push(pcm(8192, 3));
    s.timers.advance(5000);
    const commits = s.socket.sent.filter(
      (r) => (JSON.parse(r) as Record<string, unknown>)["commit"] === true,
    );
    assert.equal(commits.length, 1);
    s.socket.serverMessage({ message_type: "committed_transcript", text: "capped" });
    assert.deepEqual(s.finals, ["capped"]);
    assert.deepEqual(s.ends, [{ reason: "final", text: "capped", source: "committed" }]);
  });

  it("ignores committed_transcript_with_timestamps duplicates", () => {
    const s = setup();
    openSession(s);
    s.u.commit();
    s.socket.serverMessage({ message_type: "committed_transcript", text: "hello world" });
    s.socket.serverMessage({ message_type: "committed_transcript_with_timestamps", text: "hello world" });
    assert.deepEqual(s.finals, ["hello world"]);
    assert.equal(s.ends.length, 1);
  });

  it("routes partial transcripts to onPartial", () => {
    const s = setup();
    openSession(s);
    s.socket.serverMessage({ message_type: "partial_transcript", text: "hello" });
    assert.deepEqual(s.partials, ["hello"]);
    assert.deepEqual(s.finals, []);
  });

  it("maps unaccepted_terms to code terms with dashboard guidance", () => {
    const s = setup();
    s.socket.serverMessage({ message_type: "unaccepted_terms", error: "accept me" });
    assert.equal(s.failures.length, 1);
    assert.equal(s.failures[0]?.code, "terms");
    assert.equal(s.failures[0]?.retryable, false);
    assert.ok(s.failures[0]?.message.includes("unaccepted_terms"));
    assert.ok(s.failures[0]?.message.includes("ElevenLabs dashboard"));
    assert.equal(s.ends[0]?.reason, "error");
  });

  it("maps commit_throttled to rate/retryable", () => {
    const s = setup();
    s.socket.serverMessage({ message_type: "commit_throttled", error: "slow down" });
    assert.equal(s.failures[0]?.code, "rate");
    assert.equal(s.failures[0]?.retryable, true);
    assert.ok(s.failures[0]?.message.includes("commit_throttled"));
  });

  it("maps remaining error types to VoiceFailure codes", () => {
    const cases: { type: string; code: string; retryable: boolean }[] = [
      { type: "auth_error", code: "auth", retryable: false },
      { type: "quota_exceeded", code: "quota", retryable: false },
      { type: "rate_limited", code: "rate", retryable: true },
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
      const one = setup();
      one.socket.serverMessage({ message_type: c.type, error: "boom" });
      assert.equal(one.failures.length, 1, c.type);
      assert.equal(one.failures[0]?.code, c.code, c.type);
      assert.equal(one.failures[0]?.retryable, c.retryable, c.type);
      assert.equal(one.ends.length, 1, c.type);
      assert.equal(one.ends[0]?.reason, "error", c.type);
    }
  });

  it("maps upgrade 401 to auth/non-retryable via unexpected-response", () => {
    const s = setup();
    s.socket.emit("unexpected-response", {}, { statusCode: 401 });
    assert.equal(s.failures.length, 1);
    assert.equal(s.failures[0]?.code, "auth");
    assert.equal(s.failures[0]?.retryable, false);
    assert.ok(s.failures[0]?.message.includes("401"));
  });

  it("maps upgrade 429 to rate/retryable and other statuses to network", () => {
    const r = setup();
    r.socket.emit("unexpected-response", {}, { statusCode: 429 });
    assert.equal(r.failures[0]?.code, "rate");
    assert.equal(r.failures[0]?.retryable, true);
    const n = setup();
    n.socket.emit("unexpected-response", {}, { statusCode: 500 });
    assert.equal(n.failures[0]?.code, "network");
    assert.ok(n.failures[0]?.message.includes("500"));
  });

  it("treats a socket close before the final as a retryable network failure with code and reason", () => {
    const s = setup();
    openSession(s);
    s.socket.emit("close", 1006, "aborted");
    assert.equal(s.failures.length, 1);
    assert.equal(s.failures[0]?.code, "network");
    assert.equal(s.failures[0]?.retryable, true);
    assert.ok(s.failures[0]?.message.includes("1006"));
    assert.ok(s.failures[0]?.message.includes("aborted"));
  });

  it("reports session start exactly once, keeping the server message_type name", () => {
    const s = setup();
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "session_started" });
    const sessionEvents = s.events.filter(
      (e) => e.type === "session_started" || e.type === "session-started",
    );
    assert.deepEqual(
      sessionEvents.map((e) => e.type),
      ["session_started"],
    );
    assert.equal(s.sessionCount.n, 1);
  });

  it("fires onEvent for server messages and lifecycle without the key or transcript text", () => {
    const s = setup();
    openSession(s);
    s.socket.serverMessage({ message_type: "partial_transcript", text: "secret words" });
    const types = s.events.map((e) => e.type);
    assert.ok(types.includes("open"));
    assert.ok(types.includes("session_started"));
    assert.ok(types.includes("partial_transcript"));
    const blob = JSON.stringify(s.events);
    assert.ok(!blob.includes(KEY));
    assert.ok(!blob.includes("secret words"));
  });

  it("suppresses late events after close() and close() is idempotent", async () => {
    const s = setup();
    openSession(s);
    s.socket.serverMessage({ message_type: "partial_transcript", text: "hi" });
    await s.u.close();
    await s.u.close();
    assert.equal(s.socket.closed, true);
    s.socket.serverMessage({ message_type: "committed_transcript", text: "late" });
    s.socket.emit("close", 1000, "");
    s.socket.emit("error", new Error("late"));
    s.timers.advance(60000);
    assert.deepEqual(s.finals, []);
    assert.deepEqual(s.failures, []);
    assert.deepEqual(s.ends, [{ reason: "closed", text: "", source: undefined }]);
    assert.equal(s.timers.count(), 0);
  });

  it("never includes the key in failure messages", () => {
    const s = setup();
    s.socket.serverMessage({ message_type: "auth_error", error: KEY });
    assert.ok(s.failures.length === 1);
    assert.ok(!s.failures[0]?.message.includes(KEY));
    const t = setup();
    openSession(t);
    t.socket.emit("close", 1006, "");
    assert.ok(!t.failures[0]?.message.includes(KEY));
  });

  it("cap fires deferred before session_started: audio precedes commit", () => {
    const s = setup({ capMs: 1 });
    s.u.push(pcm(9000, 9));
    assert.equal(s.socket.sent.length, 0);
    s.timers.advance(1);
    // Cap fired while not open: nothing may be sent yet (commit deferred).
    assert.equal(s.socket.sent.length, 0);
    s.socket.emit("open");
    s.socket.serverMessage({ message_type: "session_started" });
    const sent = s.socket.sent.map((r) => JSON.parse(r) as Record<string, unknown>);
    assert.ok(sent.length >= 2);
    const last = sent[sent.length - 1] as Record<string, unknown>;
    assert.equal(last["commit"], true);
    for (const m of sent.slice(0, -1)) assert.equal(m["commit"], false);
  });

  it("redacts sk_-style secrets from provider error detail", () => {
    const s = setup();
    const secret = "sk_ABCDEFGHIJKLMNOP123456";
    s.socket.serverMessage({ message_type: "auth_error", error: `bad ${secret} boom` });
    assert.equal(s.failures.length, 1);
    assert.ok(!s.failures[0]?.message.includes(secret));
    assert.ok(!s.failures[0]?.message.includes("sk_ABCDEFGHIJKLMNOP"));
  });

  it("ignores malformed messages without ending the utterance", () => {
    const s = setup();
    openSession(s);
    s.socket.emit("message", "not json{{{");
    s.u.commit();
    s.socket.serverMessage({ message_type: "committed_transcript", text: "ok" });
    assert.deepEqual(s.finals, ["ok"]);
  });
});
