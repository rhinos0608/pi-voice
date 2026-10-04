import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { AudioSink, VoiceFailure } from "../src/contracts.ts";
import { DEFAULT_TTS_MODEL, createWsTtsSocket, startSpeech } from "../src/tts.ts";
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

function setup(modelId?: string): {
  socket: FakeSocket;
  sink: ReturnType<typeof makeSink>;
  done: { count: number };
  failures: VoiceFailure[];
} {
  const socket = new FakeSocket();
  const sink = makeSink();
  const done = { count: 0 };
  const failures: VoiceFailure[] = [];
  startSpeech(
    {
      key: "secret-key",
      voiceId: "voice123",
      ...(modelId === undefined ? {} : { modelId }),
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
    },
  );
  return { socket, sink, done, failures };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("tts startSpeech", () => {
  it("uses header auth and model in URL, never the key in URL or body", () => {
    const { socket } = setup();
    socket.emit("open", undefined);
    const s = socket as unknown as { url: string; headers: Record<string, string> };
    assert.ok(s.url.includes(`model_id=${DEFAULT_TTS_MODEL}`));
    assert.ok(s.url.includes("output_format=pcm_24000"));
    assert.ok(!s.url.includes("secret-key"));
    assert.equal(s.headers["xi-api-key"], "secret-key");
    for (const raw of socket.sent) assert.ok(!raw.includes("secret-key"));
  });

  it("sends v4 init with only stability and similarity_boost", () => {
    const { socket } = setup("eleven_v4_turbo");
    socket.emit("open", undefined);
    const init = JSON.parse(socket.sent[0]) as { voice_settings: Record<string, unknown> };
    assert.deepEqual(Object.keys(init.voice_settings).sort(), ["similarity_boost", "stability"]);
  });

  it("sends flash init with speaker boost settings", () => {
    const { socket } = setup("eleven_flash_v2_5");
    socket.emit("open", undefined);
    const init = JSON.parse(socket.sent[0]) as { voice_settings: Record<string, unknown> };
    assert.equal(init.voice_settings["use_speaker_boost"], false);
    const s = socket as unknown as { url: string };
    assert.ok(s.url.includes("model_id=eleven_flash_v2_5"));
  });

  it("sends chunks with trailing space in order and empty-string close", () => {
    const socket = new FakeSocket();
    const sink = makeSink();
    const speech = startSpeech(
      { key: "k", voiceId: "v", onDone: (): void => {}, onFailure: (): void => {} },
      {
        socketFactory: (): TtsSocket => socket as unknown as TtsSocket,
        sinkFactory: (): AudioSink => sink,
      },
    );
    socket.emit("open", undefined);
    speech.push("hello");
    speech.push("world");
    speech.finish();
    const bodies = socket.sent.slice(1).map((s) => JSON.parse(s) as { text: string });
    assert.deepEqual(
      bodies.map((b) => b.text),
      ["hello ", "world ", ""],
    );
  });

  it("chunk order, empty close, null-audio final, onDone after drain", async () => {
    const { socket, sink, done } = setup();
    socket.emit("open", undefined);
    socket.emit(
      "message",
      JSON.stringify({ audio: Buffer.from([1, 2]).toString("base64"), isFinal: false }),
    );
    socket.emit("message", JSON.stringify({ audio: null, isFinal: true }));
    await tick();
    await tick();
    await tick();
    assert.equal(sink.written.length, 1);
    assert.deepEqual([...sink.written[0]], [1, 2]);
    assert.equal(sink.finished, true);
    assert.equal(done.count, 1);
  });

  it("accepts is_final snake-case final", async () => {
    const { socket, sink, done } = setup();
    socket.emit("open", undefined);
    socket.emit("message", JSON.stringify({ audio: null, is_final: true }));
    await tick();
    await tick();
    assert.equal(sink.finished, true);
    assert.equal(done.count, 1);
  });

  it("cancel closes socket, stops sink, suppresses late audio", async () => {
    const socket = new FakeSocket();
    const sink = makeSink();
    let done = 0;
    const failures: VoiceFailure[] = [];
    const speech = startSpeech(
      {
        key: "k",
        voiceId: "v",
        onDone: (): void => {
          done += 1;
        },
        onFailure: (f: VoiceFailure): void => {
          failures.push(f);
        },
      },
      {
        socketFactory: (): TtsSocket => socket as unknown as TtsSocket,
        sinkFactory: (): AudioSink => sink,
      },
    );
    socket.emit("open", undefined);
    speech.cancel();
    socket.emit("message", JSON.stringify({ audio: Buffer.from([9]).toString("base64") }));
    socket.emit("close", 1000);
    await tick();
    await tick();
    assert.equal(socket.closed, true);
    assert.equal(sink.stopped, true);
    assert.equal(sink.written.length, 0);
    assert.equal(done, 0);
    assert.equal(failures.length, 0);
  });

  it("maps errors without leaking the key and without a model hint for network failures", async () => {
    const { socket, failures } = setup();
    socket.emit("open", undefined);
    socket.emit("error", new Error("getaddrinfo ENOTFOUND api.elevenlabs.io"));
    await tick();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "network");
    assert.ok(!JSON.stringify(failures[0]).includes("secret-key"));
    assert.ok(!failures[0].message.includes("/voice model"));
  });

  it("maps auth close code without leaking the key", async () => {
    const { socket, failures } = setup();
    socket.emit("open", undefined);
    socket.emit("close", { code: 1008 });
    await tick();
    assert.equal(failures[0].code, "auth");
    assert.ok(!JSON.stringify(failures[0]).includes("secret-key"));
  });

  it("server model rejection suggests switching models", async () => {
    const { socket, failures } = setup("eleven_v4_turbo");
    socket.emit("open", undefined);
    socket.emit("message", JSON.stringify({ error: "model eleven_v4_turbo not supported on this endpoint" }));
    await tick();
    assert.equal(failures.length, 1);
    assert.ok(failures[0].message.includes("/voice model eleven_flash_v2_5"));
    assert.ok(!JSON.stringify(failures[0]).includes("secret-key"));
  });

  it("queues text pushed before open and sends it after init, in order", async () => {
    // ws throws on send() while CONNECTING; mirror that.
    const socket = new FakeSocket();
    let open = false;
    const realSend = socket.send.bind(socket);
    socket.send = (data: string): void => {
      if (!open) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
      realSend(data);
    };
    const failures: VoiceFailure[] = [];
    const speech = startSpeech(
      { key: "k", voiceId: "v", onDone: () => undefined, onFailure: (f) => failures.push(f) },
      { socketFactory: () => socket as unknown as TtsSocket, sinkFactory: () => makeSink() },
    );
    speech.push("Hello there.");
    speech.finish();
    open = true;
    socket.emit("open", undefined);
    await tick();
    assert.deepEqual(failures, []);
    const texts = socket.sent.map((raw) => (JSON.parse(raw) as { text: string }).text);
    assert.deepEqual(texts, [" ", "Hello there. ", ""]);
  });

  it("defaults to a model the stream-input endpoint accepts", () => {
    assert.equal(DEFAULT_TTS_MODEL, "eleven_flash_v2_5");
  });

  it("logs connect, open, first audio, final, and done", async () => {
    const socket = new FakeSocket();
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    let done = 0;
    startSpeech(
      { key: "secret-key", voiceId: "voice123", onDone: () => (done += 1), onFailure: () => undefined },
      {
        socketFactory: () => socket as unknown as TtsSocket,
        sinkFactory: () => makeSink(),
        log: (event, data) => logs.push({ event, data }),
      },
    );
    socket.emit("open", undefined);
    socket.emit("message", JSON.stringify({ audio: Buffer.from([1, 2, 3, 4]).toString("base64") }));
    socket.emit("message", JSON.stringify({ audio: Buffer.from([5, 6]).toString("base64") }));
    socket.emit("message", JSON.stringify({ audio: null, isFinal: true }));
    await tick();
    assert.equal(done, 1);
    assert.deepEqual(
      logs.map((l) => l.event),
      ["tts-ws-connect", "tts-ws-open", "tts-ws-first-audio", "tts-ws-final", "tts-ws-done"],
    );
    assert.equal(logs[0].data?.["modelId"], DEFAULT_TTS_MODEL);
    assert.deepEqual(
      { chunks: logs[3].data?.["chunks"], bytes: logs[3].data?.["bytes"] },
      { chunks: 2, bytes: 6 },
    );
    assert.ok(!JSON.stringify(logs).includes("secret-key"));
  });

  it("surfaces an HTTP upgrade rejection with the server's reason and a model hint", async () => {
    const body = JSON.stringify({
      detail: {
        type: "validation_error",
        code: "unsupported_model",
        message: "Model 'eleven_v4_turbo' is not supported on the text-to-speech websocket endpoint.",
        request_id: "4011429402deadbeef",
      },
    });
    const server = createServer();
    server.on("upgrade", (_req, sock) => {
      sock.end(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const logs: { event: string; data?: Record<string, unknown> }[] = [];
    try {
      const failure = await new Promise<VoiceFailure>((resolve, reject) => {
        startSpeech(
          { key: "secret-key", voiceId: "voice123", modelId: "eleven_v4_turbo", onDone: () => reject(new Error("done")), onFailure: resolve },
          {
            socketFactory: (_url, init) => createWsTtsSocket(`ws://127.0.0.1:${port}/`, init),
            sinkFactory: () => makeSink(),
            log: (event, data) => logs.push({ event, data }),
          },
        );
      });
      // request_id digits must not be mistaken for a 401/429/402 status.
      assert.equal(failure.code, "protocol");
      assert.equal(failure.retryable, false);
      assert.ok(failure.message.includes("not supported on the text-to-speech websocket"), failure.message);
      assert.ok(failure.message.includes("/voice model eleven_flash_v2_5"), failure.message);
      assert.ok(logs.some((l) => l.event === "tts-ws-rejected" && l.data?.["status"] === 400));
      assert.ok(!JSON.stringify({ failure, logs }).includes("secret-key"));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("maps HTTP upgrade status codes to failure kinds", async () => {
    for (const [status, code] of [[401, "auth"], [402, "quota"], [429, "rate"], [503, "network"]] as const) {
      const server = createServer();
      server.on("upgrade", (_req, sock) => {
        sock.end(`HTTP/1.1 ${status} X\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const failure = await new Promise<VoiceFailure>((resolve, reject) => {
          startSpeech(
            { key: "k", voiceId: "v", onDone: () => reject(new Error("done")), onFailure: resolve },
            { socketFactory: (_url, init) => createWsTtsSocket(`ws://127.0.0.1:${port}/`, init), sinkFactory: () => makeSink() },
          );
        });
        assert.equal(failure.code, code, `HTTP ${status}`);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
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
    startSpeech(
      { key: "k", voiceId: "v", onDone: (): void => {
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
    socket.emit("message", JSON.stringify({ audio: Buffer.from([1, 2]).toString("base64") }));
    socket.emit("message", JSON.stringify({ audio: Buffer.from([3, 4]).toString("base64") }));
    socket.emit("message", JSON.stringify({ audio: null }));
    for (let i = 0; i < 5; i += 1) await tick();
    assert.equal(failures.length, 1);
    assert.equal(done.count, 0);
  });
});
