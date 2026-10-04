import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AudioSink, VoiceFailure } from "../src/contracts.ts";
import {
  DEFAULT_INWORLD_MODEL,
  DEFAULT_INWORLD_VOICE,
  INWORLD_TTS_MODELS,
  INWORLD_TTS_URL,
  startInworldSpeech,
} from "../src/inworld-tts.ts";
import { TtsHttpError } from "../src/tts.ts";
import type { TtsSocket } from "../src/tts.ts";

type Handler = (arg: unknown) => void;

class FakeSocket extends Object {
  handlers = new Map<string, Handler[]>();
  sent: string[] = [];
  closed = false;
  on(event: "open" | "message" | "error" | "close", handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(event: string, arg: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }
}

function makeSink(): AudioSink & { written: Buffer[]; stopped: boolean; finished: boolean } {
  const sink = {
    written: [] as Buffer[],
    stopped: false,
    finished: false,
    async start(): Promise<void> {},
    async write(chunk: Buffer): Promise<void> {
      sink.written.push(chunk);
    },
    async finish(): Promise<void> {
      sink.finished = true;
    },
    async stop(): Promise<void> {
      sink.stopped = true;
    },
  };
  return sink;
}

function setup(opts?: { voiceId?: string; modelId?: string; log?: (event: string, data?: Record<string, unknown>) => void }): {
  socket: FakeSocket;
  sink: ReturnType<typeof makeSink>;
  speech: ReturnType<typeof startInworldSpeech>;
  done: { count: number };
  failures: VoiceFailure[];
} {
  const socket = new FakeSocket();
  const sink = makeSink();
  const done = { count: 0 };
  const failures: VoiceFailure[] = [];
  const speech = startInworldSpeech(
    {
      key: "secret-key",
      voiceId: opts?.voiceId ?? "Ashley",
      ...(opts?.modelId === undefined ? {} : { modelId: opts.modelId }),
      onDone: (): void => {
        done.count += 1;
      },
      onFailure: (f: VoiceFailure): void => {
        failures.push(f);
      },
    },
    {
      socketFactory: (_url: string, _opts: { headers: Record<string, string> }): TtsSocket => {
        (socket as unknown as { url: string }).url = _url;
        (socket as unknown as { headers: Record<string, string> }).headers = _opts.headers;
        return socket as unknown as TtsSocket;
      },
      sinkFactory: (): AudioSink => sink,
      ...(opts?.log === undefined ? {} : { log: opts.log }),
    },
  );
  return { socket, sink, speech, done, failures };
}

function audioFrame(bytes: number[]): string {
  return JSON.stringify({
    result: {
      contextId: "c1",
      audioChunk: { audioContent: Buffer.from(bytes).toString("base64") },
      status: { code: 0 },
    },
  });
}

function contextClosedFrame(): string {
  return JSON.stringify({ result: { contextClosed: {} } });
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const meta = (): void => {
  assert.deepEqual(INWORLD_TTS_MODELS, ["inworld-tts-2", "inworld-tts-2-flash"]);
  assert.equal(DEFAULT_INWORLD_MODEL, "inworld-tts-2");
  assert.equal(DEFAULT_INWORLD_VOICE, "Ashley");
  assert.equal(INWORLD_TTS_URL, "wss://api.inworld.ai/tts/v1/voice:streamBidirectional");
};

describe("inworld startInworldSpeech", () => {
  it("exports model and endpoint constants", () => {
    meta();
  });

  it("uses URL and Basic auth header, never the key in frames", () => {
    const { socket, speech } = setup();
    socket.emit("open", undefined);
    speech.push("hi");
    const s = socket as unknown as { url: string; headers: Record<string, string> };
    assert.equal(s.url, INWORLD_TTS_URL);
    assert.equal(s.headers["Authorization"], "Basic secret-key");
    for (const raw of socket.sent) assert.ok(!raw.includes("secret-key"));
  });

  it("sends create first with PCM 24000 and voice/model", () => {
    const { socket } = setup({ voiceId: "Ashley", modelId: "inworld-tts-2-flash" });
    socket.emit("open", undefined);
    const create = JSON.parse(socket.sent[0]) as {
      contextId: string;
      create: { voiceId: string; modelId: string; audioConfig: { audioEncoding: string; sampleRateHertz: number } };
    };
    assert.equal(create.contextId, "c1");
    assert.equal(create.create.voiceId, "Ashley");
    assert.equal(create.create.modelId, "inworld-tts-2-flash");
    assert.equal(create.create.audioConfig.audioEncoding, "PCM");
    assert.equal(create.create.audioConfig.sampleRateHertz, 24000);
  });

  it("queues pre-open pushes and sends them after create, in order", () => {
    const { socket, speech } = setup();
    speech.push("first");
    speech.push("second");
    socket.emit("open", undefined);
    const frames = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    assert.ok("create" in (frames[0] as Record<string, unknown>));
    const texts = frames.slice(1).map((f) => (f["sendText"] as { text: string }).text);
    assert.deepEqual(texts, ["first", "second"]);
  });

  it("sends flushContext per push", () => {
    const { socket, speech } = setup();
    socket.emit("open", undefined);
    speech.push("hello");
    speech.push("world");
    const frames = socket.sent.slice(1).map((raw) => JSON.parse(raw) as { sendText: { flushContext: unknown } });
    assert.equal(frames.length, 2);
    for (const f of frames) assert.deepEqual(f.sendText.flushContext, {});
  });

  it("splits text over 2000 units on whitespace", () => {
    const { socket, speech } = setup();
    socket.emit("open", undefined);
    const text = `${"word ".repeat(500)}tail`;
    assert.ok(text.length > 2000);
    speech.push(text);
    const frames = socket.sent.slice(1).map((raw) => JSON.parse(raw) as { sendText: { text: string } });
    assert.ok(frames.length > 1);
    for (const f of frames) assert.ok(f.sendText.text.length <= 2000);
    assert.equal(
      frames.map((f) => f.sendText.text).join(""),
      text,
    );
  });

  it("writes audio chunks in arrival order into the sink", async () => {
    const { socket, sink, speech } = setup();
    socket.emit("open", undefined);
    speech.push("hello");
    socket.emit("message", audioFrame([1, 2]));
    socket.emit("message", audioFrame([3, 4]));
    socket.emit("message", contextClosedFrame());
    speech.finish();
    await tick();
    await tick();
    await tick();
    await tick();
    assert.deepEqual(
      sink.written.map((b) => [...b]),
      [
        [1, 2],
        [3, 4],
      ],
    );
  });

  it("accepts result.audioContent fallback", async () => {
    const { socket, sink, done } = setup();
    socket.emit("open", undefined);
    socket.emit(
      "message",
      JSON.stringify({ result: { audioContent: Buffer.from([7, 8]).toString("base64"), status: { code: 0 } } }),
    );
    socket.emit("message", contextClosedFrame());
    await tick();
    await tick();
    await tick();
    assert.deepEqual([...sink.written[0]], [7, 8]);
    assert.equal(sink.finished, true);
    assert.equal(done.count, 1);
  });

  it("contextClosed drains audio, finishes sink, then calls onDone once", async () => {
    const { socket, sink, speech, done } = setup();
    socket.emit("open", undefined);
    speech.push("hello");
    socket.emit("message", audioFrame([1]));
    speech.finish();
    const closeFrame = JSON.parse(socket.sent[socket.sent.length - 1]) as Record<string, unknown>;
    assert.deepEqual(closeFrame, { contextId: "c1", closeContext: {} });
    socket.emit("message", contextClosedFrame());
    socket.emit("message", contextClosedFrame());
    await tick();
    await tick();
    await tick();
    await tick();
    assert.equal(sink.finished, true);
    assert.equal(done.count, 1);
    assert.equal(socket.closed, true);
  });

  it("finish with no text still finishes and calls onDone once", async () => {
    const { socket, sink, speech, done } = setup();
    socket.emit("open", undefined);
    speech.finish();
    socket.emit("message", contextClosedFrame());
    await tick();
    await tick();
    await tick();
    assert.equal(sink.finished, true);
    assert.equal(done.count, 1);
  });

  it("maps top-level error code 16 to auth", async () => {
    const { socket, failures } = setup();
    socket.emit("open", undefined);
    socket.emit("message", JSON.stringify({ error: { code: 16, message: "unauthenticated" } }));
    await tick();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "auth");
    assert.equal(failures[0].retryable, false);
  });

  it("maps status code 8 with quota wording to quota, else rate", async () => {
    const first = setup();
    first.socket.emit("open", undefined);
    first.socket.emit("message", JSON.stringify({ result: { status: { code: 8, message: "quota exceeded" } } }));
    await tick();
    assert.equal(first.failures[0].code, "quota");
    assert.equal(first.failures[0].retryable, false);

    const second = setup();
    second.socket.emit("open", undefined);
    second.socket.emit("message", JSON.stringify({ result: { status: { code: 8, message: "too many requests" } } }));
    await tick();
    assert.equal(second.failures[0].code, "rate");
    assert.equal(second.failures[0].retryable, true);
  });

  it("maps code 3 to protocol with message and voice hint", async () => {
    const { socket, failures, sink } = setup();
    socket.emit("open", undefined);
    socket.emit("message", JSON.stringify({ error: { code: 3, message: "unknown voiceId Foo" } }));
    await tick();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "protocol");
    assert.equal(failures[0].retryable, false);
    assert.ok(failures[0].message.includes("unknown voiceId Foo"));
    assert.ok(failures[0].message.includes("/voice list"));
    assert.equal(sink.stopped, true);
  });

  it("maps code 14 to retryable network", async () => {
    const { socket, failures } = setup();
    socket.emit("open", undefined);
    socket.emit("message", JSON.stringify({ error: { code: 14, message: "unavailable" } }));
    await tick();
    assert.equal(failures[0].code, "network");
    assert.equal(failures[0].retryable, true);
  });

  it("maps upgrade rejections 401 to auth and 429 to rate", async () => {
    const auth = setup();
    auth.socket.emit("open", undefined);
    auth.socket.emit("error", new TtsHttpError(401, "unauthorized"));
    await tick();
    assert.equal(auth.failures[0].code, "auth");

    const rate = setup();
    rate.socket.emit("open", undefined);
    rate.socket.emit("error", new TtsHttpError(429, "slow down"));
    await tick();
    assert.equal(rate.failures[0].code, "rate");
    assert.equal(rate.failures[0].retryable, true);
  });

  it("socket close before contextClosed fails with network", async () => {
    const { socket, failures, done } = setup();
    socket.emit("open", undefined);
    socket.emit("close", undefined);
    await tick();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "network");
    assert.equal(failures[0].retryable, true);
    assert.equal(done.count, 0);
  });

  it("cancel closes socket, stops sink, and suppresses late callbacks", async () => {
    const { socket, sink, speech, done, failures } = setup();
    socket.emit("open", undefined);
    speech.push("hello");
    speech.cancel();
    speech.cancel();
    socket.emit("message", audioFrame([9]));
    socket.emit("message", contextClosedFrame());
    socket.emit("close", undefined);
    await tick();
    await tick();
    assert.equal(socket.closed, true);
    assert.equal(sink.stopped, true);
    assert.equal(sink.written.length, 0);
    assert.equal(done.count, 0);
    assert.equal(failures.length, 0);
  });

  it("logs connect, open, first audio, done, and failure without the key", async () => {
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    const { socket, speech, failures } = setup({ log: (event, data) => logs.push({ event, data }) });
    socket.emit("open", undefined);
    speech.push("hello");
    socket.emit("message", audioFrame([1, 2]));
    socket.emit("message", contextClosedFrame());
    await tick();
    await tick();
    await tick();
    const events = logs.map((l) => l.event);
    assert.ok(events.includes("tts-ws-connect"));
    assert.ok(events.includes("tts-ws-open"));
    assert.ok(events.includes("tts-ws-first-audio"));
    assert.ok(events.includes("tts-ws-done"));
    assert.ok(!JSON.stringify(logs).includes("secret-key"));

    const logs2: { event: string; data?: Record<string, unknown> }[] = [];
    const bad = setup({ log: (event, data) => logs2.push({ event, data }) });
    bad.socket.emit("open", undefined);
    bad.socket.emit("message", JSON.stringify({ error: { code: 16, message: "bad key" } }));
    await tick();
    assert.ok(logs2.some((l) => l.event === "tts-ws-failure"));
    assert.ok(!JSON.stringify({ logs2, failures }).includes("secret-key"));
  });

  it("routes a sink.write() rejection to onFailure once, never onDone", async () => {
    const socket = new FakeSocket();
    const failures: VoiceFailure[] = [];
    const done = { count: 0 };
    const sink: AudioSink = {
      async start(): Promise<void> {},
      async write(): Promise<void> {
        throw new Error("boom");
      },
      async finish(): Promise<void> {},
      async stop(): Promise<void> {},
    };
    startInworldSpeech(
      { key: "k", voiceId: "Ashley", onDone: (): void => {
        done.count += 1;
      }, onFailure: (f: VoiceFailure): void => {
        failures.push(f);
      } },
      {
        socketFactory: (): TtsSocket => socket as unknown as TtsSocket,
        sinkFactory: (): AudioSink => sink,
      },
    );
    socket.emit("open", undefined);
    socket.emit("message", audioFrame([1, 2]));
    socket.emit("message", audioFrame([3, 4]));
    socket.emit("message", contextClosedFrame());
    await tick();
    await tick();
    await tick();
    await tick();
    await tick();
    assert.equal(failures.length, 1);
    assert.equal(done.count, 0);
  });

  it("never splits inside a surrogate pair when no whitespace is present", () => {
    const { socket, speech } = setup();
    socket.emit("open", undefined);
    // Pair straddles the 2000-unit boundary: high surrogate at index 1999.
    const text = `${"a".repeat(1999)}\uD83D\uDE00${"b".repeat(500)}`;
    assert.ok(text.length > 2000);
    speech.push(text);
    const frames = socket.sent.slice(1).map((raw) => JSON.parse(raw) as { sendText: { text: string } });
    assert.ok(frames.length > 1);
    for (const f of frames) assert.ok(f.sendText.text.length <= 2000);
    for (const f of frames) {
      const t = f.sendText.text;
      const last = t.charCodeAt(t.length - 1);
      const first = t.charCodeAt(0);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), "chunk ends with lone high surrogate");
      assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "chunk starts with lone low surrogate");
    }
    assert.equal(
      frames.map((f) => f.sendText.text).join(""),
      text,
    );
  });
});
