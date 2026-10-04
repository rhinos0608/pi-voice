import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAvFoundationSource, listMicrophones, MicError, parseMicrophoneList, withSessionFallback } from "../src/mic.ts";

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
