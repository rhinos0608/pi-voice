import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPreferences, savePreferences, keyStatus, requireApiKey, stateDir } from "../src/preferences.ts";
import { DEFAULT_PREFERENCES } from "../src/contracts.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-voice-prefs-"));
}

describe("preferences", () => {
  it("returns defaults when no state file exists", async () => {
    const { prefs, warning } = await loadPreferences(freshDir());
    assert.deepEqual(prefs, DEFAULT_PREFERENCES);
    assert.equal(warning, undefined);
  });

  it("round-trips saved preferences", async () => {
    const dir = freshDir();
    try {
      await savePreferences({ ...DEFAULT_PREFERENCES, wake: "hey-pi", tts: true }, dir);
      const { prefs, warning } = await loadPreferences(dir);
      assert.equal(prefs.wake, "hey-pi");
      assert.equal(prefs.tts, true);
      assert.equal(warning, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupt JSON", async () => {
    const dir = freshDir();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "state.json"), "{not json");
      const { prefs, warning } = await loadPreferences(dir);
      assert.deepEqual(prefs, DEFAULT_PREFERENCES);
      assert.match(warning ?? "", /corrupt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on unknown version and fills missing fields", async () => {
    const dir = freshDir();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 2, wake: "hey-pi" }));
      const v2 = await loadPreferences(dir);
      assert.deepEqual(v2.prefs, DEFAULT_PREFERENCES);
      assert.match(v2.warning ?? "", /version/);
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1 }));
      const v1 = await loadPreferences(dir);
      assert.deepEqual(v1.prefs, { ...DEFAULT_PREFERENCES, voiceId: undefined });
      assert.equal(v1.warning, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ttsModel defaults and round-trips", async () => {
    const dir = freshDir();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1 }));
      const loaded = await loadPreferences(dir);
      assert.equal(loaded.prefs.ttsModel, "eleven_v4_turbo");
      assert.equal(loaded.warning, undefined);
      await savePreferences({ ...DEFAULT_PREFERENCES, ttsModel: "eleven_flash_v2_5" }, dir);
      const reloaded = await loadPreferences(dir);
      assert.equal(reloaded.prefs.ttsModel, "eleven_flash_v2_5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the prefs dir with mode 0700 and tightens pre-existing broad modes", async () => {
    const { statSync, chmodSync } = await import("node:fs");
    const dir = freshDir();
    try {
      await savePreferences({ ...DEFAULT_PREFERENCES }, dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "state.json")).mode & 0o777, 0o600);
      chmodSync(dir, 0o755);
      await savePreferences({ ...DEFAULT_PREFERENCES }, dir);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects when the prefs dir cannot be made 0700 and writes nothing", async () => {
    const dir = freshDir();
    try {
      const { mkdir, writeFile, rename } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await assert.rejects(
        savePreferences({ ...DEFAULT_PREFERENCES }, dir, {
          chmod: async () => {
            throw new Error("EPERM: chmod denied");
          },
        }),
        /0700/,
      );
      const { readdirSync } = await import("node:fs");
      assert.ok(!readdirSync(dir).includes("state.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sendMode defaults to auto, round-trips review, and falls back on invalid values", async () => {
    const dir = freshDir();
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1 }));
      const missing = await loadPreferences(dir);
      assert.equal(missing.prefs.sendMode, "auto");
      await savePreferences({ ...DEFAULT_PREFERENCES, sendMode: "review" }, dir);
      const reloaded = await loadPreferences(dir);
      assert.equal(reloaded.prefs.sendMode, "review");
      assert.equal(reloaded.warning, undefined);
      writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, sendMode: "bogus" }));
      const invalid = await loadPreferences(dir);
      assert.equal(invalid.prefs.sendMode, "auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stateDir returns the directory containing state.json", () => {
    const dir = freshDir();
    try {
      assert.equal(stateDir(dir), dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keyStatus reports presence and suffix only", () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      assert.deepEqual(keyStatus(), { present: false });
      process.env["ELEVENLABS_API_KEY"] = "sk-test1234";
      assert.deepEqual(keyStatus(), { present: true, last4: "1234" });
    } finally {
      if (prev === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = prev;
    }
  });

  it("requireApiKey throws restart guidance when missing", () => {
    const prev = process.env["ELEVENLABS_API_KEY"];
    try {
      delete process.env["ELEVENLABS_API_KEY"];
      assert.throws(() => requireApiKey(), /Export ELEVENLABS_API_KEY and restart Pi\./);
      process.env["ELEVENLABS_API_KEY"] = "k";
      assert.equal(requireApiKey(), "k");
    } finally {
      if (prev === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = prev;
    }
  });
});
