import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ensureWakeModel, isWakeModelProvisioned, WAKE_MODEL_SHA256, assertSafeMember } from "../src/model.ts";

const FILES = [
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
  "bpe.model",
];
const MODEL_DIR_NAME = "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01";
const MEMBERS = FILES.map((f) => `${MODEL_DIR_NAME}/${f}`);
const KEYWORDS = "▁HE Y ▁PI @HEY PI\n▁HI ▁PI @HI PI\n";
const PAYLOAD = new TextEncoder().encode("fake-archive-bytes");
const PAYLOAD_SHA = createHash("sha256").update(PAYLOAD).digest("hex");

function fakeFetch(): () => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> }> {
  return async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      yield PAYLOAD;
    })(),
  });
}

/** Fake tar: `-tf` lists members; `-xf` materializes files under the -C dir. */
function fakeTar(members: string[], plantSymlink = false): (args: string[], cwd: string) => Promise<{ stdout: string }> {
  return async (args: string[], _cwd: string) => {
    if (args[0] === "-tf") return { stdout: `${members.join("\n")}\n` };
    const cIdx = args.indexOf("-C");
    const staging = args[cIdx + 1] as string;
    await mkdir(staging, { recursive: true });
    for (const m of members) {
      const base = m.split("/").pop() as string;
      if (FILES.includes(base)) writeFileSync(join(staging, base), `fake-${base}`);
    }
    if (plantSymlink) symlinkSync(join(staging, FILES[0] as string), join(staging, "evil-link"));
    return { stdout: "" };
  };
}

function baseDeps(cacheRoot: string, runTar: ReturnType<typeof fakeTar>): Record<string, unknown> {
  return { cacheRoot, fetchImpl: fakeFetch(), runTar, keywordsContent: KEYWORDS, expectedSha256: PAYLOAD_SHA };
}

describe("model", () => {
  it("rejects unsafe tar member names", () => {
    assert.throws(() => assertSafeMember("/abs/path"), /Unsafe tar member/);
    assert.throws(() => assertSafeMember("../evil"), /Unsafe tar member/);
    assert.throws(() => assertSafeMember("a/../../b"), /Unsafe tar member/);
    assertSafeMember("top-dir/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx");
  });

  it("rejects checksum mismatch without extracting", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      await assert.rejects(
        () => ensureWakeModel(new AbortController().signal, {
          cacheRoot,
          fetchImpl: fakeFetch(),
          runTar: fakeTar(MEMBERS),
          keywordsContent: KEYWORDS,
          // No expectedSha256 override: fake bytes fail against the pinned digest.
        }),
        /checksum mismatch/,
      );
      assert.equal(await isWakeModelProvisioned(join(cacheRoot, MODEL_DIR_NAME)), false);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects path traversal members", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      await assert.rejects(
        () => ensureWakeModel(new AbortController().signal, {
          ...baseDeps(cacheRoot, fakeTar(["../evil.onnx", ...MEMBERS])),
        }),
        /Unsafe tar member/,
      );
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlinks in the extracted tree", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      await assert.rejects(
        () => ensureWakeModel(new AbortController().signal, {
          ...baseDeps(cacheRoot, fakeTar(MEMBERS, true)),
        }),
        /symlink/,
      );
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("provisions allowlisted files plus keywords on the happy path", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      const paths = await ensureWakeModel(new AbortController().signal, {
        ...baseDeps(cacheRoot, fakeTar(MEMBERS)),
      });
      for (const p of [paths.encoder, paths.decoder, paths.joiner, paths.tokens, paths.keywordsFile]) {
        assert.ok((await readFile(p, "utf8")).length > 0, p);
      }
      assert.equal(await readFile(paths.keywordsFile, "utf8"), KEYWORDS);
      assert.equal(await isWakeModelProvisioned(join(cacheRoot, MODEL_DIR_NAME)), true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("is idempotent when already provisioned (no fetch)", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      const dir = join(cacheRoot, MODEL_DIR_NAME);
      await mkdir(dir, { recursive: true });
      for (const f of [...FILES, "keywords.txt"]) writeFileSync(join(dir, f), "cached");
      let fetched = false;
      const paths = await ensureWakeModel(new AbortController().signal, {
        cacheRoot,
        fetchImpl: async () => {
          fetched = true;
          throw new Error("must not fetch");
        },
        keywordsContent: KEYWORDS,
      });
      assert.equal(fetched, false);
      assert.ok(paths.encoder.endsWith(".int8.onnx"));
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("pins the independently computed archive digest", () => {
    assert.equal(WAKE_MODEL_SHA256, "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a");
  });

  it("swaps staging into place without ever deleting the live dir first", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      const dir = join(cacheRoot, MODEL_DIR_NAME);
      await mkdir(dir, { recursive: true });
      writeFileSync(join(dir, "stale-partial.bin"), "old");
      const renames: string[] = [];
      const { rename: fsRename } = await import("node:fs/promises");
      await ensureWakeModel(new AbortController().signal, {
        ...baseDeps(cacheRoot, fakeTar(MEMBERS)),
        renameImpl: async (a: string, b: string) => {
          renames.push(`rename ${a} -> ${b}`);
          await fsRename(a, b);
        },
      });
      assert.ok(renames.some((s) => s.includes(".backup-")), "live dir moved aside, not deleted");
      assert.ok(!renames.some((s) => s.includes("force-delete")));
      assert.equal(existsSync(join(dir, "stale-partial.bin")), false);
      for (const f of [...FILES, "keywords.txt"]) assert.equal(existsSync(join(dir, f)), true, f);
      assert.equal(await isWakeModelProvisioned(dir), true);
      const names = await (await import("node:fs/promises")).readdir(cacheRoot);
      assert.ok(!names.some((n) => n.includes(".backup-")), "backup removed");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("accepts a concurrent install when the final rename loses the race", async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "pi-voice-model-"));
    try {
      const dir = join(cacheRoot, MODEL_DIR_NAME);
      const { rename: fsRename, mkdir: fsMkdir, rm: fsRm } = await import("node:fs/promises");
      let finalRename = false;
      const paths = await ensureWakeModel(new AbortController().signal, {
        ...baseDeps(cacheRoot, fakeTar(MEMBERS)),
        renameImpl: async (a: string, b: string) => {
          if (!finalRename && a.endsWith("/final") && b === dir) {
            finalRename = true;
            // Simulate the winner: a valid model appears, then our rename fails.
            await fsMkdir(dir, { recursive: true });
            for (const f of [...FILES, "keywords.txt"]) writeFileSync(join(dir, f), "theirs");
            const err = new Error("EEXIST") as NodeJS.ErrnoException;
            err.code = "EEXIST";
            throw err;
          }
          await fsRename(a, b);
        },
        rmImpl: (p: string) => fsRm(p, { recursive: true, force: true }),
      });
      assert.equal(paths.encoder, join(dir, FILES[0] as string));
      assert.equal(await readFile(join(dir, "keywords.txt"), "utf8"), "theirs");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
