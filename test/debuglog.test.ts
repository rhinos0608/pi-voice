import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugLog, type DebugFs } from "../src/debuglog.ts";
import { stateDir } from "../src/preferences.ts";

function makeSpy(overrides?: Partial<DebugFs> & { statSize?: number }): { fs: DebugFs; calls: string[]; written: string[] } {
  const calls: string[] = [];
  const written: string[] = [];
  const fs: DebugFs = {
    mkdirSync: () => { calls.push("mkdirSync"); },
    chmodSync: () => { calls.push("chmodSync"); },
    appendFileSync: (_p, d) => { calls.push("appendFileSync"); written.push(d); },
    statSync: () => { calls.push("statSync"); throw Object.assign(new Error("noent"), { code: "ENOENT" }); },
    renameSync: () => { calls.push("renameSync"); },
    ...overrides,
  };
  if (overrides?.statSize !== undefined) {
    const size = overrides.statSize;
    fs.statSync = () => { calls.push("statSync"); return { size }; };
  }
  return { fs, calls, written };
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

describe("createDebugLog", () => {
  it("is disabled by default and makes zero fs calls", () => {
    withEnv("PI_VOICE_DEBUG", undefined, () => {
      const { fs, calls } = makeSpy();
      const log = createDebugLog({ fs });
      assert.equal(log.enabled, false);
      assert.equal(log.path, undefined);
      log.log("evt", { a: 1 });
      assert.deepEqual(calls, []);
    });
  });

  it("enables via PI_VOICE_DEBUG=1 and defaults dir to stateDir()", () => {
    withEnv("PI_VOICE_DEBUG", "1", () => {
      const { fs } = makeSpy();
      const log = createDebugLog({ fs });
      assert.equal(log.enabled, true);
      assert.equal(log.path, join(stateDir(), "debug.jsonl"));
    });
  });

  it("writes JSONL lines with ISO time, event, and data", () => {
    const fixed = new Date("2026-01-02T03:04:05.006Z");
    const { fs, written } = makeSpy();
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", now: () => fixed, fs });
    log.log("wake", { word: "hey-pi" });
    assert.equal(written.length, 1);
    const line = JSON.parse(written[0] as string);
    assert.equal(line.t, "2026-01-02T03:04:05.006Z");
    assert.equal(line.event, "wake");
    assert.equal(line.word, "hey-pi");
  });

  it("redacts sensitive keys recursively, including nested objects and arrays", () => {
    const { fs, written } = makeSpy();
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
    log.log("e", {
      apiKey: "abc123",
      nested: { authToken: "sekret", deep: { password: "pw", ok: "fine" } },
      list: [{ secret: "s1" }, { plain: "keep" }],
      normal: "visible",
    });
    const line = JSON.parse(written[0] as string);
    assert.equal(line.apiKey, "[redacted]");
    assert.equal(line.nested.authToken, "[redacted]");
    assert.equal(line.nested.deep.password, "[redacted]");
    assert.equal(line.nested.deep.ok, "fine");
    assert.equal(line.list[0].secret, "[redacted]");
    assert.equal(line.list[1].plain, "keep");
    assert.equal(line.normal, "visible");
  });

  it("redacts the live ELEVENLABS_API_KEY value wherever it appears", () => {
    withEnv("ELEVENLABS_API_KEY", "live-key-abcdefgh", () => {
      const { fs, written } = makeSpy();
      const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
      log.log("e", { msg: "using live-key-abcdefgh now", nested: { m: "xxlive-key-abcdefghyy" }, arr: ["live-key-abcdefgh"] });
      const line = JSON.parse(written[0] as string);
      assert.equal(line.msg, "using [redacted] now");
      assert.equal(line.nested.m, "xx[redacted]yy");
      assert.equal(line.arr[0], "[redacted]");
    });
  });

  it("redacts the live INWORLD_API_KEY value wherever it appears", () => {
    withEnv("INWORLD_API_KEY", "iw-live-abcdefgh", () => {
      const { fs, written } = makeSpy();
      const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
      log.log("e", { msg: "using iw-live-abcdefgh now", arr: ["iw-live-abcdefgh"] });
      const line = JSON.parse(written[0] as string);
      assert.equal(line.msg, "using [redacted] now");
      assert.equal(line.arr[0], "[redacted]");
    });
  });

  it("redacts Authorization Basic credentials", () => {
    withEnv("ELEVENLABS_API_KEY", undefined, () => {
      withEnv("INWORLD_API_KEY", undefined, () => {
        const { fs, written } = makeSpy();
        const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
        log.log("e", { msg: "header Basic c2VjcmV0LWtleQ== sent", other: "Bearer abc123 stays" });
        const line = JSON.parse(written[0] as string);
        assert.equal(line.msg, "header Basic [redacted] sent");
        assert.equal(line.other, "Bearer abc123 stays");
      });
    });
  });

  it("ignores short ELEVENLABS_API_KEY values", () => {
    withEnv("ELEVENLABS_API_KEY", "short", () => {
      const { fs, written } = makeSpy();
      const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
      log.log("e", { msg: "short stays short" });
      assert.equal(JSON.parse(written[0] as string).msg, "short stays short");
    });
  });

  it("redacts sk_ style tokens", () => {
    const { fs, written } = makeSpy();
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
    log.log("e", { msg: "token sk_abcdefghijklmnop1234 leaked" });
    assert.equal(JSON.parse(written[0] as string).msg, "token [redacted] leaked");
  });

  it("rotates when the file would exceed maxBytes", () => {
    const { fs, calls, written } = makeSpy({ statSize: 100 });
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", maxBytes: 110, fs });
    log.log("e", { msg: "this line is definitely longer than ten bytes" });
    assert.ok(calls.includes("renameSync"));
    assert.equal(written.length, 1);
  });

  it("does not rotate a small file", () => {
    const { fs, calls } = makeSpy({ statSize: 10 });
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", maxBytes: 1_000_000, fs });
    log.log("e", { a: 1 });
    assert.ok(!calls.includes("renameSync"));
  });

  it("uses mode 0600 for the file and 0700 for the dir", () => {
    const modes: Array<{ what: string; mode: number | undefined }> = [];
    const { fs } = makeSpy({
      mkdirSync: (d, o) => { modes.push({ what: `mkdir:${d}`, mode: o?.mode }); },
      appendFileSync: (p, _d, o) => { modes.push({ what: `append:${p}`, mode: o?.mode }); },
    });
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
    log.log("e");
    assert.ok(modes.some((m) => m.what.startsWith("mkdir:") && m.mode === 0o700));
    assert.ok(modes.some((m) => m.what.startsWith("append:") && m.mode === 0o600));
  });

  it("disables itself silently on the first fs error and never throws", () => {
    const { fs, calls } = makeSpy({
      appendFileSync: () => { calls.push("appendFileSync"); throw new Error("disk full"); },
    });
    const log = createDebugLog({ enabled: true, dir: "/tmp/pv-debug", fs });
    log.log("first");
    assert.equal(log.enabled, false);
    const count = calls.length;
    log.log("second");
    assert.equal(calls.length, count);
  });

  it("round-trips through the real fs", () => {
    const dir = mkdtempSync(join(tmpdir(), "pivoice-debug-"));
    try {
      withEnv("ELEVENLABS_API_KEY", undefined, () => {
        const log = createDebugLog({ enabled: true, dir, maxBytes: 60 });
        assert.equal(log.path, join(dir, "debug.jsonl"));
        log.log("one", { n: 1 });
        log.log("two", { n: 2, big: "x".repeat(100) });
        log.log("three", { n: 3 });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
