/** voice-io wrapper tests: fake child process, no real helper binary. */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { describe, it, type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  FINISH_FRAME,
  PLAY_FRAME,
  QUIT_FRAME,
  STOP_FRAME,
  createVoiceIo,
  ensureVoiceIoHelper,
  voiceIoHelperPath,
} from "../src/voice-io.ts";

type SpawnCall = { path: string; args: string[]; opts: unknown };

class FakeStdin extends PassThrough {
  written: Buffer[] = [];
  failNextDrain = false;
  override write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return super.write(chunk);
  }
}

class FakeChild extends EventEmitter {
  stdin: FakeStdin = new FakeStdin();
  stdout = new PassThrough();
  stderr = new PassThrough();
  fd3 = new PassThrough();
  stdio: [FakeStdin, PassThrough, PassThrough, PassThrough];
  killed: string[] = [];
  constructor() {
    super();
    this.stdio = [this.stdin, this.stdout, this.stderr, this.fd3];
  }
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }
}

function makeSpawn() {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = ((path: string, args: string[], opts: unknown): unknown => {
    calls.push({ path, args, opts });
    const child = new FakeChild();
    // Mirror the real helper: a QUIT frame makes the process exit promptly.
    // Each stdin write is exactly one control frame, so byte 0 is its type.
    const innerWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: Buffer | string): boolean => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const ok = innerWrite(buf);
      if ((buf[0] as number) === QUIT_FRAME) setImmediate(() => child.emit("exit", 0, null));
      return ok;
    }) as FakeStdin["write"];
    children.push(child);
    return child;
  }) as Parameters<typeof createVoiceIo>[0]["spawnImpl"];
  return { calls, children, spawnImpl };
}

function emitReady(child: FakeChild, voiceProcessing = true): void {
  child.fd3.emit(
    "data",
    Buffer.from(JSON.stringify({ event: "ready", inputSampleRate: 16000, voiceProcessing }) + "\n"),
  );
}

function emitEvent(child: FakeChild, obj: unknown): void {
  child.fd3.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`));
}

/** Read one stdin control frame from the fake child's written bytes. */
function readFrames(stdin: FakeStdin): { type: number; payload: Buffer }[] {
  const buf = Buffer.concat(stdin.written);
  const frames: { type: number; payload: Buffer }[] = [];
  let off = 0;
  while (off + 5 <= buf.length) {
    const type = buf[off] ?? 0;
    const len = buf.readUInt32LE(off + 1);
    frames.push({ type, payload: buf.subarray(off + 5, off + 5 + len) });
    off += 5 + len;
  }
  assert.equal(off, buf.length);
  return frames;
}

describe("voice-io framing", () => {
  it("source.start resolves on ready and delivers even-length PCM", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const got: Buffer[] = [];
    const started = h.source.start(
      (c) => got.push(c),
      () => {},
    );
    emitReady(children[0] as FakeChild);
    await started;
    (children[0] as FakeChild).stdout.emit("data", Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(got, [Buffer.from([1, 2, 3, 4])]);
    await h.source.stop();
    await h.close();
  });

  it("carries odd trailing bytes into the next chunk", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const got: Buffer[] = [];
    const started = h.source.start(
      (c) => got.push(c),
      () => {},
    );
    emitReady(children[0] as FakeChild);
    await started;
    const child = children[0] as FakeChild;
    child.stdout.emit("data", Buffer.from([1, 2, 3]));
    child.stdout.emit("data", Buffer.from([4, 5]));
    assert.deepEqual(got, [Buffer.from([1, 2]), Buffer.from([3, 4])]);
    await h.source.stop();
    await h.close();
  });

  it("discards PCM arriving while no source is started", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const got: Buffer[] = [];
    const started = h.source.start(
      (c) => got.push(c),
      () => {},
    );
    emitReady(children[0] as FakeChild);
    await started;
    await h.source.stop();
    // QUIT + SIGKILL path leaves the (fake) child in place; late stdout is ignored.
    (children[0] as FakeChild).stdout.emit("data", Buffer.from([9, 9]));
    assert.deepEqual(got, []);
    await h.close();
  });

  it("rejects start on the helper error event with a coded Error", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const started = h.source.start(
      () => {},
      () => {},
    );
    emitEvent(children[0] as FakeChild, { event: "error", code: "permission", message: "denied" });
    await assert.rejects(started, (err: Error & { code?: string }) => {
      assert.equal((err as { code?: string }).code, "permission");
      return true;
    });
    await h.close();
  });

  it("routes post-start helper errors to onError", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const errors: (Error & { code?: string })[] = [];
    const started = h.source.start(
      () => {},
      (e) => errors.push(e as Error & { code?: string }),
    );
    emitReady(children[0] as FakeChild);
    await started;
    emitEvent(children[0] as FakeChild, { event: "error", code: "engine", message: "boom" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "engine");
    await h.source.stop();
    await h.close();
  });
});

describe("voice-io unexpected exit", () => {
  it("delivers unexpected exit once to source onError and rejects pending finish", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const errors: (Error & { code?: string })[] = [];
    const started = h.source.start(
      () => {},
      (e) => errors.push(e as Error & { code?: string }),
    );
    emitReady(children[0] as FakeChild);
    await started;
    const sink = h.createSink();
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    await sink.write(Buffer.from([1, 2]));
    const finishing = sink.finish();
    const assertion = assert.rejects(finishing, (err: Error & { code?: string }) => {
      assert.equal((err as { code?: string }).code, "exited");
      return true;
    });
    (children[0] as FakeChild).emit("exit", 1, null);
    await assertion;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "exited");
    await h.close();
  });

  it("delivers stdout end to source onError and rejects pending backpressured write", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const errors: (Error & { code?: string })[] = [];
    const started = h.source.start(
      () => {},
      (e) => errors.push(e as Error & { code?: string }),
    );
    emitReady(children[0] as FakeChild);
    await started;
    const sink = h.createSink();
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    const child = children[0] as FakeChild;
    child.stdin.write = ((chunk: Buffer | string): boolean => {
      child.stdin.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return false; // never drains
    }) as FakeStdin["write"];
    const writing = sink.write(Buffer.from([9, 9]));
    const assertion = assert.rejects(writing, (err: Error & { code?: string }) => {
      assert.equal((err as { code?: string }).code, "exited");
      return true;
    });
    child.stdout.emit("end");
    await assertion;
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "exited");
    await h.close();
  });

  it("keeps the preceding error-event code and notifies onError only once across error then exit", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const errors: (Error & { code?: string })[] = [];
    const started = h.source.start(
      () => {},
      (e) => errors.push(e as Error & { code?: string }),
    );
    emitReady(children[0] as FakeChild);
    await started;
    emitEvent(children[0] as FakeChild, { event: "error", code: "engine", message: "stdout closed" });
    (children[0] as FakeChild).emit("exit", 3, null);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.code, "engine");
    await h.close();
  });
});

describe("voice-io ref-counting", () => {
  it("spawns on first ref and sends QUIT when refs reach 0", async () => {
    const { calls, children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    assert.equal(calls.length, 0);
    const started = h.source.start(
      () => {},
      () => {},
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args, ["--voice-processing", "on"]);
    emitReady(children[0] as FakeChild);
    await started;
    await h.source.stop();
    const frames = readFrames((children[0] as FakeChild).stdin);
    assert.deepEqual(frames.map((f) => f.type), [QUIT_FRAME]);
    await h.close();
  });

  it("passes --input and --voice-processing off through to the helper", async () => {
    const { calls, children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", input: "Yeti", voiceProcessing: false, spawnImpl });
    const started = h.source.start(
      () => {},
      () => {},
    );
    assert.deepEqual(calls[0]?.args, ["--voice-processing", "off", "--input", "Yeti"]);
    emitReady(children[0] as FakeChild, false);
    await started;
    await h.source.stop();
    await h.close();
  });

  it("passes --agc on through to the helper only when opted in", async () => {
    const { calls, children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", agc: true, spawnImpl });
    const started = h.source.start(
      () => {},
      () => {},
    );
    assert.deepEqual(calls[0]?.args, ["--voice-processing", "on", "--agc", "on"]);
    emitReady(children[0] as FakeChild);
    await started;
    await h.source.stop();
    await h.close();
  });

  it("omits --agc by default (helper default is off)", async () => {
    const { calls, children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const started = h.source.start(
      () => {},
      () => {},
    );
    assert.deepEqual(calls[0]?.args, ["--voice-processing", "on"]);
    emitReady(children[0] as FakeChild);
    await started;
    await h.source.stop();
    await h.close();
  });
});

describe("voice-io sink", () => {
  it("sends PLAY frames and resolves finish() on drained", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const sink = h.createSink();
    const started = sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    emitReady(children[0] as FakeChild);
    await started;
    await sink.write(Buffer.from([1, 2, 3, 4]));
    const finishing = sink.finish();
    emitEvent(children[0] as FakeChild, { event: "drained" });
    await finishing;
    const frames = readFrames((children[0] as FakeChild).stdin);
    // finish() releases the last ref, so QUIT follows FINISH.
    assert.deepEqual(frames.map((f) => f.type), [PLAY_FRAME, FINISH_FRAME, QUIT_FRAME]);
    assert.deepEqual(frames[0]?.payload, Buffer.from([1, 2, 3, 4]));
    await h.close();
  });

  it("a playback-error fails a pending finish but keeps the source alive", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const errors: (Error & { code?: string })[] = [];
    const got: Buffer[] = [];
    const started = h.source.start(
      (c) => got.push(c),
      (e) => errors.push(e as Error & { code?: string }),
    );
    emitReady(children[0] as FakeChild);
    await started;
    const sink = h.createSink();
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    await sink.write(Buffer.from([1, 2, 3, 4]));
    const finishing = sink.finish();
    emitEvent(children[0] as FakeChild, { event: "playback-error", code: "playback", message: "no output" });
    await assert.rejects(finishing, (err: Error & { code?: string }) => {
      assert.equal((err as { code?: string }).code, "engine");
      return true;
    });
    // Capture is untouched: no source error, PCM still flows, and a
    // retried finish can still resolve on drained.
    assert.equal(errors.length, 0);
    (children[0] as FakeChild).stdout.emit("data", Buffer.from([5, 6]));
    assert.deepEqual(got, [Buffer.from([5, 6])]);
    const retry = sink.finish();
    emitEvent(children[0] as FakeChild, { event: "drained" });
    await retry;
    const stopping = sink.stop();
    emitEvent(children[0] as FakeChild, { event: "stopped" });
    await stopping;
    await h.source.stop();
    await h.close();
  });

  it("an error event with code playback stays sink-local", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const errors: (Error & { code?: string })[] = [];
    const started = h.source.start(
      () => {},
      (e) => errors.push(e as Error & { code?: string }),
    );
    emitReady(children[0] as FakeChild);
    await started;
    const sink = h.createSink();
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    const finishing = sink.finish();
    emitEvent(children[0] as FakeChild, { event: "error", code: "playback", message: "no output" });
    await assert.rejects(finishing);
    assert.equal(errors.length, 0);
    const stopping = sink.stop();
    emitEvent(children[0] as FakeChild, { event: "stopped" });
    await stopping;
    await h.source.stop();
    await h.close();
  });

  it("rejects non-24kHz formats", async () => {
    const { spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const sink = h.createSink();
    await assert.rejects(
      sink.start({ sampleRate: 16000, channels: 1, encoding: "s16le" } as never),
      /only/,
    );
    await h.close();
  });

  it("stop() sends STOP and resolves on stopped", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const sink = h.createSink();
    const started = sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    emitReady(children[0] as FakeChild);
    await started;
    const stopping = sink.stop();
    emitEvent(children[0] as FakeChild, { event: "stopped" });
    await stopping;
    const frames = readFrames((children[0] as FakeChild).stdin);
    assert.deepEqual(frames.map((f) => f.type), [STOP_FRAME, QUIT_FRAME]);
    await h.close();
  });

  it("a new sink start() stops the previous sink", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const first = h.createSink();
    const firstStarted = first.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    emitReady(children[0] as FakeChild);
    await firstStarted;
    const second = h.createSink();
    const secondStarted = second.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    // The handover STOP for the first sink needs its stopped event; the
    // respawned helper then needs its own ready before second.start resolves.
    emitEvent(children[0] as FakeChild, { event: "stopped" });
    while (children.length < 2) await new Promise((r) => setImmediate(r));
    emitReady(children[1] as FakeChild);
    await secondStarted;
    const frames = readFrames((children[0] as FakeChild).stdin);
    assert.ok(frames.some((f) => f.type === STOP_FRAME));
    await second.stop();
    await h.close();
  });

  it("honors stdin backpressure via drain", async () => {
    const { children, spawnImpl } = makeSpawn();
    const h = createVoiceIo({ helperPath: "/bin/voice-io", spawnImpl });
    const sink = h.createSink();
    const started = sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    emitReady(children[0] as FakeChild);
    await started;
    const child = children[0] as FakeChild;
    // Force backpressure: stub stdin.write to report full once.
    const realWrite = child.stdin.write.bind(child.stdin);
    let drained = false;
    child.stdin.write = ((chunk: Buffer | string): boolean => {
      child.stdin.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (!drained) {
        drained = true;
        setImmediate(() => child.stdin.emit("drain"));
        return false;
      }
      return realWrite(chunk);
    }) as FakeStdin["write"];
    await sink.write(Buffer.from([7, 8]));
    const stopDone = sink.stop();
    emitEvent(child, { event: "stopped" });
    await stopDone;
    const frames = readFrames(child.stdin);
    // The test wrapper records the chunk once and reports backpressure once.
    assert.equal(frames.filter((f) => f.type === PLAY_FRAME).length, 1);
    assert.ok(frames.some((f) => f.type === STOP_FRAME));
    await h.close();
  });
});

describe("voice-io live helper (real binary)", () => {
  // Exercises the compiled Swift helper instead of the fake child above:
  // without voice processing the old binary aborted with SIGABRT
  // ("player started when in a disconnected state") within ~1 s.
  // Digital silence only; never audible sound.
  const live = process.platform === "darwin";

  type LiveEvent = { event?: string; code?: string; message?: string; duckingLevel?: number; advancedDucking?: boolean };
  type LiveResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    events: LiveEvent[];
    stdoutBytes: number;
    stderr: string;
  };

  function encodeLiveFrame(type: number, payload?: Buffer): Buffer {
    const body = payload ?? Buffer.alloc(0);
    const header = Buffer.alloc(5);
    header[0] = type;
    header.writeUInt32LE(body.length, 1);
    return Buffer.concat([header, body]);
  }

  function runHelper(bin: string, args: string[], settleMs: number, frames: Buffer[] = []): Promise<LiveResult> {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    const events: LiveEvent[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let tail = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBytes += d.length;
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    const fd3 = child.stdio[3] as unknown as EventEmitter | null;
    fd3?.on("data", (d: Buffer) => {
      tail += d.toString("utf8");
      let idx = tail.indexOf("\n");
      while (idx >= 0) {
        const line = tail.slice(0, idx).trim();
        tail = tail.slice(idx + 1);
        if (line.length > 0) {
          try {
            events.push(JSON.parse(line) as LiveEvent);
          } catch {
            // Non-JSON fd3 output is ignored.
          }
        }
        idx = tail.indexOf("\n");
      }
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const collect = async (): Promise<LiveResult> => {
      for (const frame of frames) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          child.stdin?.write(frame);
        } catch {
          // Helper already gone; the exit below reports it.
        }
      }
      await new Promise((r) => setTimeout(r, settleMs));
      try {
        child.stdin?.end();
      } catch {
        // Already gone.
      }
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raced = await Promise.race([
          exit,
          new Promise<null>((resolve) => {
            killTimer = setTimeout(() => resolve(null), 8000);
          }),
        ]);
        if (raced === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          const killed = await exit;
          return { ...killed, events, stdoutBytes, stderr };
        }
        return { ...raced, events, stdoutBytes, stderr };
      } finally {
        if (killTimer !== undefined) clearTimeout(killTimer);
      }
    };
    return collect();
  }

  function skipWhenNoMic(t: TestContext, r: LiveResult): boolean {
    if (r.events.some((e) => e.event === "error" && (e.code === "permission" || e.code === "device"))) {
      t.skip("microphone unavailable in this environment");
      return true;
    }
    return false;
  }

  async function liveBinary(t: TestContext): Promise<string | undefined> {
    try {
      return await ensureVoiceIoHelper();
    } catch (err) {
      t.skip(`helper compile unavailable: ${(err as Error).message}`);
      return undefined;
    }
  }

  it("starts without voice processing and neither aborts nor crashes", { skip: !live, timeout: 55000 }, async (t) => {
    const bin = await liveBinary(t);
    if (bin === undefined) return;
    const r = await runHelper(bin, ["--voice-processing", "off"], 2500);
    if (skipWhenNoMic(t, r)) return;
    assert.notEqual(r.signal, "SIGABRT", `helper aborted: ${r.stderr.slice(-500)}`);
    assert.equal(r.signal, null, `helper killed by signal ${r.signal ?? "unknown"}: ${r.stderr.slice(-500)}`);
    const ready = r.events.some((e) => e.event === "ready");
    const engineError = r.events.some((e) => e.event === "error" && e.code === "engine");
    assert.ok(ready || engineError, `expected ready or an engine error event, got: ${JSON.stringify(r.events)}`);
    if (ready) assert.ok(r.stdoutBytes > 0, "expected capture bytes on stdout");
    // Without voice processing the ducking configuration is never applied,
    // so the ready event must not report ducking fields.
    const readyOff = r.events.find((e) => e.event === "ready");
    if (readyOff !== undefined) {
      assert.equal(readyOff.duckingLevel, undefined, `unexpected duckingLevel without voice processing: ${JSON.stringify(readyOff)}`);
      assert.equal(readyOff.advancedDucking, undefined, `unexpected advancedDucking without voice processing: ${JSON.stringify(readyOff)}`);
    }
  });

  it("drains one second of digital silence with voice processing on", { skip: !live, timeout: 55000 }, async (t) => {
    const bin = await liveBinary(t);
    if (bin === undefined) return;
    const silence = Buffer.alloc(48000); // 1 s of 24 kHz s16le digital silence
    const r = await runHelper(bin, ["--voice-processing", "on"], 5000, [
      Buffer.concat([encodeLiveFrame(PLAY_FRAME, silence), encodeLiveFrame(FINISH_FRAME)]),
    ]);
    if (skipWhenNoMic(t, r)) return;
    assert.ok(
      r.events.some((e) => e.event === "ready"),
      `expected a ready event, got: ${JSON.stringify(r.events)}`,
    );
    assert.ok(
      r.events.some((e) => e.event === "drained"),
      `expected drained after silence, got: ${JSON.stringify(r.events)}`,
    );
    assert.equal(r.signal, null, `helper killed by signal ${r.signal ?? "unknown"}: ${r.stderr.slice(-500)}`);
    assert.equal(r.code, 0, `helper exit code ${r.code ?? "unknown"}: ${r.stderr.slice(-500)}`);
  });

  it("reports min other-audio ducking with voice processing on", { skip: !live, timeout: 55000 }, async (t) => {
    const bin = await liveBinary(t);
    if (bin === undefined) return;
    const r = await runHelper(bin, ["--voice-processing", "on"], 2500);
    if (skipWhenNoMic(t, r)) return;
    const ready = r.events.find((e) => e.event === "ready");
    assert.ok(ready, `expected a ready event, got: ${JSON.stringify(r.events)}`);
    // 10 is AVAudioVoiceProcessingOtherAudioDuckingLevelMin; advanced
    // ducking stays off so the helper never turns down the owner's audio.
    assert.equal(ready?.duckingLevel, 10, `duckingLevel not min: ${JSON.stringify(ready)}`);
    assert.equal(ready?.advancedDucking, false, `advancedDucking not off: ${JSON.stringify(ready)}`);
    assert.equal(r.signal, null, `helper killed by signal ${r.signal ?? "unknown"}: ${r.stderr.slice(-500)}`);
  });
});

describe("ensureVoiceIoHelper", () => {
  it("skips compiling when the hashed binary already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-io-test-"));
    try {
      let execCalls = 0;
      const bin = await ensureVoiceIoHelper({
        cacheDir: dir,
        exec: async (_cmd, args) => {
          execCalls += 1;
          const out = args[args.indexOf("-o") + 1] as string;
          writeFileSync(out, "fake-binary");
          return { stdout: "", stderr: "" };
        },
      });
      assert.equal(execCalls, 1);
      assert.match(bin, /voice-io-[0-9a-f]{12}$/);
      assert.equal(voiceIoHelperPath(dir), bin);
      // Cache hit: no exec call.
      const again = await ensureVoiceIoHelper({
        cacheDir: dir,
        exec: async () => {
          execCalls += 1;
          return { stdout: "", stderr: "" };
        },
      });
      assert.equal(again, bin);
      assert.equal(execCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear Error including the compiler stderr tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-io-test-"));
    try {
      await assert.rejects(
        ensureVoiceIoHelper({
          cacheDir: dir,
          exec: async () => {
            throw new Error("xcrun swiftc failed: <stdin>:1: boom");
          },
        }),
        /voice-io compile failed/,
      );
      assert.equal(voiceIoHelperPath(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a missing-toolchain Error when xcrun is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voice-io-test-"));
    try {
      await assert.rejects(
        ensureVoiceIoHelper({
          cacheDir: dir,
          exec: async () => {
            throw new Error("spawn xcrun ENOENT");
          },
        }),
        /xcrun\/swiftc not found/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
