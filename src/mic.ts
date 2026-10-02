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
};

/** AudioSource plus the ffmpeg `-i` value actually used (e.g. ":default" or ":2"). */
export type AvFoundationSource = AudioSource & {
  resolvedInput: string | undefined;
};

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

  let child: ChildProcess | undefined;
  let stopped = false;
  let leftover: Buffer | undefined;
  let stderrTail = "";
  let resolvedInput: string | undefined;

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

  function permissionError(): Error {
    return new Error(
      "Microphone access denied. Grant the terminal app Microphone access in " +
        "System Settings > Privacy & Security > Microphone, then restart.",
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

    proc.stdout?.on("data", (data: Buffer) => {
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
      if (stopped || proc !== child) return;
      child = undefined;
      onError(isPermissionError(`${err.message} ${stderrTail}`) ? permissionError() : err);
    });
    proc.once("exit", (code: number | null, signal: string | null) => {
      if (stopped || proc !== child) return;
      child = undefined;
      if (isPermissionError(stderrTail)) {
        onError(permissionError());
      } else {
        onError(
          new Error(
            `Microphone process exited (code ${code ?? "unknown"}, signal ${signal ?? "none"}). ${stderrTail.trim()}`.trim(),
          ),
        );
      }
    });
    source.resolvedInput = input;
  }

  async function stop(): Promise<void> {
    const proc = child;
    child = undefined;
    stopped = true;
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
