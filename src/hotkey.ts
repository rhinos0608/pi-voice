/** Global push-to-talk key listener via the Carbon hotkey helper. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Default hold-to-talk combo. */
export const DEFAULT_PUSH_TO_TALK = "ctrl+option+space";

// Carbon modifier mask bits (CarbonEvents.h).
const MOD_CTRL = 0x1000;
const MOD_OPTION = 0x0800;
const MOD_CMD = 0x0100;
const MOD_SHIFT = 0x0200;

const MODIFIERS: Record<string, number> = {
  ctrl: MOD_CTRL,
  control: MOD_CTRL,
  option: MOD_OPTION,
  opt: MOD_OPTION,
  alt: MOD_OPTION,
  cmd: MOD_CMD,
  command: MOD_CMD,
  shift: MOD_SHIFT,
};

const MODIFIER_TOKENS = new Set(Object.keys(MODIFIERS));

// macOS virtual keycodes.
const KEYS: Record<string, number> = {
  space: 49,
  return: 36,
  enter: 36,
  tab: 48,
  escape: 53,
  esc: 53,
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38,
  k: 40, l: 37, m: 46, n: 45, o: 31, p: 35, q: 12, r: 15, s: 1,
  t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
  "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
  "6": 22, "7": 26, "8": 28, "9": 25,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98,
  f8: 100, f9: 101, f10: 109, f11: 103, f12: 111, f13: 105,
  f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

const KEY_LABELS: Record<string, string> = {
  space: "Space",
  return: "Return",
  enter: "Return",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
};

function keyLabel(token: string): string {
  const named = KEY_LABELS[token];
  if (named !== undefined) return named;
  if (/^f\d+$/.test(token)) return token.toUpperCase();
  if (/^[a-z0-9]$/.test(token)) return token.toUpperCase();
  return token;
}

function isFunctionKey(token: string): boolean {
  return /^f\d+$/.test(token) && token in KEYS;
}

/**
 * Parse a hotkey combo like "ctrl+option+space" into a Carbon virtual
 * keycode + modifier mask. Throws a clear Error on invalid input.
 * Modifier-only combos (e.g. "ctrl", "ctrl+shift", "fn") are rejected:
 * Carbon cannot register bare modifiers.
 */
export function parseHotkeyCombo(text: string): { keyCode: number; modifiers: number; label: string } {
  const raw = text.trim().toLowerCase();
  if (raw.length === 0) throw new Error(`invalid hotkey combo "${text}": expected e.g. "ctrl+option+space".`);
  const rawParts = raw.split("+");
  for (const part of rawParts) {
    if (part.trim().length === 0 || part !== part.trim()) {
      throw new Error(`invalid hotkey combo "${text}": empty key or modifier — check for a stray "+" or space.`);
    }
  }
  const parts = rawParts.map((p) => p.trim());
  if (parts.length === 0) throw new Error(`invalid hotkey combo "${text}": expected e.g. "ctrl+option+space".`);
  let modifiers = 0;
  const seenMods = new Set<string>();
  let keyToken: string | undefined;
  for (const part of parts) {
    if (MODIFIER_TOKENS.has(part)) {
      const canonical = part === "control" ? "ctrl" : part === "opt" || part === "alt" ? "option" : part === "command" ? "cmd" : part;
      if (seenMods.has(canonical)) throw new Error(`invalid hotkey combo "${text}": duplicate modifier "${part}".`);
      seenMods.add(canonical);
      modifiers |= MODIFIERS[part] ?? 0;
    } else if (part in KEYS) {
      if (keyToken !== undefined) throw new Error(`invalid hotkey combo "${text}": only one key is allowed.`);
      keyToken = part;
    } else {
      throw new Error(
        `invalid hotkey combo "${text}": unknown key "${part}". Modifiers: ctrl, option, cmd, shift; keys: space, a-z, 0-9, f1-f20, return, tab, escape.`,
      );
    }
  }
  if (keyToken === undefined) {
    throw new Error(
      `invalid hotkey combo "${text}": modifier-only combos cannot be registered; add a key, e.g. "ctrl+option+space".`,
    );
  }
  const isF = isFunctionKey(keyToken);
  if (modifiers === 0 && !isF) {
    throw new Error(`invalid hotkey combo "${text}": add at least one modifier (bare keys are only allowed for F-keys).`);
  }
  const order: [string, number, string][] = [
    ["ctrl", MOD_CTRL, "Ctrl"],
    ["option", MOD_OPTION, "Option"],
    ["cmd", MOD_CMD, "Cmd"],
    ["shift", MOD_SHIFT, "Shift"],
  ];
  const labelParts = order.filter(([, bit]) => (modifiers & bit) !== 0).map(([, , name]) => name);
  labelParts.push(keyLabel(keyToken));
  return { keyCode: KEYS[keyToken] as number, modifiers, label: labelParts.join("+") };
}

/** Repo root layout: src/hotkey.ts -> ../native/hotkey.swift. */
export function hotkeySourcePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "native", "hotkey.swift");
}

function defaultRoot(): string {
  return join(homedir(), "Library", "Application Support", "pi-voice");
}

function binaryNameFor(source: string | Buffer): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  return `hotkey-${digest}`;
}

export type HotkeyExec = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

export type EnsureHotkeyHelperOpts = {
  signal?: AbortSignal;
  cacheDir?: string;
  exec?: HotkeyExec;
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

/**
 * Compile native/hotkey.swift with `xcrun swiftc -O` into
 * <root>/bin/hotkey-<12 hex of sha256(source)>, skipping the compile
 * when that binary already exists. dir mode 0700.
 */
export async function ensureHotkeyHelper(opts?: EnsureHotkeyHelperOpts): Promise<string> {
  if (opts?.signal?.aborted) throw new Error("hotkey compile aborted.");
  const run = opts?.exec ?? defaultExec;
  const root = opts?.cacheDir ?? defaultRoot();
  const sourcePath = hotkeySourcePath();
  let source: Buffer;
  try {
    source = await readFile(sourcePath);
  } catch (err) {
    throw new Error(`hotkey source missing at ${sourcePath}: ${(err as Error).message}`);
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
      throw new Error("hotkey compile failed: xcrun/swiftc not found (macOS Xcode command line tools required).");
    }
    throw new Error(`hotkey compile failed: ${msg.slice(-2000)}`);
  }
  void result;
  try {
    await stat(bin);
  } catch {
    throw new Error("hotkey compile failed: swiftc produced no binary.");
  }
  return bin;
}

/** Return the existing compiled helper path without compiling. */
export function hotkeyHelperPath(cacheDir?: string): string | undefined {
  const root = cacheDir ?? defaultRoot();
  let source: Buffer;
  try {
    source = readFileSync(hotkeySourcePath());
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

export type HotkeySpawn = (
  path: string,
  args: string[],
  opts: unknown,
) => ChildProcess;

export type CreateHotkeyListenerOpts = {
  helperPath: string;
  combo: string;
  onDown(): void;
  onUp(): void;
  onError(err: Error): void;
  spawn?: HotkeySpawn;
};

export type HotkeyListener = {
  ready: Promise<void>;
  close(): Promise<void>;
};

const CLOSE_KILL_GRACE_MS = 500;

/**
 * Spawn the hotkey helper for a combo and deliver hold-to-talk events.
 * `ready` resolves on the helper's `ready` line and rejects on an
 * `error` line or an early exit. After ready, unexpected exits and
 * helper errors go to onError exactly once. close() is idempotent;
 * events after close are ignored.
 */
export function createHotkeyListener(opts: CreateHotkeyListenerOpts): HotkeyListener {
  const parsed = parseHotkeyCombo(opts.combo);
  const spawnImpl = (opts.spawn ?? spawn) as HotkeySpawn;
  const onDown = opts.onDown;
  const onUp = opts.onUp;
  const onError = opts.onError;

  let closed = false;
  let settled = false; // ready resolved
  let done = false; // onError delivered or closed cleanly; report once
  let tail = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Avoid unhandled rejection when the caller only watches via onError.
  ready.catch(() => {});

  const proc = spawnImpl(
    opts.helperPath,
    ["--key", String(parsed.keyCode), "--mods", String(parsed.modifiers)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  function reportError(err: Error): void {
    if (done) return;
    done = true;
    try {
      onError(err);
    } catch {
      // Listener callbacks must never throw back into the child handlers.
    }
  }

  function handleLine(line: string): void {
    if (closed) return;
    if (line === "ready") {
      if (!settled) {
        settled = true;
        resolveReady();
      }
      return;
    }
    if (line === "down") {
      if (settled) {
        try {
          onDown();
        } catch {
          // ignore listener errors
        }
      }
      return;
    }
    if (line === "up") {
      if (settled) {
        try {
          onUp();
        } catch {
          // ignore listener errors
        }
      }
      return;
    }
    if (line.startsWith("error")) {
      const detail = line.slice("error".length).trim();
      const err = new Error(detail.length > 0 ? `hotkey helper error: ${detail}` : "hotkey helper error");
      if (!settled) {
        settled = true;
        done = true;
        rejectReady(err);
      } else {
        reportError(err);
      }
    }
  }

  function onData(data: Buffer): void {
    tail += data.toString("utf8");
    let idx = tail.indexOf("\n");
    while (idx >= 0) {
      const line = tail.slice(0, idx).trim();
      tail = tail.slice(idx + 1);
      if (line.length > 0) handleLine(line);
      idx = tail.indexOf("\n");
    }
  }

  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", () => {
    // Helper diagnostics on stderr are informational only.
  });
  proc.once("error", (err: Error) => {
    if (closed) {
      if (!settled) {
        settled = true;
        done = true;
        rejectReady(new Error(`hotkey helper failed to start: ${err.message}`));
      }
      return;
    }
    if (!settled) {
      settled = true;
      done = true;
      rejectReady(new Error(`hotkey helper failed to start: ${err.message}`));
    } else {
      reportError(new Error(`hotkey helper failed: ${err.message}`));
    }
  });
  let childExited = false;
  proc.once("exit", (code: number | null, signal: string | null) => {
    childExited = true;
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (closed) {
      if (!settled) {
        settled = true;
        done = true;
        rejectReady(new Error(`hotkey helper exited before ready (code ${code ?? "unknown"}, signal ${signal ?? "none"})`));
      }
      return;
    }
    if (!settled) {
      settled = true;
      done = true;
      rejectReady(new Error(`hotkey helper exited before ready (code ${code ?? "unknown"}, signal ${signal ?? "none"})`));
    } else {
      reportError(new Error(`hotkey helper exited (code ${code ?? "unknown"}, signal ${signal ?? "none"})`));
    }
  });

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      closed = true;
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      try {
        proc.stdout?.removeListener("data", onData);
      } catch {
        // already gone
      }
      if (childExited) return;
      const exited = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
      });
      try {
        proc.stdin?.end();
      } catch {
        // stdin already gone
      }
      const raced = await Promise.race([
        exited.then(() => true as const),
        new Promise<false>((resolve) => {
          killTimer = setTimeout(() => resolve(false), CLOSE_KILL_GRACE_MS);
          const unref = (killTimer as unknown as { unref?: () => void }).unref;
          if (typeof unref === "function") unref.call(killTimer);
        }),
      ]);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (!raced) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
        await exited;
      }
    })();
    return closePromise;
  }

  return { ready, close };
}
