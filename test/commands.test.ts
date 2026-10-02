/** Lane E command tests: parser, completions, persistence, missing-key path. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { VoicePreferences } from "../src/contracts.ts";
import { DEFAULT_PREFERENCES } from "../src/contracts.ts";
import {
  MISSING_KEY_MESSAGE,
  getVoiceCompletions,
  handleVoiceCommand,
  parseVoiceArgs,
  type CommandEnv,
} from "../src/commands.ts";

function makeEnv(overrides?: { prefs?: Partial<VoicePreferences>; key?: string }): {
  env: CommandEnv;
  prefs: VoicePreferences;
  saved: VoicePreferences[];
  notified: { message: string; type?: string }[];
  setKey(next: string | undefined): void;
} {
  const prefs: VoicePreferences = { ...DEFAULT_PREFERENCES, ...overrides?.prefs };
  const saved: VoicePreferences[] = [];
  const notified: { message: string; type?: string }[] = [];
  let key = overrides?.key ?? "test-key";
  const starts: number[] = [];
  const env: CommandEnv = {
    controller: {
      start: async (): Promise<void> => {
        starts.push(1);
      },
      stop: async (): Promise<void> => {},
      cancelSpeech: (): void => {},
      restartIfListening: async (): Promise<void> => {},
    } as unknown as CommandEnv["controller"],
    loadPrefs: async () => ({ prefs }),
    savePrefs: async (next: VoicePreferences): Promise<void> => {
      saved.push(next);
    },
    mutatePrefs: async (fn: (p: VoicePreferences) => void): Promise<VoicePreferences> => {
      fn(prefs);
      saved.push({ ...prefs });
      return prefs;
    },
    getPrefs: () => prefs,
    keyPresent: () => key !== undefined,
    keyLast4: () => (key ? key.slice(-4) : undefined),
    isProvisioned: async () => true,
    ensureModel: async () => ({}),
    hasFfmpeg: async () => true,
    hasFfplay: async () => true,
    listDevices: async () => [{ name: "MacBook Pro Microphone", index: 0 }, { name: "iPhone Microphone", index: 1 }],
    listVoices: async () => [{ id: "voice-abc123", name: "Rachel" }],
    listModels: async () => ["eleven_v4_turbo", "eleven_flash_v2_5"],
    getKey: () => key,
    runTest: async (kind: string) => `${kind} ok`,
  };
  return {
    env,
    prefs,
    saved,
    notified,
    setKey(next: string | undefined): void {
      key = next as string;
    },
  };
}

function ctxFor(notified: { message: string; type?: string }[]): {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
} {
  return {
    notify: (message: string, type?: "info" | "warning" | "error"): void => {
      notified.push({ message, type });
    },
    setStatus: (_key: string, _text: string | undefined): void => {},
  };
}

describe("parser", () => {
  it("defaults empty input to status and parses values", () => {
    assert.deepEqual(parseVoiceArgs(""), { sub: "status" });
    assert.deepEqual(parseVoiceArgs("status"), { sub: "status" });
    assert.deepEqual(parseVoiceArgs("tts on"), { sub: "tts", value: "on" });
    assert.deepEqual(parseVoiceArgs("mic"), { sub: "mic", value: undefined });
    assert.deepEqual(parseVoiceArgs("voice"), { sub: "voice", value: undefined });
    assert.deepEqual(parseVoiceArgs("bogus"), { sub: "help" });
  });
});

describe("completions", () => {
  it("completes subcommands without network", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("t", env);
    assert.ok(items?.some((i) => i.value === "tts"));
    assert.ok(items?.some((i) => i.value === "test"));
  });

  it("inserts quoted device names with spaces", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("mic iP", env);
    assert.ok(items?.some((i) => i.value === '"iPhone Microphone"'), JSON.stringify(items));
    const plain = await getVoiceCompletions("mic ", env);
    assert.ok(plain?.some((i) => i.value === "list"));
    assert.ok(plain?.some((i) => i.value === "default"));
  });

  it("voice completions show names and insert ids", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("voice ra", env);
    assert.equal(items?.length, 1);
    assert.equal(items?.[0].value, "voice-abc123");
    assert.ok(items?.[0].label.includes("Rachel"));
  });

  it("model completions fall back offline without a key", async () => {
    const { env } = makeEnv({ key: undefined });
    const items = await getVoiceCompletions("model eleven_", env);
    assert.ok(items?.some((i) => i.value === "eleven_v4_turbo"));
    assert.ok(items?.some((i) => i.value === "eleven_flash_v2_5"));
  });

  it("never fetches voices while completing other subcommands", async () => {
    const { env } = makeEnv();
    let fetched = false;
    const probe = {
      ...env,
      listVoices: async (): Promise<never> => {
        fetched = true;
        throw new Error("must not fetch");
      },
    };
    await getVoiceCompletions("mic ", probe);
    await getVoiceCompletions("sensitivity h", probe);
    assert.equal(fetched, false);
  });
});

describe("handler", () => {
  it("persists wake, sensitivity, and ttsModel changes", async () => {
    const { env, prefs, saved, notified } = makeEnv();
    const ctx = ctxFor(notified);
    await handleVoiceCommand("wake hey-pi", ctx, env);
    await handleVoiceCommand("sensitivity high", ctx, env);
    await handleVoiceCommand("model eleven_flash_v2_5", ctx, env);
    assert.equal(prefs.wake, "hey-pi");
    assert.equal(prefs.sensitivity, "high");
    assert.equal(prefs.ttsModel, "eleven_flash_v2_5");
    assert.equal(saved.length, 3);
  });

  it("shows the missing-key message for key-dependent actions", async () => {
    const bag = makeEnv({ key: undefined });
    bag.setKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("on", ctx, bag.env);
    await handleVoiceCommand("voice", ctx, bag.env);
    await handleVoiceCommand("tts on", ctx, bag.env);
    assert.ok(bag.notified.length >= 3);
    for (const n of bag.notified) assert.equal(n.message, MISSING_KEY_MESSAGE);
  });

  it("status never shows the full key", async () => {
    const { env, notified } = makeEnv({ key: "sk-secret-1234" });
    await handleVoiceCommand("status", ctxFor(notified), env);
    const text = notified.map((n) => n.message).join("\n");
    assert.ok(!text.includes("sk-secret-1234"));
    assert.ok(text.includes("••••1234"));
  });

  it("mic selection accepts quoted names with spaces", async () => {
    const { env, prefs, notified } = makeEnv();
    await handleVoiceCommand('mic "iPhone Microphone"', ctxFor(notified), env);
    assert.deepEqual(prefs.mic, { kind: "named", name: "iPhone Microphone" });
  });

  it("test tts warns that it is billable", async () => {
    const { env, prefs, notified } = makeEnv();
    prefs.voiceId = "voice-abc123";
    await handleVoiceCommand("test tts", ctxFor(notified), env);
    assert.ok(notified.some((n) => /billable/.test(n.message)));
  });
});
