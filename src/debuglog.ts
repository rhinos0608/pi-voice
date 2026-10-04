import { join } from "node:path";
import nodeFs from "node:fs";
import { stateDir } from "./preferences.ts";

export type DebugLog = {
  readonly enabled: boolean;
  readonly path: string | undefined;
  log(event: string, data?: Record<string, unknown>): void;
};

export type DebugFs = {
  mkdirSync: (dir: string, opts?: { recursive?: boolean; mode?: number }) => void;
  chmodSync: (path: string, mode: number) => void;
  appendFileSync: (path: string, data: string, opts?: { mode?: number }) => void;
  statSync: (path: string) => { size: number };
  renameSync: (oldPath: string, newPath: string) => void;
};

export type DebugLogOptions = {
  enabled?: boolean;
  dir?: string;
  maxBytes?: number;
  now?: () => Date;
  fs?: DebugFs;
};

const SENSITIVE_KEY = /key|token|secret|auth|password/i;
const SK_PATTERN = /\bsk_[A-Za-z0-9]{16,}/g;
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/=_-]{8,}/g;
const REDACTED = "[redacted]";

function redactString(value: string): string {
  let out = value;
  for (const name of ["ELEVENLABS_API_KEY", "INWORLD_API_KEY"] as const) {
    const apiKey = process.env[name];
    if (apiKey !== undefined && apiKey.length >= 8) {
      out = out.split(apiKey).join(REDACTED);
    }
  }
  BASIC_PATTERN.lastIndex = 0;
  out = out.replace(BASIC_PATTERN, "Basic " + REDACTED);
  SK_PATTERN.lastIndex = 0;
  out = out.replace(SK_PATTERN, REDACTED);
  return out;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

export function createDebugLog(opts?: DebugLogOptions): DebugLog {
  const enabledOpt = opts?.enabled ?? process.env["PI_VOICE_DEBUG"] === "1";
  const dir = opts?.dir ?? stateDir();
  const maxBytes = opts?.maxBytes ?? 1_000_000;
  const now = opts?.now ?? (() => new Date());
  const fs: DebugFs = opts?.fs ?? {
    mkdirSync: (d, o) => nodeFs.mkdirSync(d, o),
    chmodSync: (p, m) => nodeFs.chmodSync(p, m),
    appendFileSync: (p, d, o) => nodeFs.appendFileSync(p, d, o),
    statSync: (p) => nodeFs.statSync(p),
    renameSync: (o, n) => nodeFs.renameSync(o, n),
  };
  const path = enabledOpt ? join(dir, "debug.jsonl") : undefined;

  let alive = enabledOpt;
  let dirReady = false;

  function ensureDir(): void {
    if (dirReady) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    dirReady = true;
  }

  function rotateIfNeeded(lineBytes: number): void {
    let size = 0;
    try {
      size = fs.statSync(path as string).size;
    } catch {
      return;
    }
    if (size + lineBytes > maxBytes && size > 0) {
      fs.renameSync(path as string, `${path as string}.1`);
    }
  }

  return {
    get enabled() {
      return alive;
    },
    path,
    log(event: string, data?: Record<string, unknown>): void {
      if (!alive || path === undefined) return;
      try {
        ensureDir();
        const redacted = (redactValue(data ?? {}) as Record<string, unknown>) ?? {};
        const line = `${JSON.stringify({ t: now().toISOString(), event: redactString(event), ...redacted })}\n`;
        rotateIfNeeded(Buffer.byteLength(line, "utf8"));
        fs.appendFileSync(path, line, { mode: 0o600 });
        fs.chmodSync(path, 0o600);
      } catch {
        alive = false;
      }
    },
  };
}
