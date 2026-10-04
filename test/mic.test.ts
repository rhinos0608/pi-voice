import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAvFoundationSource, listMicrophones, MicError, parseMicrophoneList, withSessionFallback, withSinkFallback } from "../src/mic.ts";
import type { AudioSink, AudioSource } from "../src/contracts.ts";

const LISTING = `[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] [1] Capture screen 0
[AVFoundation indev @ 0x123] AVFoundation audio devices:
[AVFoundation indev @ 0x123] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x123] [1] iPhone Microphone
[AVFoundation indev @ 0x123] [2] USB Headset
: Input/output error
`;

test("parse keeps audio devices only", () => {
  assert.deepEqual(parseMicrophoneList(LISTING), [
    { index: 0, name: "MacBook Pro Microphone" },
    { index: 1, name: "iPhone Microphone" },
    { index: 2, name: "USB Headset" },
  ]);
});

test("parse ignores video-only listing", () => {
  const video = `[AVFoundation indev @ 0x1] AVFoundation video devices:\n[AVFoundation indev @ 0x1] [0] Camera\n`;
  assert.deepEqual(parseMicrophoneList(video), []);
});

test("listMicrophones uses injected runner", async () => {
  const devices = await listMicrophones({ run: async () => ({ stderr: LISTING }) });
  assert.equal(devices.length, 3);
  assert.equal(devices[1]?.name, "iPhone Microphone");
});

type FakeProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal: string) => void;
  killedWith: string[];
};

function fakeSpawnFactory(onArgs?: (args: string[]) => void): { spawnImpl: (...a: never[]) => FakeProc; procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  const spawnImpl = (_cmd: string, args: string[]): FakeProc => {
    onArgs?.(args);
    const proc = new EventEmitter() as FakeProc;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killedWith = [];
    proc.kill = (signal: string): void => {
      proc.killedWith.push(signal);
    };
    procs.push(proc);
    return proc;
  };
  return { spawnImpl: spawnImpl as unknown as (...a: never[]) => FakeProc, procs };
}

test("named mic resolves to current index", async () => {
  const { spawnImpl } = fakeSpawnFactory();
  let seenArgs: string[] = [];
  const { spawnImpl: s2 } = fakeSpawnFactory((args) => {
    seenArgs = args;
  });
  void spawnImpl;
  const src = createAvFoundationSource(
    { kind: "named", name: "iPhone Microphone" },
    {
      spawnImpl: s2 as never,
      listDeps: { run: async () => ({ stderr: LISTING }) },
      killTimeoutMs: 5,
    },
  );
  const frames: Buffer[] = [];
  await src.start(
    (c) => frames.push(c),
    () => {},
  );
  assert.equal(src.resolvedInput, ":1");
  assert.ok(seenArgs.includes(":1"));
  await src.stop();
});

test("missing name falls back to default with notice", async () => {
  const notices: string[] = [];
  const { spawnImpl } = fakeSpawnFactory();
  const src = createAvFoundationSource(
    { kind: "named", name: "No Such Mic" },
    {
      spawnImpl: spawnImpl as never,
      listDeps: { run: async () => ({ stderr: LISTING }) },
      onNotice: (m) => notices.push(m),
      killTimeoutMs: 5,
    },
  );
  await src.start(
    () => {},
    () => {},
  );
  assert.equal(src.resolvedInput, ":default");
  assert.equal(notices.length, 1);
  assert.match(notices[0] ?? "", /No Such Mic/);
  await src.stop();
});

test("default mic uses :default", async () => {
  let seenArgs: string[] = [];
  const { spawnImpl } = fakeSpawnFactory((args) => {
    seenArgs = args;
  });
  const src = createAvFoundationSource({ kind: "default" }, { spawnImpl: spawnImpl as never, killTimeoutMs: 5 });
  await src.start(
    () => {},
    () => {},
  );
  assert.ok(seenArgs.includes(":default"));
  await src.stop();
});

test("duplicate names throw asking to disambiguate", async () => {
  const dup = `${LISTING}[AVFoundation indev @ 0x123] [3] iPhone Microphone\n`;
  const { spawnImpl } = fakeSpawnFactory();
  const src = createAvFoundationSource(
    { kind: "named", name: "iPhone Microphone" },
    { spawnImpl: spawnImpl as never, listDeps: { run: async () => ({ stderr: dup }) } },
  );
  await assert.rejects(src.start(() => {}, () => {}), /disambiguate|Multiple microphones/i);
});

test("odd trailing byte stitches into next chunk", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5 },
  );
  const frames: Buffer[] = [];
  await src.start((c) => frames.push(c), () => {});
  const proc = procs[0];
  assert.ok(proc);
  proc.stdout.emit("data", Buffer.from([0x01, 0x02, 0x03]));
  proc.stdout.emit("data", Buffer.from([0x04, 0x05]));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], Buffer.from([0x01, 0x02]));
  assert.deepEqual(frames[1], Buffer.from([0x03, 0x04]));
  await src.stop();
});

test("child exit routes to onError", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5 },
  );
  const errors: Error[] = [];
  await src.start(
    () => {},
    (e) => errors.push(e),
  );
  procs[0]?.emit("exit", 1, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /exited/);
  await src.stop();
});

test("permission failure gives TCC guidance", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5 },
  );
  const errors: Error[] = [];
  await src.start(
    () => {},
    (e) => errors.push(e),
  );
  procs[0]?.stderr.emit("data", Buffer.from("Operation not permitted by TCC privacy settings"));
  procs[0]?.emit("exit", 1, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /System Settings > Privacy & Security/);
  await src.stop();
});

test("stop is idempotent and escalates SIGTERM then SIGKILL", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5 },
  );
  await src.start(
    () => {},
    () => {},
  );
  const proc = procs[0];
  assert.ok(proc);
  const stopping = src.stop();
  assert.deepEqual(proc.killedWith, ["SIGTERM"]);
  proc.emit("exit", null, "SIGTERM");
  await stopping;
  await src.stop();
  await src.stop();
  assert.deepEqual(proc.killedWith, ["SIGTERM"]);
});

function fakeTimers() {
  type Handle = { fn: () => void; ms: number };
  const pending: Handle[] = [];
  return {
    setTimeoutImpl: (fn: () => void, ms: number): unknown => {
      const handle: Handle = { fn, ms };
      pending.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle: unknown): void => {
      const index = pending.indexOf(handle as Handle);
      if (index >= 0) pending.splice(index, 1);
    },
    fire(): void {
      const due = pending.splice(0, pending.length);
      for (const handle of due) handle.fn();
    },
  };
}

test("capture args include low-latency input options before -i, in order", async () => {
  let seenArgs: string[] = [];
  const { spawnImpl } = fakeSpawnFactory((args) => {
    seenArgs = args;
  });
  const src = createAvFoundationSource({ kind: "default" }, { spawnImpl: spawnImpl as never, killTimeoutMs: 5 });
  await src.start(
    () => {},
    () => {},
  );
  const fflags = seenArgs.indexOf("-fflags");
  const probesize = seenArgs.indexOf("-probesize");
  const analyzeduration = seenArgs.indexOf("-analyzeduration");
  const inputFlag = seenArgs.indexOf("-i");
  const avf = seenArgs.indexOf("avfoundation");
  assert.ok(fflags !== -1 && seenArgs[fflags + 1] === "nobuffer");
  assert.ok(probesize !== -1 && seenArgs[probesize + 1] === "32");
  assert.ok(analyzeduration !== -1 && seenArgs[analyzeduration + 1] === "0");
  assert.ok(fflags < inputFlag && probesize < inputFlag && analyzeduration < inputFlag);
  assert.ok(avf < inputFlag);
  await src.stop();
});

test("startup timeout kills the process and reports MicError stalled", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const timers = fakeTimers();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5, ...timers, startupTimeoutMs: 50, stallMs: 50 },
  );
  let seen: unknown;
  await src.start(
    () => {},
    (e) => {
      seen = e;
    },
  );
  timers.fire();
  assert.ok(seen instanceof MicError);
  assert.equal((seen as MicError).code, "stalled");
  assert.ok(procs[0]?.killedWith.includes("SIGKILL"));
  await src.stop();
});

test("mid-stream stall after data flow reports MicError stalled", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const timers = fakeTimers();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5, ...timers, startupTimeoutMs: 1000, stallMs: 60 },
  );
  let seen: unknown;
  const chunks: Buffer[] = [];
  await src.start(
    (c) => chunks.push(c),
    (e) => {
      seen = e;
    },
  );
  procs[0]?.stdout.emit("data", Buffer.alloc(320));
  assert.equal(chunks.length, 1);
  timers.fire();
  assert.ok(seen instanceof MicError);
  assert.equal((seen as MicError).code, "stalled");
  assert.ok(procs[0]?.killedWith.includes("SIGKILL"));
  await src.stop();
});

test("no false stall trip while data keeps flowing", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const timers = fakeTimers();
  const src = createAvFoundationSource(
    { kind: "default" },
    { spawnImpl: spawnImpl as never, killTimeoutMs: 5, ...timers, startupTimeoutMs: 1000, stallMs: 1000 },
  );
  let errors = 0;
  await src.start(
    () => {},
    () => {
      errors += 1;
    },
  );
  procs[0]?.stdout.emit("data", Buffer.alloc(320));
  procs[0]?.stdout.emit("data", Buffer.alloc(320));
  await src.stop();
  timers.fire();
  assert.equal(errors, 0);
});

test("exit without permission text reports MicError exited with stderr tail", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource({ kind: "default" }, { spawnImpl: spawnImpl as never, killTimeoutMs: 5 });
  let seen: unknown;
  await src.start(
    () => {},
    (e) => {
      seen = e;
    },
  );
  procs[0]?.stderr.emit("data", Buffer.from("some ffmpeg trouble\n"));
  procs[0]?.emit("exit", 1, null);
  assert.ok(seen instanceof MicError);
  assert.equal((seen as MicError).code, "exited");
  assert.match((seen as MicError).message, /some ffmpeg trouble/);
  await src.stop();
});

test("spawn error reports MicError spawn", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource({ kind: "default" }, { spawnImpl: spawnImpl as never, killTimeoutMs: 5 });
  let seen: unknown;
  await src.start(
    () => {},
    (e) => {
      seen = e;
    },
  );
  procs[0]?.emit("error", new Error("boom"));
  assert.ok(seen instanceof MicError);
  assert.equal((seen as MicError).code, "spawn");
  await src.stop();
});

test("exit permission denial reports MicError permission", async () => {
  const { spawnImpl, procs } = fakeSpawnFactory();
  const src = createAvFoundationSource({ kind: "default" }, { spawnImpl: spawnImpl as never, killTimeoutMs: 5 });
  let seen: unknown;
  await src.start(
    () => {},
    (e) => {
      seen = e;
    },
  );
  procs[0]?.stderr.emit("data", Buffer.from("Permission denied by user\n"));
  procs[0]?.emit("exit", 1, null);
  assert.ok(seen instanceof MicError);
  assert.equal((seen as MicError).code, "permission");
  await src.stop();
});

function fakeFallbackSource(failWith?: Error): {
  source: import("../src/contracts.ts").AudioSource;
  starts: number;
  stops: number;
} {
  let starts = 0;
  let stops = 0;
  return {
    get starts(): number {
      return starts;
    },
    get stops(): number {
      return stops;
    },
    source: {
      start: async (): Promise<void> => {
        starts++;
        if (failWith) throw failWith;
      },
      stop: async (): Promise<void> => {
        stops++;
      },
    },
  };
}

test("withSessionFallback uses the primary when it starts", async () => {
  const primary = fakeFallbackSource();
  const fallback = fakeFallbackSource();
  let notices = 0;
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => fallback.source,
    shouldFallback: () => true,
    onFallback: () => {
      notices++;
    },
  });
  await src.start(() => {}, () => {});
  await src.stop();
  assert.equal(primary.starts, 1);
  assert.equal(primary.stops, 1);
  assert.equal(fallback.starts, 0);
  assert.equal(notices, 0);
});

test("withSessionFallback swaps to the fallback once on a matching start failure", async () => {
  const primary = fakeFallbackSource(new Error("helper device gone"));
  const fallback = fakeFallbackSource();
  let notices = 0;
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => fallback.source,
    shouldFallback: (err) => (err as Error).message.includes("device"),
    onFallback: () => {
      notices++;
    },
  });
  await src.start(() => {}, () => {});
  assert.equal(primary.starts, 1);
  assert.equal(fallback.starts, 1);
  assert.equal(notices, 1);
  await src.stop();
  await src.start(() => {}, () => {});
  assert.equal(primary.starts, 1);
  assert.equal(fallback.starts, 2);
  assert.equal(fallback.stops, 1);
  assert.equal(notices, 1);
});

test("withSessionFallback propagates non-matching errors without swapping", async () => {
  const primary = fakeFallbackSource(new Error("permission denied"));
  const fallback = fakeFallbackSource();
  let notices = 0;
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => fallback.source,
    shouldFallback: (err) => (err as Error).message.includes("device"),
    onFallback: () => {
      notices++;
    },
  });
  await assert.rejects(() => src.start(() => {}, () => {}), /permission denied/);
  assert.equal(fallback.starts, 0);
  assert.equal(notices, 0);
});

function controllableSource(): {
  source: AudioSource;
  onPcm: (chunk: Buffer) => void;
  onError: (error: Error) => void;
  starts: () => number;
  stops: () => number;
} {
  let starts = 0;
  let stops = 0;
  let onPcm: (chunk: Buffer) => void = () => {};
  let onError: (error: Error) => void = () => {};
  return {
    source: {
      start: async (pcm, err): Promise<void> => {
        starts++;
        onPcm = pcm;
        onError = err;
      },
      stop: async (): Promise<void> => {
        stops++;
      },
    },
    get onPcm(): (chunk: Buffer) => void {
      return onPcm;
    },
    get onError(): (error: Error) => void {
      return onError;
    },
    starts: () => starts,
    stops: () => stops,
  };
}

test("withSessionFallback swaps capture on a matching runtime error without notifying the session", async () => {
  const primary = controllableSource();
  const fallback = controllableSource();
  let notices = 0;
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => fallback.source,
    shouldFallback: (err) => (err as Error).message.includes("device"),
    onFallback: () => {
      notices++;
    },
  });
  const seen: Error[] = [];
  const chunks: Buffer[] = [];
  await src.start(
    (c) => chunks.push(c),
    (e) => seen.push(e),
  );
  primary.onError(new Error("helper device gone"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices, 1);
  assert.equal(fallback.starts(), 1);
  assert.equal(seen.length, 0);
  fallback.onPcm(Buffer.from([1, 2]));
  assert.equal(chunks.length, 1);
  await src.stop();
  assert.equal(fallback.stops(), 1);
});

test("withSessionFallback keeps runtime permission errors on the guidance path", async () => {
  const primary = controllableSource();
  const fallback = controllableSource();
  let notices = 0;
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => fallback.source,
    shouldFallback: (err) => (err as Error).message.includes("device"),
    onFallback: () => {
      notices++;
    },
  });
  const seen: Error[] = [];
  await src.start(
    () => {},
    (e) => seen.push(e),
  );
  primary.onError(new Error("permission denied"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.length, 1);
  assert.match(seen[0]?.message ?? "", /permission denied/);
  assert.equal(fallback.starts(), 0);
  assert.equal(notices, 0);
  await src.stop();
});

function fakeSink(fail?: { on: "start" | "write" | "finish"; error: Error }): {
  sink: AudioSink;
  starts: () => number;
  writes: () => number;
} {
  let starts = 0;
  let writes = 0;
  return {
    starts: () => starts,
    writes: () => writes,
    sink: {
      start: async (): Promise<void> => {
        starts++;
        if (fail?.on === "start") throw fail.error;
      },
      write: async (): Promise<void> => {
        writes++;
        if (fail?.on === "write") throw fail.error;
      },
      finish: async (): Promise<void> => {
        if (fail?.on === "finish") throw fail.error;
      },
      stop: async (): Promise<void> => {},
    },
  };
}

const SINK_FORMAT = { sampleRate: 24000 as const, channels: 1 as const, encoding: "s16le" as const };

test("withSinkFallback rescues a speech when the helper sink dies mid-write", async () => {
  const helperErr = new Error("voice-io helper exited");
  const primary = fakeSink({ on: "write", error: helperErr });
  const fallback = fakeSink();
  let notices = 0;
  const sink = withSinkFallback({
    primary: primary.sink,
    createFallback: () => fallback.sink,
    shouldFallback: () => true,
    onFallback: () => {
      notices++;
    },
  });
  await sink.start(SINK_FORMAT);
  await sink.write(Buffer.from([1, 2, 3, 4]));
  await sink.finish();
  assert.equal(notices, 1);
  assert.equal(fallback.starts(), 1);
  assert.equal(fallback.writes(), 1);
});

test("withSinkFallback fails cleanly when the fallback also fails", async () => {
  const helperErr = new Error("voice-io helper exited");
  const primary = fakeSink({ on: "write", error: helperErr });
  const fallback = fakeSink({ on: "write", error: new Error("ffplay gone") });
  let notices = 0;
  const sink = withSinkFallback({
    primary: primary.sink,
    createFallback: () => fallback.sink,
    shouldFallback: () => true,
    onFallback: () => {
      notices++;
    },
  });
  await sink.start(SINK_FORMAT);
  await assert.rejects(() => sink.write(Buffer.from([1])), /ffplay gone/);
  assert.equal(notices, 1);
});

test("withSessionFallback stop during pending fallback start leaves mic stopped", async () => {
  const primary = controllableSource();
  let releaseFallbackStart!: () => void;
  let fallbackPcm: (chunk: Buffer) => void = () => {};
  let fallbackStops = 0;
  const deferredFallback: AudioSource = {
    start: async (pcm): Promise<void> => {
      fallbackPcm = pcm;
      await new Promise<void>((resolve) => {
        releaseFallbackStart = resolve;
      });
    },
    stop: async (): Promise<void> => {
      fallbackStops++;
    },
  };
  let notices = 0;
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => deferredFallback,
    shouldFallback: (err) => (err as Error).message.includes("device"),
    onFallback: () => {
      notices++;
    },
  });
  const chunks: Buffer[] = [];
  const seen: Error[] = [];
  await src.start(
    (c) => chunks.push(c),
    (e) => seen.push(e),
  );
  primary.onError(new Error("helper device gone"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notices, 1);
  const stopping = src.stop();
  releaseFallbackStart();
  await stopping;
  // Fallback start completed after stop: it must have been stopped immediately.
  assert.equal(fallbackStops, 1);
  // PCM arriving late from the orphaned fallback must never reach the session.
  fallbackPcm(Buffer.from([9, 9]));
  assert.equal(chunks.length, 0);
  assert.equal(seen.length, 0);
});

test("withSessionFallback restart after stop works", async () => {
  const primary = controllableSource();
  const fallback = controllableSource();
  const src = withSessionFallback({
    primary: primary.source,
    createFallback: () => fallback.source,
    shouldFallback: (err) => (err as Error).message.includes("device"),
    onFallback: () => {},
  });
  const chunks: Buffer[] = [];
  await src.start(
    (c) => chunks.push(c),
    () => {},
  );
  primary.onError(new Error("helper device gone"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fallback.starts(), 1);
  await src.stop();
  assert.equal(fallback.stops(), 1);
  const chunks2: Buffer[] = [];
  await src.start(
    (c) => chunks2.push(c),
    () => {},
  );
  fallback.onPcm(Buffer.from([7, 8]));
  assert.equal(chunks2.length, 1);
  await src.stop();
});
