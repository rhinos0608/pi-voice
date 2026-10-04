/** Echo-cancelling voice I/O: one helper process for capture + playback. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioSink, AudioSource } from "./contracts.ts";

/** Frame types for the helper stdin control protocol. */
export const PLAY_FRAME = 0x01;
export const FINISH_FRAME = 0x02;
export const STOP_FRAME = 0x03;
export const QUIT_FRAME = 0x04;

export const READY_TIMEOUT_MS = 5000;
export const QUIT_KILL_TIMEOUT_MS = 1000;
export const SINK_STOP_TIMEOUT_MS = 500;

/** Classified helper failure. */
export type VoiceIoErrorCode = "permission" | "device" | "engine" | "exited";

export class VoiceIoError extends Error {
  readonly code: VoiceIoErrorCode;
  constructor(code: VoiceIoErrorCode, message: string) {
    super(message);
    this.name = "VoiceIoError";
    this.code = code;
  }
}

export type VoiceIoExec = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export type EnsureVoiceIoHelperOpts = {
  signal?: AbortSignal;
  cacheDir?: string;
  exec?: VoiceIoExec;
};

function defaultExec(cmd: string, args: string[], opts?: { signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", signal: opts?.signal }, (err, stdout, stderr) => {
      if (err) {
        const tail = `${stderr ?? ""}`.slice(-2000);
        reject(new Error(`${cmd} failed: ${(err as Error).message}${tail ? `: ${tail}` : ""}`));
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}

/** Repo root layout: src/voice-io.ts -> ../native/voice-io.swift. */
export function voiceIoSourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "native", "voice-io.swift");
}

function defaultRoot(): string {
  return join(homedir(), "Library", "Application Support", "pi-voice");
}

function binaryNameFor(source: string | Buffer): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return `voice-io-${digest}`;
}

/**
 * Compile native/voice-io.swift with `xcrun swiftc -O` into
 * <root>/bin/voice-io-<12 hex of sha256(source)>, skipping the compile
 * when that binary already exists. dir mode 0700.
 */
export async function ensureVoiceIoHelper(opts?: EnsureVoiceIoHelperOpts): Promise<string> {
  if (opts?.signal?.aborted) throw new Error("voice-io compile aborted.");
  const run = opts?.exec ?? defaultExec;
  const root = opts?.cacheDir ?? defaultRoot();
  const sourcePath = voiceIoSourcePath();
  let source: Buffer;
  try {
    source = await readFile(sourcePath);
  } catch (err) {
    throw new Error(`voice-io source missing at ${sourcePath}: ${(err as Error).message}`);
  }
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  await chmod(binDir, 0o700);
  const bin = join(binDir, binaryNameFor(source));
  try {
    await stat(bin);
    return bin;
  } catch {
    // Not compiled yet; fall through.
  }
  let result: { stdout: string; stderr: string };
  try {
    result = await run("xcrun", ["swiftc", "-O", "-o", bin, sourcePath], { signal: opts?.signal });
  } catch (err) {
    const msg = (err as Error).message;
    if (/ENOENT|not found|missing/i.test(msg)) {
      throw new Error("voice-io compile failed: xcrun/swiftc not found (macOS Xcode command line tools required).");
    }
    throw new Error(`voice-io compile failed: ${msg.slice(-2000)}`);
  }
  void result;
  try {
    await stat(bin);
  } catch {
    throw new Error("voice-io compile failed: swiftc produced no binary.");
  }
  return bin;
}

/** Return the existing compiled helper path without compiling. */
export function voiceIoHelperPath(cacheDir?: string): string | undefined {
  const root = cacheDir ?? defaultRoot();
  let source: Buffer;
  try {
    source = readFileSync(voiceIoSourcePath());
  } catch {
    return undefined;
  }
  const bin = join(root, "bin", binaryNameFor(source));
  try {
    if (existsSync(bin)) return bin;
  } catch {
    return undefined;
  }
  return undefined;
}

export type CreateVoiceIoOpts = {
  helperPath: string;
  input?: string;
  voiceProcessing?: boolean;
  spawnImpl?: typeof spawn;
  log?: (event: string, data?: unknown) => void;
};

export type VoiceIoHandle = {
  source: AudioSource;
  createSink(): AudioSink;
  close(): Promise<void>;
};

function encodeFrame(type: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32LE(body.length, 1);
  return Buffer.concat([header, body]);
}

/**
 * Create a shared-helper voice I/O handle. One child process serves the
 * source and all sinks; refs keep it alive (source: start->stop, sinks:
 * start->finish/stop). Spawns on first ref, QUIT + SIGKILL after 1 s
 * when refs reach 0.
 */
export function createVoiceIo(opts: CreateVoiceIoOpts): VoiceIoHandle {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const log = opts.log;
  const voiceProcessing = opts.voiceProcessing ?? true;

  let child: ChildProcess | undefined;
  // Previous proc after refs hit 0: sent QUIT, awaiting exit. Never reused.
  let retiring: ChildProcess | undefined;
  let refs = 0;
  let ready = false;
  let readyError: VoiceIoError | undefined;
  let exited = false;
  let exitCode: string | undefined;
  let readyWaiters: { resolve: (rate: number) => void; reject: (err: Error) => void }[] = [];
  let drainWaiters: (() => void)[] = [];
  let stopWaiters: (() => void)[] = [];
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let fd3Tail = "";
  let stdoutLeftover: Buffer | undefined;
  let sourceOnPcm: ((chunk: Buffer) => void) | undefined;
  let sourceOnError: ((error: Error) => void) | undefined;
  let sourceStarted = false;
  let activeStop: (() => Promise<void>) | undefined;
  let closed = false;

  function helperArgs(): string[] {
    const args = ["--voice-processing", voiceProcessing ? "on" : "off"];
    if (opts.input !== undefined) args.push("--input", opts.input);
    return args;
  }

  /** Unref'd timeout: never holds the event loop open on its own. */
  function later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, ms);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
    return timer;
  }

  function spawnLocked(): void {
    if (child || closed) return;
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    ready = false;
    readyError = undefined;
    exited = false;
    exitCode = undefined;
    fd3Tail = "";
    stdoutLeftover = undefined;
    const proc = spawnImpl(opts.helperPath, helperArgs(), { stdio: ["pipe", "pipe", "pipe", "pipe"] });
    child = proc;
    readyTimer = later(READY_TIMEOUT_MS, () => {
      readyTimer = undefined;
      const err = new VoiceIoError("exited", "voice-io helper did not become ready within 5000 ms");
      for (const w of readyWaiters) w.reject(err);
      readyWaiters = [];
    });

    proc.stdout?.on("data", (data: Buffer) => {
      // A retired proc is never reused; its late output is discarded.
      if (proc !== child || !sourceStarted || !sourceOnPcm) return;
      let buf = stdoutLeftover ? Buffer.concat([stdoutLeftover, data]) : data;
      stdoutLeftover = undefined;
      if (buf.length % 2 === 1) {
        stdoutLeftover = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length > 0) sourceOnPcm(buf);
    });

    const fd3 = (proc.stdio as unknown as { 3?: { on(e: string, fn: (d: Buffer) => void): void } })[3];
    fd3?.on("data", (data: Buffer) => {
      if (proc !== child) return;
      fd3Tail += data.toString("utf8");
      let idx = fd3Tail.indexOf("\n");
      while (idx >= 0) {
        const line = fd3Tail.slice(0, idx).trim();
        fd3Tail = fd3Tail.slice(idx + 1);
        if (line.length > 0) handleEvent(line);
        idx = fd3Tail.indexOf("\n");
      }
    });

    proc.once("error", (err: Error) => {
      if (proc !== child) {
        // Retired proc failing during shutdown; the live generation is unaffected.
        if (proc === retiring) {
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
          retiring = undefined;
        }
        return;
      }
      onProcessFailed(new VoiceIoError("exited", `voice-io helper failed to start: ${err.message}`));
    });
    proc.once("exit", (code: number | null, signal: string | null) => {
      if (proc === retiring) {
        // Shutdown of the retired generation; the live proc (if any) is unaffected.
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        retiring = undefined;
        return;
      }
      exited = true;
      exitCode = `code ${code ?? "unknown"}, signal ${signal ?? "none"}`;
      if (readyTimer !== undefined) {
        clearTimeout(readyTimer);
        readyTimer = undefined;
      }
      const err = new VoiceIoError("exited", `voice-io helper exited (${exitCode})`);
      for (const w of readyWaiters) w.reject(err);
      readyWaiters = [];
      for (const w of drainWaiters) w();
      drainWaiters = [];
      for (const w of stopWaiters) w();
      stopWaiters = [];
      child = undefined;
      if (sourceStarted && sourceOnError) {
        sourceStarted = false;
        const cb = sourceOnError;
        sourceOnPcm = undefined;
        sourceOnError = undefined;
        cb(err);
      }
    });
  }

  function handleEvent(line: string): void {
    let msg: { event?: string; code?: string; message?: string; inputSampleRate?: number; voiceProcessing?: boolean };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    switch (msg.event) {
      case "ready":
        ready = true;
        if (readyTimer !== undefined) {
          clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        for (const w of readyWaiters) w.resolve(msg.inputSampleRate ?? 16000);
        readyWaiters = [];
        log?.("ready", { inputSampleRate: msg.inputSampleRate, voiceProcessing: msg.voiceProcessing });
        break;
      case "drained":
        for (const w of drainWaiters) w();
        drainWaiters = [];
        log?.("drained");
        break;
      case "stopped":
        for (const w of stopWaiters) w();
        stopWaiters = [];
        log?.("stopped");
        break;
      case "route-change":
        log?.("route-change");
        break;
      case "error": {
        const code = (msg.code === "permission" || msg.code === "device" || msg.code === "engine"
          ? msg.code
          : "engine") as VoiceIoErrorCode;
        const err = new VoiceIoError(code, msg.message ?? "voice-io helper error");
        if (readyTimer !== undefined) {
          clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        if (!ready) {
          readyError = err;
          for (const w of readyWaiters) w.reject(err);
          readyWaiters = [];
        } else if (sourceStarted && sourceOnError) {
          sourceOnError(err);
        } else {
          log?.("error", { code, message: err.message });
        }
        break;
      }
      default:
        break;
    }
  }

  function onProcessFailed(err: VoiceIoError): void {
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    for (const w of readyWaiters) w.reject(err);
    readyWaiters = [];
    if (sourceStarted && sourceOnError) {
      sourceStarted = false;
      const cb = sourceOnError;
      sourceOnPcm = undefined;
      sourceOnError = undefined;
      cb(err);
    }
  }

  function acquire(): void {
    refs += 1;
    if (refs === 1 && !closed) spawnLocked();
  }

  function release(): void {
    if (refs <= 0) return;
    refs -= 1;
    if (refs === 0 && child && !closed) {
      // Retire the proc: it already has QUIT in flight and must never be
      // reused, so detach it now. A later acquire() spawns a fresh one.
      const proc = child;
      child = undefined;
      retiring = proc;
      try {
        proc.stdin?.write(encodeFrame(QUIT_FRAME));
      } catch {
        // stdin may already be gone; SIGKILL below still applies
      }
      killTimer = later(QUIT_KILL_TIMEOUT_MS, () => {
        killTimer = undefined;
        if (retiring === proc) retiring = undefined;
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
      });
    }
  }

  function waitReady(): Promise<void> {
    if (ready) return Promise.resolve();
    if (readyError) return Promise.reject(readyError);
    if (exited) return Promise.reject(new VoiceIoError("exited", `voice-io helper exited (${exitCode ?? "unknown"})`));
    return new Promise<void>((resolve, reject) => {
      readyWaiters.push({ resolve: () => resolve(), reject });
    });
  }

  function writeStdin(frame: Buffer): Promise<void> {
    const proc = child;
    if (!proc) throw new Error("voice-io helper not running");
    const stdin = proc.stdin;
    if (!stdin) throw new Error("voice-io helper stdin unavailable");
    const ok = stdin.write(frame);
    if (ok) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      stdin.once("drain", () => resolve());
      stdin.once("error", (err: Error) => reject(err));
    });
  }

  const source: AudioSource = {
    async start(onPcm: (chunk: Buffer) => void, onError: (error: Error) => void): Promise<void> {
      if (sourceStarted) throw new Error("voice-io source already started.");
      acquire();
      sourceOnPcm = onPcm;
      sourceOnError = onError;
      sourceStarted = true;
      stdoutLeftover = undefined;
      try {
        await waitReady();
      } catch (err) {
        sourceStarted = false;
        sourceOnPcm = undefined;
        sourceOnError = undefined;
        release();
        throw err;
      }
    },
    async stop(): Promise<void> {
      if (!sourceStarted) return;
      sourceStarted = false;
      sourceOnPcm = undefined;
      sourceOnError = undefined;
      stdoutLeftover = undefined;
      release();
    },
  };

  function createSink(): AudioSink {
    let started = false;
    let done = false;

    async function stopSelf(): Promise<void> {
      const drained = new Promise<void>((resolve) => {
        const timer = later(SINK_STOP_TIMEOUT_MS, () => {
          stopWaiters = stopWaiters.filter((w) => w !== onStopped);
          resolve();
        });
        function onStopped(): void {
          clearTimeout(timer);
          resolve();
        }
        stopWaiters.push(onStopped);
      });
      try {
        await writeStdin(encodeFrame(STOP_FRAME));
      } catch {
        // helper already gone; the timeout above still releases the ref
      }
      await drained;
      releaseSink();
    }

    function releaseSink(): void {
      if (done) return;
      done = true;
      started = false;
      if (activeStop === stopSelf) activeStop = undefined;
      release();
    }

    return {
      async start(format: { sampleRate: 24000; channels: 1; encoding: "s16le" }): Promise<void> {
        if (format.sampleRate !== 24000 || format.channels !== 1 || format.encoding !== "s16le") {
          throw new Error('voice-io sink accepts only {sampleRate:24000, channels:1, encoding:"s16le"}');
        }
        if (done) throw new Error("voice-io sink closed");
        if (started) return;
        // Only one sink may be active; stop the previous one first.
        if (activeStop !== undefined && activeStop !== stopSelf) await activeStop();
        acquire();
        started = true;
        activeStop = stopSelf;
        try {
          await waitReady();
        } catch (err) {
          releaseSink();
          throw err;
        }
      },
      async write(chunk: Buffer): Promise<void> {
        if (!started || done) throw new Error("voice-io sink not started");
        await writeStdin(encodeFrame(PLAY_FRAME, chunk));
      },
      async finish(): Promise<void> {
        if (!started || done) return;
        // Register BEFORE writing: drained may arrive immediately.
        const sawDrained = new Promise<void>((resolve) => {
          drainWaiters.push(resolve);
        });
        await writeStdin(encodeFrame(FINISH_FRAME));
        await sawDrained;
        releaseSink();
      },
      async stop(): Promise<void> {
        if (!started || done) return;
        await stopSelf();
      },
    };
  }

  async function close(): Promise<void> {
    closed = true;
    activeStop = undefined;
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    const proc = child;
    const old = retiring;
    child = undefined;
    retiring = undefined;
    refs = 0;
    sourceStarted = false;
    sourceOnPcm = undefined;
    sourceOnError = undefined;
    for (const w of drainWaiters) w();
    drainWaiters = [];
    for (const w of stopWaiters) w();
    stopWaiters = [];
    if (old && old !== proc) {
      try {
        old.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    if (!proc) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      proc.once("exit", finish);
      try {
        proc.stdin?.write(encodeFrame(QUIT_FRAME));
      } catch {
        // fall through to kill
      }
      later(QUIT_KILL_TIMEOUT_MS, () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
        later(100, finish);
      });
    });
  }

  return { source, createSink, close };
}

/** Test-only frame helpers. */
export const __testOnly = { encodeFrame, tmpRoot: tmpdir() };
