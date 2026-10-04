import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { AudioSource, MicDevice, VoicePreferences } from "./contracts.ts";

/** Absolute ffmpeg binary used for AVFoundation capture. */
export const FFMPEG_PATH = "/opt/miniconda3/bin/ffmpeg";

/** Short delay between SIGTERM and SIGKILL escalation in stop(). */
export const STOP_KILL_TIMEOUT_MS = 500;

export type ListMicrophonesDeps = {
  ffmpegPath?: string;
  run?: (args: string[]) => Promise<{ stderr: string }>;
};

type ExecError = Error & { stderr?: string | Buffer };

function defaultRun(ffmpegPath: string): (args: string[]) => Promise<{ stderr: string }> {
  return (args) =>
    new Promise((resolve) => {
      execFile(ffmpegPath, args, { encoding: "utf8" }, (err: ExecError | null, _stdout: string, stderr: string) => {
        if (err && typeof err.stderr === "string" && err.stderr.length > 0) resolve({ stderr: err.stderr });
        else resolve({ stderr: stderr ?? "" });
      });
    });
}

/**
 * Parse `ffmpeg -f avfoundation -list_devices` stderr, keeping only
 * entries under the "AVFoundation audio devices" section.
 */
export function parseMicrophoneList(stderr: string): MicDevice[] {
  const devices: MicDevice[] = [];
  let inAudio = false;
  for (const line of stderr.split("\n")) {
    if (line.includes("AVFoundation audio devices")) {
      inAudio = true;
      continue;
    }
    if (line.includes("AVFoundation video devices")) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const match = /\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (match) devices.push({ index: Number(match[1]), name: match[2] ?? "" });
  }
  return devices;
}

/**
 * List AVFoundation audio input devices. ffmpeg exits non-zero for
 * -list_devices; that is expected and the device list still parses.
 */
export async function listMicrophones(deps?: ListMicrophonesDeps): Promise<MicDevice[]> {
  const ffmpegPath = deps?.ffmpegPath ?? FFMPEG_PATH;
  const run = deps?.run ?? defaultRun(ffmpegPath);
  const { stderr } = await run(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  return parseMicrophoneList(stderr);
}

export type AvFoundationSourceDeps = {
  ffmpegPath?: string;
  spawnImpl?: typeof spawn;
  listDeps?: ListMicrophonesDeps;
  /** Called when the saved mic is missing and the default is used instead. */
  onNotice?: (message: string) => void;
  killTimeoutMs?: number;
  /** No stdout data within this long after start trips the stall watchdog. */
  startupTimeoutMs?: number;
  /** Silence after data has flowed trips the stall watchdog. */
  stallMs?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
};

/** AudioSource plus the ffmpeg `-i` value actually used (e.g. ":default" or ":2"). */
export type AvFoundationSource = AudioSource & {
  resolvedInput: string | undefined;
};

/**
 * Wrap a primary AudioSource with a one-way session fallback (voice-isolation
 * helper -> ffmpeg). The first start() failure matching shouldFallback swaps
 * to createFallback() permanently; later starts go straight to the fallback.
 * Non-matching errors (e.g. permission) propagate to existing guidance.
 */
export function withSessionFallback(opts: {
  primary: AudioSource;
  createFallback: () => AudioSource;
  shouldFallback: (err: unknown) => boolean;
  onFallback: () => void;
  onPrimaryStart?: () => void;
}): AudioSource {
  let current = opts.primary;
  let usingPrimary = true;
  return {
    start: async (onPcm: (chunk: Buffer) => void, onError: (error: Error) => void): Promise<void> => {
      try {
        await current.start(onPcm, onError);
        if (usingPrimary) opts.onPrimaryStart?.();
      } catch (err) {
        if (usingPrimary && opts.shouldFallback(err)) {
          usingPrimary = false;
          opts.onFallback();
          current = opts.createFallback();
          await current.start(onPcm, onError);
        } else {
          throw err;
        }
      }
    },
    stop: () => current.stop(),
  };
}

/** Classified microphone failure. All onError paths use this type. */
export type MicErrorCode = "permission" | "stalled" | "exited" | "spawn" | "device";

export class MicError extends Error {
  readonly code: MicErrorCode;
  constructor(code: MicErrorCode, message: string) {
    super(message);
    this.name = "MicError";
    this.code = code;
  }
}

function isPermissionError(stderr: string): boolean {
  return /permission|not permitted|tcc|privacy/i.test(stderr);
}

/**
 * Create an AVFoundation microphone source. On start the saved mic name
 * is re-resolved to its current index; a missing name falls back to the
 * system default input (":default") with an onNotice message, and
 * duplicate names fail asking the user to disambiguate.
 */
export function createAvFoundationSource(
  mic: VoicePreferences["mic"],
  deps?: AvFoundationSourceDeps,
): AvFoundationSource {
  const ffmpegPath = deps?.ffmpegPath ?? FFMPEG_PATH;
  const spawnImpl = deps?.spawnImpl ?? spawn;
  const onNotice = deps?.onNotice;
  const killTimeoutMs = deps?.killTimeoutMs ?? STOP_KILL_TIMEOUT_MS;
  const startupTimeoutMs = deps?.startupTimeoutMs ?? 5000;
  const stallMs = deps?.stallMs ?? 3000;
  const setTimeoutImpl = deps?.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutImpl = deps?.clearTimeoutImpl ?? ((handle: unknown) => clearTimeout(handle as never));

  let child: ChildProcess | undefined;
  let stopped = false;
  let leftover: Buffer | undefined;
  let stderrTail = "";
  let resolvedInput: string | undefined;
  let watchdog: unknown;
  let errored = false;

  function clearWatchdog(): void {
    if (watchdog !== undefined) {
      clearTimeoutImpl(watchdog);
      watchdog = undefined;
    }
  }

  function failStalled(onError: (error: Error) => void, reason: string): void {
    if (errored || stopped) return;
    errored = true;
    clearWatchdog();
    const proc = child;
    child = undefined;
    proc?.removeAllListeners();
    try {
      proc?.kill("SIGKILL");
    } catch {
      // kill failure is secondary; the MicError below carries the failure
    }
    onError(new MicError("stalled", reason));
  }

  async function resolveInput(): Promise<string> {
    if (mic.kind === "default") return ":default";
    const devices = await listMicrophones(deps?.listDeps ?? { ffmpegPath });
    const matches = devices.filter((d) => d.name === mic.name);
    if (matches.length > 1) {
      throw new Error(
        `Multiple microphones named "${mic.name}" found; rename one in Audio MIDI Setup or pick another device.`,
      );
    }
    const found = matches[0];
    if (!found) {
      onNotice?.(`Microphone "${mic.name}" not found; using the system default input instead.`);
      return ":default";
    }
    return `:${found.index}`;
  }

  function permissionError(): MicError {
    return new MicError(
      "permission",
      "Microphone access denied. Grant the terminal app Microphone access in " +
        "System Settings > Privacy & Security > Microphone, then restart.",
    );
  }

  function isDeviceError(text: string): boolean {
    return /no such device|device not found|invalid device|unknown device|cannot.*device|no device/i.test(text);
  }

  function classifyExit(code: number | null, signal: string | null): MicError {
    if (isPermissionError(stderrTail)) return permissionError();
    const tail = stderrTail.trim().slice(-500);
    const suffix = tail ? `: ${tail}` : "";
    if (isDeviceError(stderrTail)) {
      return new MicError("device", `Microphone device unavailable (code ${code ?? "unknown"}, signal ${signal ?? "none"})${suffix}`);
    }
    return new MicError(
      "exited",
      `Microphone process exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})${suffix}`,
    );
  }

  async function start(onPcm: (chunk: Buffer) => void, onError: (error: Error) => void): Promise<void> {
    if (child) throw new Error("Microphone source already started.");
    stopped = false;
    leftover = undefined;
    stderrTail = "";
    resolvedInput = await resolveInput();
    const input = resolvedInput;
    const proc = spawnImpl(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-fflags",
      "nobuffer",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-f",
      "avfoundation",
      "-i",
      input,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      "pipe:1",
    ]);
    child = proc;
    stopped = false;
    errored = false;
    clearWatchdog();
    watchdog = setTimeoutImpl(
      () => failStalled(onError, `Microphone capture stalled: no audio data within ${startupTimeoutMs} ms`),
      startupTimeoutMs,
    );

    proc.stdout?.on("data", (data: Buffer) => {
      clearWatchdog();
      watchdog = setTimeoutImpl(
        () => failStalled(onError, `Microphone capture stalled: no audio data for ${stallMs} ms`),
        stallMs,
      );
      let buf = leftover ? Buffer.concat([leftover, data]) : data;
      leftover = undefined;
      if (buf.length % 2 === 1) {
        leftover = buf.subarray(buf.length - 1);
        buf = buf.subarray(0, buf.length - 1);
      }
      if (buf.length > 0) onPcm(buf);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      stderrTail = `${stderrTail}${data.toString("utf8")}`.slice(-2000);
    });
    proc.once("error", (err: Error) => {
      clearWatchdog();
      if (stopped || proc !== child) return;
      child = undefined;
      if (errored) return;
      errored = true;
      onError(isPermissionError(`${err.message} ${stderrTail}`) ? permissionError() : new MicError("spawn", `Microphone capture failed to start: ${err.message}`));
    });
    proc.once("exit", (code: number | null, signal: string | null) => {
      clearWatchdog();
      if (stopped || proc !== child) return;
      child = undefined;
      if (errored) return;
      errored = true;
      onError(classifyExit(code, signal));
    });
    source.resolvedInput = input;
  }

  async function stop(): Promise<void> {
    const proc = child;
    child = undefined;
    stopped = true;
    clearWatchdog();
    if (!proc) return;
    proc.stdout?.removeAllListeners();
    proc.stderr?.removeAllListeners();
    proc.removeAllListeners();
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
        proc.kill("SIGTERM");
      } catch {
        finish();
        return;
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        setTimeout(finish, 100);
      }, killTimeoutMs);
    });
  }

  const source: AvFoundationSource = {
    start,
    stop,
    resolvedInput,
  };
  return source;
}
