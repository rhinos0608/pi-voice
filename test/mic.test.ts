import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAvFoundationSource, listMicrophones, parseMicrophoneList } from "../src/mic.ts";

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
