import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createFfplaySink, FFPLAY_ARGS, FFPLAY_PATH } from "../src/player.ts";

interface FakeStdin extends EventEmitter {
  written: Buffer[];
  failNext: boolean;
  destroyed: boolean;
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
}

interface FakeProc extends EventEmitter {
  stdin: FakeStdin;
  args: string[];
  killed: string | null;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal: string): boolean;
}

function makeSpawn(log: { bin: string; args: string[] }[], procs: FakeProc[]): (...a: unknown[]) => FakeProc {
  return ((bin: unknown, args: unknown) => {
    const stdin = new EventEmitter() as FakeStdin;
    stdin.written = [];
    stdin.failNext = false;
    stdin.destroyed = false;
    const proc = new EventEmitter() as FakeProc;
    proc.stdin = stdin;
    proc.args = args as string[];
    proc.killed = null;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kill = (signal: string): boolean => {
      proc.killed = signal;
      proc.exitCode = null;
      proc.signalCode = signal;
      setImmediate(() => proc.emit("close", null));
      return true;
    };
    stdin.write = (chunk: Buffer): boolean => {
      stdin.written.push(chunk);
      if (stdin.failNext) {
        stdin.failNext = false;
        setImmediate(() => stdin.emit("drain"));
        return false;
      }
      return true;
    };
    stdin.end = (): void => {
      setImmediate(() => proc.emit("close", 0));
    };
    stdin.destroy = (): void => {
      stdin.destroyed = true;
    };
    log.push({ bin: bin as string, args: args as string[] });
    procs.push(proc);
    return proc;
  }) as (...a: unknown[]) => FakeProc;
}

describe("ffplay sink", () => {
  it("spawns ffplay with raw s16le 24kHz mono args", async () => {
    const log: { bin: string; args: string[] }[] = [];
    const procs: FakeProc[] = [];
    const sink = createFfplaySink({ spawn: makeSpawn(log, procs) as never });
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    assert.equal(log[0].bin, FFPLAY_PATH);
    assert.deepEqual(log[0].args, [...FFPLAY_ARGS]);
    assert.ok(log[0].args.includes("-sample_rate"));
    assert.ok(log[0].args.includes("-ch_layout"));
    await sink.stop();
  });

  it("write honors backpressure via drain", async () => {
    const log: { bin: string; args: string[] }[] = [];
    const procs: FakeProc[] = [];
    const sink = createFfplaySink({ spawn: makeSpawn(log, procs) as never });
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    procs[0].stdin.failNext = true;
    await sink.write(Buffer.from([1, 2, 3, 4]));
    assert.equal(procs[0].stdin.written.length, 1);
    await sink.stop();
  });

  it("finish ends stdin and resolves on exit", async () => {
    const log: { bin: string; args: string[] }[] = [];
    const procs: FakeProc[] = [];
    const sink = createFfplaySink({ spawn: makeSpawn(log, procs) as never });
    await sink.write(Buffer.from([0, 0]));
    await sink.finish();
    assert.equal(procs[0].killed, null);
  });

  it("stop kills immediately with SIGKILL and is idempotent", async () => {
    const log: { bin: string; args: string[] }[] = [];
    const procs: FakeProc[] = [];
    const sink = createFfplaySink({ spawn: makeSpawn(log, procs) as never });
    await sink.start({ sampleRate: 24000, channels: 1, encoding: "s16le" });
    await sink.stop();
    assert.equal(procs[0].killed, "SIGKILL");
    await sink.stop();
    assert.equal(procs[0].killed, "SIGKILL");
  });
});
