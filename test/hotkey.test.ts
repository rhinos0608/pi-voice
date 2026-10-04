/** hotkey tests: combo parser, fake-spawn line protocol, real-binary smoke. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import {
  DEFAULT_PUSH_TO_TALK,
  createHotkeyListener,
  ensureHotkeyHelper,
  hotkeyHelperPath,
  parseHotkeyCombo,
} from "../src/hotkey.ts";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    setImmediate(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

function makeSpawn() {
  const calls: { path: string; args: string[] }[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = ((path: string, args: string[]) => {
    calls.push({ path, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as Parameters<typeof createHotkeyListener>[0]["spawn"];
  return { calls, children, spawnImpl };
}

function emitStdout(child: FakeChild, text: string): void {
  child.stdout.emit("data", Buffer.from(text));
}

describe("parseHotkeyCombo", () => {
  it("parses ctrl+option+space", () => {
    const p = parseHotkeyCombo("ctrl+option+space");
    assert.equal(p.keyCode, 49);
    assert.equal(p.modifiers, 0x1000 | 0x0800);
    assert.equal(p.label, "Ctrl+Option+Space");
  });

  it("parses cmd+shift+f19 and accepts modifier aliases", () => {
    const a = parseHotkeyCombo("cmd+shift+f19");
    assert.equal(a.keyCode, 80);
    assert.equal(a.modifiers, 0x0100 | 0x0200);
    const b = parseHotkeyCombo("control+opt+space");
    assert.equal(b.modifiers, 0x1000 | 0x0800);
    const c = parseHotkeyCombo("command+alt+tab");
    assert.equal(c.modifiers, 0x0100 | 0x0800);
    assert.equal(c.keyCode, 48);
  });

  it("accepts a bare F-key", () => {
    const p = parseHotkeyCombo("f8");
    assert.equal(p.keyCode, 100);
    assert.equal(p.modifiers, 0);
  });

  it("parses the default push-to-talk combo", () => {
    assert.equal(DEFAULT_PUSH_TO_TALK, "ctrl+option+space");
    const p = parseHotkeyCombo(DEFAULT_PUSH_TO_TALK);
    assert.equal(p.keyCode, 49);
  });

  it("rejects modifier-only combos", () => {
    assert.throws(() => parseHotkeyCombo("ctrl"), /modifier-only/);
    assert.throws(() => parseHotkeyCombo("ctrl+shift"), /modifier-only/);
    assert.throws(() => parseHotkeyCombo("cmd"), /modifier-only/);
  });

  it("rejects invalid input with clear errors", () => {
    assert.throws(() => parseHotkeyCombo(""), /invalid hotkey/);
    assert.throws(() => parseHotkeyCombo("fn"), /unknown key/);
    assert.throws(() => parseHotkeyCombo("space"), /at least one modifier/);
    assert.throws(() => parseHotkeyCombo("a"), /at least one modifier/);
    assert.throws(() => parseHotkeyCombo("ctrl+ctrl+space"), /duplicate modifier/);
    assert.throws(() => parseHotkeyCombo("ctrl+bogus"), /unknown key/);
    assert.throws(() => parseHotkeyCombo("ctrl+space+a"), /only one key/);
  });

  it("rejects empty tokens in malformed combos", () => {
    assert.throws(() => parseHotkeyCombo("ctrl++space"), /invalid hotkey/);
    assert.throws(() => parseHotkeyCombo("ctrl+space+"), /invalid hotkey/);
    assert.throws(() => parseHotkeyCombo("ctrl+ space"), /invalid hotkey/);
    // The valid combo still parses.
    const p = parseHotkeyCombo("ctrl+option+space");
    assert.equal(p.keyCode, 49);
    assert.equal(p.label, "Ctrl+Option+Space");
  });
});

describe("createHotkeyListener line protocol (fake spawn)", () => {
  it("passes keycode + modifier mask to the helper", () => {
    const { calls, spawnImpl } = makeSpawn();
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => {},
      onUp: () => {},
      onError: () => {},
      spawn: spawnImpl,
    });
    assert.deepEqual(calls[0]?.args, ["--key", "49", "--mods", String(0x1000 | 0x0800)]);
    void l.close();
  });

  it("ready resolves on ready; down/up delivered in order", async () => {
    const { children, spawnImpl } = makeSpawn();
    const downs: number[] = [];
    const ups: number[] = [];
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => downs.push(1),
      onUp: () => ups.push(1),
      onError: () => {},
      spawn: spawnImpl,
    });
    const child = children[0] as FakeChild;
    emitStdout(child, "ready\n");
    await l.ready;
    emitStdout(child, "down\nup\ndown\nup\n");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([downs.length, ups.length], [2, 2]);
    await l.close();
  });

  it("error line before ready rejects ready", async () => {
    const { children, spawnImpl } = makeSpawn();
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => {},
      onUp: () => {},
      onError: () => {},
      spawn: spawnImpl,
    });
    emitStdout(children[0] as FakeChild, "error -9838 combo already taken (-9838)\n");
    await assert.rejects(l.ready, /already taken/);
    await l.close();
  });

  it("early exit before ready rejects ready", async () => {
    const { children, spawnImpl } = makeSpawn();
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => {},
      onUp: () => {},
      onError: () => {},
      spawn: spawnImpl,
    });
    (children[0] as FakeChild).emit("exit", 1, null);
    await assert.rejects(l.ready, /exited before ready/);
    await l.close();
  });

  it("exit after ready reports onError exactly once", async () => {
    const { children, spawnImpl } = makeSpawn();
    const errors: Error[] = [];
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => {},
      onUp: () => {},
      onError: (e) => errors.push(e),
      spawn: spawnImpl,
    });
    const child = children[0] as FakeChild;
    emitStdout(child, "ready\n");
    await l.ready;
    child.emit("exit", 1, null);
    child.emit("exit", 1, null);
    emitStdout(child, "error 1 boom\n");
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    assert.match(errors[0]?.message ?? "", /exited/);
    await l.close();
  });

  it("error line after ready reports onError once across error then exit", async () => {
    const { children, spawnImpl } = makeSpawn();
    const errors: Error[] = [];
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => {},
      onUp: () => {},
      onError: (e) => errors.push(e),
      spawn: spawnImpl,
    });
    const child = children[0] as FakeChild;
    emitStdout(child, "ready\n");
    await l.ready;
    emitStdout(child, "error 1 something failed\n");
    child.emit("exit", 1, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    await l.close();
  });

  it("close resolves when the child already exited, and a second close still resolves", async () => {
    const { children, spawnImpl } = makeSpawn();
    const errors: Error[] = [];
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => {},
      onUp: () => {},
      onError: (e) => errors.push(e),
      spawn: spawnImpl,
    });
    const child = children[0] as FakeChild;
    emitStdout(child, "ready\n");
    await l.ready;
    // Unexpected helper exit before close() is ever called.
    child.emit("exit", 1, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1);
    await l.close();
    await l.close();
    // No kill attempt against an already-exited child.
    assert.deepEqual(child.killed, []);
  });

  it("close is idempotent and ignores late events", async () => {
    const { children, spawnImpl } = makeSpawn();
    let downs = 0;
    let errCount = 0;
    const l = createHotkeyListener({
      helperPath: "/bin/hotkey",
      combo: "ctrl+option+space",
      onDown: () => downs += 1,
      onUp: () => {},
      onError: () => errCount += 1,
      spawn: spawnImpl,
    });
    const child = children[0] as FakeChild;
    emitStdout(child, "ready\n");
    await l.ready;
    // Fake child exits when stdin ends, mirroring the real helper's EOF exit.
    child.stdin.on("end", () => setImmediate(() => child.emit("exit", 0, null)));
    await l.close();
    await l.close();
    emitStdout(child, "down\n");
    child.emit("exit", 1, null);
    await new Promise((r) => setImmediate(r));
    assert.equal(downs, 0);
    assert.equal(errCount, 0);
  });
});

describe("ensureHotkeyHelper", () => {
  it("skips compiling when the hashed binary already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotkey-test-"));
    try {
      let execCalls = 0;
      const bin = await ensureHotkeyHelper({
        cacheDir: dir,
        exec: async (_cmd, args) => {
          execCalls += 1;
          const out = args[args.indexOf("-o") + 1] as string;
          writeFileSync(out, "fake-binary");
          return { stdout: "", stderr: "" };
        },
      });
      assert.equal(execCalls, 1);
      assert.match(bin, /hotkey-[0-9a-f]{12}$/);
      assert.equal(hotkeyHelperPath(dir), bin);
      const again = await ensureHotkeyHelper({
        cacheDir: dir,
        exec: async () => {
          execCalls += 1;
          return { stdout: "", stderr: "" };
        },
      });
      assert.equal(again, bin);
      assert.equal(execCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a clear Error when the compiler fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hotkey-test-"));
    try {
      await assert.rejects(
        ensureHotkeyHelper({
          cacheDir: dir,
          exec: async () => {
            throw new Error("xcrun swiftc failed: boom");
          },
        }),
        /hotkey compile failed/,
      );
      assert.equal(hotkeyHelperPath(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hotkey live helper (real binary)", () => {
  // No key presses are synthesized: doing so requires Accessibility
  // permission, so this smoke test only expects `ready`, then closes and
  // verifies the helper process exited on stdin EOF.
  const live = process.platform === "darwin";

  it("compiles, reports ready on an obscure combo, and exits on close", { skip: !live, timeout: 55000 }, async (t) => {
    let bin: string;
    try {
      bin = await ensureHotkeyHelper();
    } catch (err) {
      t.skip(`helper compile unavailable: ${(err as Error).message}`);
      return;
    }
    const downs: number[] = [];
    const ups: number[] = [];
    const errors: Error[] = [];
    const l = createHotkeyListener({
      helperPath: bin,
      combo: "ctrl+option+cmd+shift+f19",
      onDown: () => downs.push(1),
      onUp: () => ups.push(1),
      onError: (e) => errors.push(e),
    });
    try {
      await l.ready;
    } catch (err) {
      await l.close();
      // Combo already taken by another app: environment conflict, not a failure.
      if (/already taken/.test((err as Error).message)) {
        t.skip("hotkey combo already taken in this environment");
        return;
      }
      throw err;
    }
    await l.close();
    assert.deepEqual([downs.length, ups.length], [0, 0]);
    assert.deepEqual(errors, []);
    // Direct EOF-exit check: the helper must exit promptly when stdin ends.
    await new Promise<void>((resolve, reject) => {
      const proc = realSpawn(bin, ["--key", "80", "--mods", String(0x1000 | 0x0800 | 0x0100 | 0x0200)], {
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcess;
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
      });
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch { /* already gone */ }
        reject(new Error("helper did not print ready"));
      }, 15000);
      const check = setInterval(() => {
        if (out.split("\n").some((line) => line.trim() === "ready")) {
          clearInterval(check);
          clearTimeout(timer);
          proc.stdin?.end();
          const killTimer = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch { /* already gone */ }
          }, 5000);
          proc.once("exit", (code) => {
            clearTimeout(killTimer);
            if (code === 0) resolve();
            else reject(new Error(`helper exit code ${String(code)} after stdin EOF`));
          });
        }
      }, 50);
    });
  });
});
