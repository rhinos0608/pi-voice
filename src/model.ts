import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelPaths } from "./contracts.ts";

export const WAKE_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2";
export const WAKE_MODEL_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
// Pinned 2026-10-01: downloaded the release tarball and ran `shasum -a 256`.
// No upstream digest exists (GitHub release API exposes digest:null).
export const WAKE_MODEL_SHA256 = "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a";
/** Rejects oversized downloads; the archive is ~5 MiB. */
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

const ALLOWLIST = new Set([
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
  "bpe.model",
]);

export type FetchImpl = (url: string, signal: AbortSignal) => Promise<{
  ok: boolean;
  status: number;
  body: AsyncIterable<Uint8Array>;
}>;
export type TarRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

export type ModelDeps = {
  /** Cache root override (default ~/Library/Application Support/pi-voice/models). */
  cacheRoot?: string;
  fetchImpl?: FetchImpl;
  runTar?: TarRunner;
  /** Raw text for the keywords file (default: all lines from assets/keywords.json). */
  keywordsContent?: string;
  maxBytes?: number;
  /** Test-only hash override; production always uses WAKE_MODEL_SHA256. */
  expectedSha256?: string;
  /** Filesystem swap overrides for race tests (default: node:fs/promises). */
  renameImpl?: (oldPath: string, newPath: string) => Promise<void>;
  rmImpl?: (path: string) => Promise<void>;
};

function defaultCacheRoot(): string {
  const home = process.env["HOME"] ?? "";
  return join(home, "Library", "Application Support", "pi-voice", "models");
}

async function defaultFetch(url: string, signal: AbortSignal): Promise<ReturnType<FetchImpl>> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status}`);
  return { ok: res.ok, status: res.status, body: res.body as AsyncIterable<Uint8Array> };
}

function defaultTar(args: string[], cwd: string): Promise<{ stdout: string }> {
  return new Promise((resolveP, rejectP) => {
    execFile("tar", args, { cwd }, (err, stdout) => {
      if (err) rejectP(err);
      else resolveP({ stdout });
    });
  });
}

async function defaultKeywords(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(join(here, "..", "assets", "keywords.json"), "utf8");
  const data = JSON.parse(raw) as { groups: Record<string, { phrase: string; tokens: string }[]> };
  const lines = [...data.groups["hey-pi"], ...data.groups["hi-pi"]].map((e) => e.tokens);
  return `${lines.join("\n")}\n`;
}

function modelDir(cacheRoot: string): string {
  return join(cacheRoot ?? defaultCacheRoot(), WAKE_MODEL_NAME);
}

function toPaths(dir: string): ModelPaths {
  return {
    encoder: join(dir, "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    decoder: join(dir, "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    joiner: join(dir, "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx"),
    tokens: join(dir, "tokens.txt"),
    keywordsFile: join(dir, "keywords.txt"),
  };
}

async function provisioned(dir: string): Promise<boolean> {
  const p = toPaths(dir);
  try {
    await Promise.all([stat(p.encoder), stat(p.decoder), stat(p.joiner), stat(p.tokens), stat(p.keywordsFile)]);
    return true;
  } catch {
    return false;
  }
}

/** True when the cache dir already holds all required model files. */
export async function isWakeModelProvisioned(dir?: string): Promise<boolean> {
  return provisioned(dir ?? modelDir(defaultCacheRoot()));
}

/** Reject tar member names that escape the staging dir. */
export function assertSafeMember(name: string): void {
  if (name.startsWith("/") || name === "" || name.includes("..") || name.includes("\0")) {
    throw new Error(`Unsafe tar member: ${JSON.stringify(name)}`);
  }
}

async function walkNoLinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isSymbolicLink()) throw new Error(`Tar archive contains symlink: ${e.name}`);
    if (e.isDirectory()) await walkNoLinks(full);
    else if (e.isFile()) {
      const st = await stat(full);
      if (st.nlink > 1) throw new Error(`Tar archive contains hardlink: ${e.name}`);
    }
  }
}

/**
 * Provision the wake-word model into the cache. Idempotent: returns
 * immediately when already provisioned. Never downloads during Pi
 * startup — call only from /voice setup or /voice on.
 */
export async function ensureWakeModel(signal: AbortSignal, deps?: ModelDeps): Promise<ModelPaths> {
  const cacheRoot = deps?.cacheRoot ?? defaultCacheRoot();
  const dir = modelDir(cacheRoot);
  if (await provisioned(dir)) return toPaths(dir);

  const fetchImpl = deps?.fetchImpl ?? defaultFetch;
  const runTar = deps?.runTar ?? defaultTar;
  const maxBytes = deps?.maxBytes ?? MAX_ARCHIVE_BYTES;

  const tmpBase = await mkTempDir();
  const cleanup = async (): Promise<void> => {
    await rm(tmpBase, { recursive: true, force: true });
  };
  try {
    if (signal.aborted) throw new Error("Model provisioning aborted.");
    const res = await fetchImpl(WAKE_MODEL_URL, signal);
    const archive = join(tmpBase, "model.tar.bz2");
    const hash = createHash("sha256");
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      if (signal.aborted) throw new Error("Model provisioning aborted.");
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Model archive exceeds ${maxBytes} byte cap; aborting.`);
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    await writeFile(archive, Buffer.concat(chunks));
    const digest = hash.digest("hex");
    if (digest !== (deps?.expectedSha256 ?? WAKE_MODEL_SHA256)) {
      throw new Error(`Model checksum mismatch: got ${digest}; refusing to extract.`);
    }
    const { stdout } = await runTar(["-tf", archive], tmpBase);
    const members = stdout.split("\n").map((s) => s.trim()).filter((s) => s !== "" && s !== "./");
    if (members.length === 0) throw new Error("Model archive lists no members.");
    for (const m of members) assertSafeMember(m);

    const staging = join(tmpBase, "staging");
    await mkdir(staging, { recursive: true });
    await runTar(["-xf", archive, "-C", staging], tmpBase);
    await walkNoLinks(staging);

    // Find allowlisted files anywhere under staging (archive nests one top-level dir).
    const found = new Map<string, string>();
    const hunt = async (root: string): Promise<void> => {
      for (const e of await readdir(root, { withFileTypes: true })) {
        const full = join(root, e.name);
        if (e.isDirectory()) await hunt(full);
        else if (e.isFile() && ALLOWLIST.has(basename(full)) && !found.has(basename(full))) {
          found.set(basename(full), full);
        }
      }
    };
    await hunt(staging);
    for (const name of ALLOWLIST) {
      if (!found.has(name)) throw new Error(`Model archive missing required file: ${name}`);
    }
    const finalStaging = join(tmpBase, "final");
    await mkdir(finalStaging, { recursive: true });
    for (const name of ALLOWLIST) {
      await copyFile(found.get(name) as string, join(finalStaging, name));
    }
    const keywords = deps?.keywordsContent ?? (await defaultKeywords());
    await writeFile(join(finalStaging, "keywords.txt"), keywords.endsWith("\n") ? keywords : `${keywords}\n`);

    await mkdir(dirname(dir), { recursive: true });
    // Race-tolerant swap: move any live dir aside first (never delete-then-install),
    // move staging into place, then remove the backup. If the final rename loses
    // to a concurrent installer with a valid model, accept theirs and clean up ours.
    const renameImpl = deps?.renameImpl ?? rename;
    const rmImpl = deps?.rmImpl ?? ((p: string) => rm(p, { recursive: true, force: true }));
    const backup = `${dir}.backup-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    let movedAside = false;
    try {
      await renameImpl(dir, backup);
      movedAside = true;
    } catch {
      // No live dir (or lost the race to move it); staging rename below decides.
    }
    try {
      await renameImpl(finalStaging, dir);
    } catch (err) {
      if (await provisioned(dir)) {
        await rmImpl(finalStaging).catch(() => undefined);
        if (movedAside) await rmImpl(backup).catch(() => undefined);
        return toPaths(dir);
      }
      if (movedAside) {
        try {
          await renameImpl(backup, dir);
        } catch {
          // Best-effort restore; surface the original failure.
        }
      }
      throw err;
    }
    if (movedAside) await rmImpl(backup).catch(() => undefined);
    await chmod(dir, 0o700);
    return toPaths(dir);
  } finally {
    await cleanup();
  }
}

export const VAD_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
// Pinned 2026-10-03: sha256 of the released silero_vad.onnx (643854 bytes).
export const VAD_MODEL_SHA256 = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";
export const VAD_MODEL_BYTES = 643854;
/** Rejects oversized downloads; the model is ~0.6 MiB. */
export const MAX_VAD_BYTES = 2 * 1024 * 1024;
export const VAD_MODEL_NAME = "silero_vad.onnx";

export const SPEAKER_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
// Pinned 2026-10-04: downloaded the released onnx and ran `shasum -a 256`.
// No upstream digest exists (GitHub release API exposes digest:null).
export const SPEAKER_MODEL_SHA256 = "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b";
export const SPEAKER_MODEL_BYTES = 29596978;
/** Rejects oversized downloads; the model is ~29.6 MiB. */
export const MAX_SPEAKER_BYTES = 64 * 1024 * 1024;
export const SPEAKER_MODEL_NAME = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";

/** Cache path for the single-file 3D-Speaker CAM++ model (same root the other models use). */
export function speakerModelPath(cacheRoot?: string): string {
  return join(cacheRoot ?? defaultCacheRoot(), SPEAKER_MODEL_NAME);
}

/**
 * Sync cached-path probe: returns the speaker model path when a
 * size-valid copy is already on disk, else undefined. Size-only (no
 * hash) so enrollment checks stay cheap; ensureSpeakerModel verifies.
 */
export function speakerModelCachedPath(cacheRoot?: string): string | undefined {
  const dest = speakerModelPath(cacheRoot);
  try {
    if (statSync(dest).size === SPEAKER_MODEL_BYTES) return dest;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Cache path for the single-file Silero VAD model (same root the wake model uses). */
export function vadModelPath(cacheRoot?: string): string {
  return join(cacheRoot ?? defaultCacheRoot(), VAD_MODEL_NAME);
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** True when the cache holds a size- and hash-valid copy of the VAD model. */
export async function isVadModelProvisioned(cacheRoot?: string): Promise<boolean> {
  const dest = vadModelPath(cacheRoot);
  try {
    if ((await stat(dest)).size !== VAD_MODEL_BYTES) return false;
    return (await hashFile(dest)) === VAD_MODEL_SHA256;
  } catch {
    return false;
  }
}

/**
 * Provision the Silero VAD model into the cache. Idempotent: returns
 * immediately when a hash-valid copy is already present. Single-file
 * download (no tar): streams with a size cap, verifies sha256, then
 * moves a temp file into place atomically. Cleans up on failure.
 */
export async function ensureVadModel(signal: AbortSignal, deps?: ModelDeps): Promise<string> {
  const cacheRoot = deps?.cacheRoot ?? defaultCacheRoot();
  const dest = vadModelPath(cacheRoot);
  const expected = deps?.expectedSha256 ?? VAD_MODEL_SHA256;
  try {
    const size = (await stat(dest)).size;
    const sizeOk = deps?.expectedSha256 !== undefined || size === VAD_MODEL_BYTES;
    if (sizeOk && (await hashFile(dest)) === expected) return dest;
  } catch {
    // Missing or invalid; download below.
  }

  const fetchImpl = deps?.fetchImpl ?? defaultFetch;
  const maxBytes = deps?.maxBytes ?? MAX_VAD_BYTES;
  const tmpBase = await mkTempDir();
  try {
    if (signal.aborted) throw new Error("VAD model provisioning aborted.");
    const res = await fetchImpl(VAD_MODEL_URL, signal);
    const hash = createHash("sha256");
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      if (signal.aborted) throw new Error("VAD model provisioning aborted.");
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`VAD model exceeds ${maxBytes} byte cap; aborting.`);
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    const digest = hash.digest("hex");
    if (digest !== expected) throw new Error(`VAD model checksum mismatch: got ${digest}; refusing to install.`);
    if (bytes !== VAD_MODEL_BYTES && deps?.expectedSha256 === undefined) {
      throw new Error(`VAD model size mismatch: got ${bytes} bytes, want ${VAD_MODEL_BYTES}.`);
    }
    const tmp = join(tmpBase, VAD_MODEL_NAME);
    if (signal.aborted) throw new Error("VAD model provisioning aborted.");
    await writeFile(tmp, Buffer.concat(chunks));
    await mkdir(dirname(dest), { recursive: true });
    if (signal.aborted) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new Error("VAD model provisioning aborted.");
    }
    const renameImpl = deps?.renameImpl ?? rename;
    await renameImpl(tmp, dest);
    return dest;
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}

async function mkTempDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "pi-voice-model-"));
}

/** True when the cache holds a size- and hash-valid copy of the speaker model. */
export async function isSpeakerModelProvisioned(cacheRoot?: string): Promise<boolean> {
  const dest = speakerModelPath(cacheRoot);
  try {
    if ((await stat(dest)).size !== SPEAKER_MODEL_BYTES) return false;
    return (await hashFile(dest)) === SPEAKER_MODEL_SHA256;
  } catch {
    return false;
  }
}

/**
 * Provision the 3D-Speaker CAM++ model into the cache. Mirrors
 * ensureVadModel exactly: idempotent on a hash-valid copy, streamed
 * single-file download with a size cap, sha256 verification, temp file
 * + atomic rename, cleanup on failure, abort honored throughout.
 */
export async function ensureSpeakerModel(signal: AbortSignal, deps?: ModelDeps): Promise<string> {
  const cacheRoot = deps?.cacheRoot ?? defaultCacheRoot();
  const dest = speakerModelPath(cacheRoot);
  const expected = deps?.expectedSha256 ?? SPEAKER_MODEL_SHA256;
  try {
    const size = (await stat(dest)).size;
    const sizeOk = deps?.expectedSha256 !== undefined || size === SPEAKER_MODEL_BYTES;
    if (sizeOk && (await hashFile(dest)) === expected) return dest;
  } catch {
    // Missing or invalid; download below.
  }

  const fetchImpl = deps?.fetchImpl ?? defaultFetch;
  const maxBytes = deps?.maxBytes ?? MAX_SPEAKER_BYTES;
  const tmpBase = await mkTempDir();
  try {
    if (signal.aborted) throw new Error("Speaker model provisioning aborted.");
    const res = await fetchImpl(SPEAKER_MODEL_URL, signal);
    const hash = createHash("sha256");
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) {
      if (signal.aborted) throw new Error("Speaker model provisioning aborted.");
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`Speaker model exceeds ${maxBytes} byte cap; aborting.`);
      hash.update(chunk);
      chunks.push(Buffer.from(chunk));
    }
    const digest = hash.digest("hex");
    if (digest !== expected) throw new Error(`Speaker model checksum mismatch: got ${digest}; refusing to install.`);
    if (bytes !== SPEAKER_MODEL_BYTES && deps?.expectedSha256 === undefined) {
      throw new Error(`Speaker model size mismatch: got ${bytes} bytes, want ${SPEAKER_MODEL_BYTES}.`);
    }
    const tmp = join(tmpBase, SPEAKER_MODEL_NAME);
    if (signal.aborted) throw new Error("Speaker model provisioning aborted.");
    await writeFile(tmp, Buffer.concat(chunks));
    await mkdir(dirname(dest), { recursive: true });
    if (signal.aborted) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new Error("Speaker model provisioning aborted.");
    }
    const renameImpl = deps?.renameImpl ?? rename;
    await renameImpl(tmp, dest);
    return dest;
  } finally {
    await rm(tmpBase, { recursive: true, force: true });
  }
}

// Re-export for tests that stub module-level tar errors.
export const __testOnly = { ALLOWLIST, assertSafeMember };
