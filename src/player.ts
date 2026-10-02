/** ffplay-backed AudioSink (lane D). */

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import type { AudioSink } from "./contracts.ts";

export const FFPLAY_PATH = "/opt/homebrew/bin/ffplay";

/** Raw PCM input flags verified against ffplay 9.0.1 (`-h demuxer=s16le`). */
export const FFPLAY_ARGS: readonly string[] = [
  "-nodisp",
  "-autoexit",
  "-loglevel",
  "error",
  "-f",
  "s16le",
  "-sample_rate",
  "24000",
  "-ch_layout",
  "mono",
  "-i",
  "pipe:0",
  "-fflags",
  "nobuffer",
  "-flags",
  "low_delay",
  "-probesize",
  "32",
  "-analyzeduration",
  "0",
];

export type FfplaySinkDeps = {
  spawn?: typeof nodeSpawn;
  ffplayPath?: string;
};

type SinkState = "idle" | "running" | "finished" | "stopped";

/**
 * Create an AudioSink that streams 24-kHz mono s16le PCM to ffplay stdin.
 * write() honors stdin backpressure; finish() drains via EOF and resolves
 * on process exit; stop() kills immediately (SIGKILL) and is idempotent.
 */
export function createFfplaySink(deps?: FfplaySinkDeps): AudioSink {
  const spawnFn = deps?.spawn ?? nodeSpawn;
  const bin = deps?.ffplayPath ?? FFPLAY_PATH;
  let child: ChildProcess | null = null;
  let state: SinkState = "idle";
  let exitPromise: Promise<void> | null = null;
  let exitResolve: (() => void) | null = null;
  let exitReject: ((err: Error) => void) | null = null;

  function ensureStarted(): ChildProcess {
    if (child !== null) return child;
    const proc = spawnFn(bin, [...FFPLAY_ARGS], { stdio: ["pipe", "ignore", "ignore"] });
    child = proc;
    state = "running";
    exitPromise = new Promise<void>((resolve, reject) => {
      exitResolve = resolve;
      exitReject = reject;
    });
    proc.on("error", (err: Error) => {
      exitReject?.(err);
    });
    proc.on("close", (code: number | null) => {
      if (state === "stopped") {
        exitResolve?.();
        return;
      }
      if (code === 0 || code === null) exitResolve?.();
      else exitReject?.(new Error(`ffplay exited with code ${String(code)}`));
    });
    return proc;
  }

  async function writeStdin(proc: ChildProcess, chunk: Buffer): Promise<void> {
    const stdin = proc.stdin;
    if (stdin === null || stdin === undefined) throw new Error("ffplay stdin unavailable");
    if (stdin.destroyed) throw new Error("ffplay stdin closed");
    const ok: boolean = stdin.write(chunk);
    if (ok) return;
    await new Promise<void>((resolve, reject) => {
      stdin.once("drain", () => resolve());
      stdin.once("error", (err: Error) => reject(err));
    });
  }

  return {
    async start(_format: { sampleRate: 24000; channels: 1; encoding: "s16le" }): Promise<void> {
      if (state === "running") return;
      if (state === "finished" || state === "stopped") throw new Error("sink already closed");
      ensureStarted();
    },

    async write(chunk: Buffer): Promise<void> {
      if (state === "stopped" || state === "finished") throw new Error("sink closed");
      const proc = ensureStarted();
      await writeStdin(proc, chunk);
    },

    async finish(): Promise<void> {
      if (state === "stopped") return;
      if (state === "finished" && exitPromise !== null) {
        await exitPromise;
        return;
      }
      const proc = ensureStarted();
      state = "finished";
      proc.stdin?.end();
      if (exitPromise !== null) await exitPromise;
    },

    async stop(): Promise<void> {
      if (state === "stopped") return;
      state = "stopped";
      const proc = child;
      child = null;
      try {
        proc?.stdin?.destroy();
      } catch {
        // ignore stdin teardown errors
      }
      if (proc !== null && proc !== undefined && proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
      exitResolve?.();
    },
  };
}
