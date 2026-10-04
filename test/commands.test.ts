/** Lane E command tests: parser, completions, persistence, missing-key path. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { VoicePreferences } from "../src/contracts.ts";
import { DEFAULT_PREFERENCES } from "../src/contracts.ts";
import { LEARN, type SpeakerProfile } from "../src/speaker.ts";
import {
  MISSING_INWORLD_KEY_MESSAGE,
  MISSING_KEY_MESSAGE,
  createSpeakerStore,
  getVoiceCompletions,
  handleVoiceCommand,
  parseVoiceArgs,
  type CommandEnv,
} from "../src/commands.ts";
import { ttsProviderOf } from "../src/preferences.ts";

function makeEnv(overrides?: { prefs?: Partial<VoicePreferences>; key?: string; inworldKey?: string }): {
  env: CommandEnv;
  prefs: VoicePreferences;
  saved: VoicePreferences[];
  notified: { message: string; type?: string }[];
  setKey(next: string | undefined): void;
  setInworldKey(next: string | undefined): void;
} {
  const prefs: VoicePreferences = { ...DEFAULT_PREFERENCES, ...overrides?.prefs };
  const saved: VoicePreferences[] = [];
  const notified: { message: string; type?: string }[] = [];
  let key = overrides?.key ?? "test-key";
  let inworldKey = overrides?.inworldKey ?? "inworld-key";
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
    isVadProvisioned: async () => true,
    ensureVadModel: async () => "/tmp/vad.onnx",
    hasFfmpeg: async () => true,
    hasFfplay: async () => true,
    listDevices: async () => [{ name: "MacBook Pro Microphone", index: 0 }, { name: "iPhone Microphone", index: 1 }],
    listVoices: async () => [{ id: "voice-abc123", name: "Rachel" }],
    listModels: async () => ["eleven_v4_turbo", "eleven_flash_v2_5"],
    getKey: () => key,
    getTtsProvider: () => ttsProviderOf(prefs),
    getInworldKey: () => inworldKey,
    inworldKeyPresent: () => inworldKey !== undefined,
    inworldKeyLast4: () => (inworldKey ? inworldKey.slice(-4) : undefined),
    listInworldVoices: async () => [{ id: "Ashley", name: "Ashley" }],
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
    setInworldKey(next: string | undefined): void {
      inworldKey = next as string;
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
    assert.deepEqual(parseVoiceArgs("list"), { sub: "list", value: undefined });
    assert.deepEqual(parseVoiceArgs("voice-abc123"), { sub: "id", value: "voice-abc123" });
    assert.deepEqual(parseVoiceArgs("id voice-abc123"), { sub: "id", value: "voice-abc123" });
    assert.deepEqual(parseVoiceArgs("voice"), { sub: "id", value: "voice" });
    assert.deepEqual(parseVoiceArgs("bogus"), { sub: "id", value: "bogus" });
    assert.deepEqual(parseVoiceArgs("provider"), { sub: "provider", value: undefined });
    assert.deepEqual(parseVoiceArgs("provider inworld"), { sub: "provider", value: "inworld" });
    assert.deepEqual(parseVoiceArgs("Ashley"), { sub: "id", value: "Ashley" });
  });
});

describe("completions", () => {
  it("completes subcommands without network", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("t", env);
    assert.ok(items?.some((i) => i.value === "tts"));
    assert.ok(items?.some((i) => i.value === "test"));
  });

  // Pi replaces the whole argument text with item.value, so a bare "on"
  // would turn "/voice tts o" into "/voice on".
  it("argument completions keep the typed subcommand", async () => {
    const { env } = makeEnv();
    const partial = await getVoiceCompletions("tts o", env);
    assert.deepEqual(partial?.map((i) => i.value), ["tts on", "tts off"]);
    assert.deepEqual(partial?.map((i) => i.label), ["on", "off"]);
    const empty = await getVoiceCompletions("autostart ", env);
    assert.deepEqual(empty?.map((i) => i.value), ["autostart on", "autostart off"]);
  });

  it("inserts quoted device names with spaces", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("mic iP", env);
    assert.ok(items?.some((i) => i.value === 'mic "iPhone Microphone"'), JSON.stringify(items));
    const plain = await getVoiceCompletions("mic ", env);
    assert.ok(plain?.some((i) => i.value === "mic list"));
    assert.ok(plain?.some((i) => i.value === "mic default"));
  });

  it("voice completions use the elevenlabs list when it is the active provider", async () => {
    const { env } = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    for (const prefix of ["list ra", "id ra"]) {
      const items = await getVoiceCompletions(prefix, env);
      assert.equal(items?.length, 1, prefix);
      assert.equal(items?.[0].value, `${prefix.split(" ")[0]} voice-abc123`);
      assert.ok(items?.[0].label.includes("Rachel"));
    }
  });

  it("voice completions use the inworld list when it is the active provider", async () => {
    const { env } = makeEnv();
    for (const prefix of ["list ash", "id ash"]) {
      const items = await getVoiceCompletions(prefix, env);
      assert.equal(items?.length, 1, prefix);
      assert.equal(items?.[0].value, `${prefix.split(" ")[0]} Ashley`);
      assert.ok(items?.[0].label.includes("Ashley"));
    }
  });

  it("bare partial id completes matching voices for the active provider", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("ash", env);
    assert.ok(items?.some((i) => i.value === "Ashley"), JSON.stringify(items));
    const el = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    const eleven = await getVoiceCompletions("voice-ab", el.env);
    assert.ok(eleven?.some((i) => i.value === "voice-abc123"), JSON.stringify(eleven));
    const bare = await getVoiceCompletions("", env);
    assert.ok(bare?.some((i) => i.value === "provider"), JSON.stringify(bare));
    assert.ok(bare?.some((i) => i.value === "Ashley"), JSON.stringify(bare));
  });

  it("model completions fall back offline without a key (elevenlabs)", async () => {
    const { env } = makeEnv({ prefs: { ttsProvider: "elevenlabs" }, key: undefined });
    const items = await getVoiceCompletions("model eleven_", env);
    assert.ok(items?.some((i) => i.value === "model eleven_flash_v2_5"));
  });

  it("model completions list inworld models without network", async () => {
    const { env } = makeEnv();
    let fetched = false;
    const probe = {
      ...env,
      listInworldVoices: async (): Promise<never> => {
        fetched = true;
        throw new Error("must not fetch");
      },
    };
    const items = await getVoiceCompletions("model ", probe);
    assert.ok(items?.some((i) => i.value === "model inworld-tts-2"), JSON.stringify(items));
    assert.ok(items?.some((i) => i.value === "model inworld-tts-2-flash"), JSON.stringify(items));
    assert.equal(fetched, false);
  });

  it("provider completes inworld|elevenlabs", async () => {
    const { env } = makeEnv();
    const items = await getVoiceCompletions("provider ", env);
    assert.deepEqual(
      items?.map((h) => h.value).sort(),
      ["provider elevenlabs", "provider inworld"],
    );
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

  it("test values include stt and send completes auto|review", async () => {
    const { env } = makeEnv();
    const kinds = await getVoiceCompletions("test ", env);
    assert.deepEqual(
      kinds?.map((h) => h.value).sort(),
      ["test mic", "test speaker", "test stt", "test tts", "test wake"],
    );
    const modes = await getVoiceCompletions("send ", env);
    assert.deepEqual(
      modes?.map((h) => h.value).sort(),
      ["send auto", "send review"],
    );
  });

  it("parses send as a subcommand, not a voice id", () => {
    assert.deepEqual(parseVoiceArgs("send review"), { sub: "send", value: "review" });
    assert.deepEqual(parseVoiceArgs("send"), { sub: "send", value: undefined });
  });
});

describe("handler", () => {
  it("persists wake, sensitivity, and ttsModel changes (elevenlabs)", async () => {
    const { env, prefs, saved, notified } = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    const ctx = ctxFor(notified);
    await handleVoiceCommand("wake hey-pi", ctx, env);
    await handleVoiceCommand("sensitivity high", ctx, env);
    await handleVoiceCommand("model eleven_flash_v2_5", ctx, env);
    assert.equal(prefs.wake, "hey-pi");
    assert.equal(prefs.sensitivity, "high");
    assert.equal(prefs.ttsModel, "eleven_flash_v2_5");
    assert.equal(saved.length, 3);
  });

  it("model selects the inworld model for the inworld provider", async () => {
    const { env, prefs, notified } = makeEnv();
    await handleVoiceCommand("model inworld-tts-2-flash", ctxFor(notified), env);
    assert.equal(prefs.inworldModel, "inworld-tts-2-flash");
    assert.equal(prefs.ttsModel, "eleven_flash_v2_5");
    const ctx = ctxFor(notified);
    await handleVoiceCommand("model", ctx, env);
    assert.ok(notified.some((n) => n.message.includes("inworld-tts-2")));
  });

  it("provider shows the current provider, switches, and rejects junk", async () => {
    const { env, prefs, notified } = makeEnv();
    const ctx = ctxFor(notified);
    await handleVoiceCommand("provider", ctx, env);
    assert.ok(notified.some((n) => n.message === "provider: inworld"));
    await handleVoiceCommand("provider elevenlabs", ctx, env);
    assert.equal(prefs.ttsProvider, "elevenlabs");
    assert.ok(notified.some((n) => n.message === "provider: elevenlabs"));
    await handleVoiceCommand("provider bogus", ctx, env);
    assert.ok(notified.some((n) => /Usage: \/voice provider \[inworld\|elevenlabs\]/.test(n.message)));
    assert.equal(prefs.ttsProvider, "elevenlabs");
  });

  it("list and id act on the active provider", async () => {
    const bag = makeEnv();
    await handleVoiceCommand("list", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => n.message.includes("Ashley")));
    await handleVoiceCommand("Hades", ctxFor(bag.notified), bag.env);
    assert.equal(bag.prefs.inworldVoiceId, "Hades");
    assert.equal(bag.prefs.voiceId, undefined);
    const el = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    await handleVoiceCommand("list", ctxFor(el.notified), el.env);
    assert.ok(el.notified.some((n) => n.message.includes("Rachel")));
    await handleVoiceCommand("voice-abc123", ctxFor(el.notified), el.env);
    assert.equal(el.prefs.voiceId, "voice-abc123");
    assert.equal(el.prefs.inworldVoiceId, undefined);
  });

  it("tts on uses the active provider key and elevenlabs still needs a voice", async () => {
    const el = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    await handleVoiceCommand("tts on", ctxFor(el.notified), el.env);
    assert.ok(el.notified.some((n) => /Select a voice first/.test(n.message)));
    assert.equal(el.prefs.tts, false);
    el.prefs.voiceId = "voice-abc123";
    await handleVoiceCommand("tts on", ctxFor(el.notified), el.env);
    assert.equal(el.prefs.tts, true);
    const iw = makeEnv();
    await handleVoiceCommand("tts on", ctxFor(iw.notified), iw.env);
    assert.equal(iw.prefs.tts, true);
    assert.ok(iw.notified.some((n) => n.message === "tts on"));
  });

  it("shows the elevenlabs missing-key message for key-dependent actions", async () => {
    const bag = makeEnv({ prefs: { ttsProvider: "elevenlabs" }, key: undefined });
    bag.setKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("on", ctx, bag.env);
    await handleVoiceCommand("list", ctx, bag.env);
    await handleVoiceCommand("tts on", ctx, bag.env);
    assert.ok(bag.notified.length >= 3);
    for (const n of bag.notified) assert.equal(n.message, MISSING_KEY_MESSAGE);
  });

  it("shows the inworld missing-key message for inworld tts gating", async () => {
    const bag = makeEnv({ inworldKey: undefined });
    bag.setInworldKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("list", ctx, bag.env);
    await handleVoiceCommand("tts on", ctx, bag.env);
    await handleVoiceCommand("test tts", ctx, bag.env);
    assert.ok(bag.notified.length >= 3);
    for (const n of bag.notified) assert.equal(n.message, MISSING_INWORLD_KEY_MESSAGE);
  });

  it("status never shows full keys and covers provider, voice, model, and both suffixes", async () => {
    const { env, notified } = makeEnv({ key: "sk-secret-1234", inworldKey: "iw-secret-5678" });
    await handleVoiceCommand("status", ctxFor(notified), env);
    const text = notified.map((n) => n.message).join("\n");
    assert.ok(!text.includes("sk-secret-1234"));
    assert.ok(!text.includes("iw-secret-5678"));
    assert.ok(text.includes("provider: inworld"));
    assert.ok(text.includes("voice: Ashley"));
    assert.ok(text.includes("tts model: inworld-tts-2"));
    assert.ok(text.includes("elevenlabs key: present ••••1234"));
    assert.ok(text.includes("inworld key: present ••••5678"));
  });

  it("mic selection accepts quoted names with spaces", async () => {
    const { env, prefs, notified } = makeEnv();
    await handleVoiceCommand('mic "iPhone Microphone"', ctxFor(notified), env);
    assert.deepEqual(prefs.mic, { kind: "named", name: "iPhone Microphone" });
  });

  it("bare id saves the inworld voice without a key", async () => {
    const bag = makeEnv();
    bag.setInworldKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("Ashley", ctx, bag.env);
    assert.equal(bag.prefs.inworldVoiceId, "Ashley");
    assert.equal(bag.saved.length, 1);
    assert.ok(bag.notified.some((n) => n.message === "voice: Ashley"));
  });

  it("bare id saves the elevenlabs voice without a key", async () => {
    const bag = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    bag.setKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("voice-abc123", ctx, bag.env);
    assert.equal(bag.prefs.voiceId, "voice-abc123");
    assert.equal(bag.saved.length, 1);
    assert.ok(bag.notified.some((n) => n.message === "voice: voice-abc123"));
  });

  it("id alias saves the inworld voice without a key", async () => {
    const bag = makeEnv();
    bag.setInworldKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("id Hades", ctx, bag.env);
    assert.equal(bag.prefs.inworldVoiceId, "Hades");
  });

  it("id alias saves the elevenlabs voice without a key", async () => {
    const bag = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    bag.setKey(undefined);
    const ctx = ctxFor(bag.notified);
    await handleVoiceCommand("id voice-abc123", ctx, bag.env);
    assert.equal(bag.prefs.voiceId, "voice-abc123");
  });

  it("test tts warns that it is billable (inworld needs no voice selection)", async () => {
    const { env, notified } = makeEnv();
    await handleVoiceCommand("test tts", ctxFor(notified), env);
    assert.ok(notified.some((n) => /billable/.test(n.message)));
  });

  it("test tts still needs an elevenlabs voice for that provider", async () => {
    const { env, notified } = makeEnv({ prefs: { ttsProvider: "elevenlabs" } });
    await handleVoiceCommand("test tts", ctxFor(notified), env);
    assert.ok(notified.some((n) => /Select a voice first/.test(n.message)));
    assert.ok(!notified.some((n) => /billable/.test(n.message)));
  });

  it("send reports the current mode with no value, sets it, and rejects junk", async () => {
    const { env, prefs, notified } = makeEnv();
    let restarts = 0;
    const origRestart = env.controller.restartIfListening.bind(env.controller);
    env.controller.restartIfListening = async () => {
      restarts++;
      await origRestart();
    };
    await handleVoiceCommand("send", ctxFor(notified), env);
    assert.ok(notified.some((n) => n.message === "send mode: auto"));
    await handleVoiceCommand("send review", ctxFor(notified), env);
    assert.equal(prefs.sendMode, "review");
    assert.ok(notified.some((n) => n.message === "send mode: review"));
    assert.equal(restarts, 1);
    await handleVoiceCommand("send fast", ctxFor(notified), env);
    assert.ok(notified.some((n) => /Usage: \/voice send auto\|review/.test(n.message)));
    assert.equal(prefs.sendMode, "review");
  });

  it("status shows the send mode", async () => {
    const { env, notified } = makeEnv();
    await handleVoiceCommand("status", ctxFor(notified), env);
    assert.ok(notified.some((n) => /send mode: auto/.test(n.message)));
  });

  it("test stt prompts, then reports the transcript", async () => {
    const { env, notified } = makeEnv();
    await handleVoiceCommand("test stt", ctxFor(notified), env);
    assert.ok(notified.some((n) => /stt test: speak now/.test(n.message)));
    assert.ok(notified.some((n) => n.message === "stt ok"));
  });

  it("test stt requires a key and reports failures", async () => {
    const bag = makeEnv({ key: undefined });
    bag.setKey(undefined);
    await handleVoiceCommand("test stt", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => n.message === MISSING_KEY_MESSAGE));
    const failing = makeEnv();
    failing.env.runTest = async () => {
      throw new Error("boom");
    };
    await handleVoiceCommand("test stt", ctxFor(failing.notified), failing.env);
    assert.ok(failing.notified.some((n) => /Test failed: boom/.test(n.message)));
  });

  it("setup provisions the vad model alongside the wake model", async () => {
    const { env, notified } = makeEnv();
    await handleVoiceCommand("setup", ctxFor(notified), env);
    const text = notified.map((n) => n.message).join("\n");
    assert.ok(text.includes("wake model: provisioned"));
    assert.ok(text.includes("vad model: provisioned"));
  });

  it("help lists provider, send, and the review-mode line", async () => {
    const { env, notified } = makeEnv();
    await handleVoiceCommand("help", ctxFor(notified), env);
    const text = notified.map((n) => n.message).join("\n");
    assert.ok(text.includes("/voice provider [inworld|elevenlabs]"));
    assert.ok(text.includes("/voice send auto|review"));
    assert.ok(text.includes('"hey pi, send" also works'));
  });
});

describe("isolation and speaker commands", () => {
  type CaptureResult =
    | { status: "ok"; pcm: Buffer; speechMs: number }
    | { status: "too-short"; speechMs: number }
    | { status: "cancelled" };

  function makeSpokedEnv(
    bag: ReturnType<typeof makeEnv>,
    opts?: {
      profile?: SpeakerProfile | undefined;
      captures?: CaptureResult[];
      captureImpl?: (prompt: string, o: { signal: AbortSignal }) => Promise<CaptureResult>;
      helperBuilt?: boolean;
      fallback?: boolean;
    },
  ): { saved: SpeakerProfile[]; captures: number; deleted: number } {
    let profile: SpeakerProfile | undefined = opts && "profile" in opts ? opts.profile : {
      version: 1,
      model: "/tmp/speaker.onnx",
      dim: 2,
      centroid: [1, 0],
      enrolledAt: "2026-01-02T00:00:00.000Z",
      enrollScores: [0.92, 0.88, 0.9, 0.91, 0.89],
      suggestedThreshold: 0.78,
    };
    const saved: SpeakerProfile[] = [];
    let captures = 0;
    let deleted = 0;
    const queue = [...(opts?.captures ?? [])];
    bag.env.voiceIo = {
      helperBuilt: () => opts?.helperBuilt ?? true,
      isActive: () => false,
      hadFallback: () => opts?.fallback ?? false,
      ensureHelper: async () => "/tmp/voice-io",
    };
    bag.env.speaker = {
      loadProfile: async () => profile,
      saveProfile: async (p) => {
        saved.push(p);
        profile = p;
      },
      deleteProfile: async () => {
        profile = undefined;
        deleted++;
      },
      ensureModel: async () => "/tmp/speaker.onnx",
      modelCachedPath: () => "/tmp/speaker.onnx",
      createEmbedder: () => ({
        embed: () => new Float32Array([1, 0]),
      }),
      buildProfile: (embeddings, model) => ({
        version: 1 as const,
        model,
        dim: 2,
        centroid: [1, 0],
        enrolledAt: "2026-01-02T00:00:00.000Z",
        enrollScores: embeddings.map(() => 0.9),
        suggestedThreshold: 0.78,
      }),
      capturePhrase:
        opts?.captureImpl ??
        (async (): Promise<CaptureResult> => {
          captures++;
          return queue.shift() ?? { status: "ok", pcm: Buffer.from([1, 2, 3, 4]), speechMs: 2000 };
        }),
    };
    return {
      saved,
      get captures(): number {
        return captures;
      },
      get deleted(): number {
        return deleted;
      },
    };
  }

  it("parses the new subcommands", () => {
    assert.deepEqual(parseVoiceArgs("isolation"), { sub: "isolation", value: undefined });
    assert.deepEqual(parseVoiceArgs("isolation off"), { sub: "isolation", value: "off" });
    assert.deepEqual(parseVoiceArgs("enroll"), { sub: "enroll", value: undefined });
    assert.deepEqual(parseVoiceArgs("speaker high"), { sub: "speaker", value: "high" });
    assert.deepEqual(parseVoiceArgs("test speaker"), { sub: "test", value: "speaker" });
  });

  it("completes isolation, speaker, and test speaker", async () => {
    const { env } = makeEnv();
    assert.deepEqual((await getVoiceCompletions("isolation ", env))?.map((h) => h.value).sort(), ["isolation off", "isolation on"]);
    assert.deepEqual((await getVoiceCompletions("speaker ", env))?.map((h) => h.value).sort(), [
      "speaker forget",
      "speaker high",
      "speaker learn off",
      "speaker learn on",
      "speaker low",
      "speaker normal",
      "speaker off",
      "speaker reset-learning",
      "speaker that-was-me",
    ]);
    const roots = (await getVoiceCompletions("e", env))?.map((h) => h.value) ?? [];
    assert.ok(roots.includes("enroll"), "missing enroll");
    const iroots = (await getVoiceCompletions("is", env))?.map((h) => h.value) ?? [];
    assert.ok(iroots.includes("isolation"), "missing isolation");
    const sroots = (await getVoiceCompletions("s", env))?.map((h) => h.value) ?? [];
    for (const sub of ["send", "setup", "speaker", "status", "sensitivity"]) {
      assert.ok(sroots.includes(sub), `missing ${sub}`);
    }
  });

  it("isolation shows helper state and toggles the preference", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag);
    await handleVoiceCommand("isolation", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /isolation: on \(helper built/.test(n.message)));
    await handleVoiceCommand("isolation off", ctxFor(bag.notified), bag.env);
    assert.equal(bag.prefs.isolation, false);
    assert.ok(bag.notified.some((n) => n.message.startsWith("isolation: off")));
    await handleVoiceCommand("isolation maybe", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => n.message === "Usage: /voice isolation on|off"));
  });

  it("speaker shows level, sets strictness, and forgets the profile", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag);
    await handleVoiceCommand("speaker", ctxFor(bag.notified), bag.env);
    assert.ok(
      bag.notified.some((n) =>
        new RegExp(`speaker: normal, learning on, enrolled 2026-01-02.*learned 0/${LEARN.maxLearned}`).test(n.message),
      ),
      JSON.stringify(bag.notified),
    );
    await handleVoiceCommand("speaker high", ctxFor(bag.notified), bag.env);
    assert.equal(bag.prefs.speakerCheck, "high");
    await handleVoiceCommand("speaker forget", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => n.message === "Speaker profile deleted."));
    await handleVoiceCommand("speaker", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /not enrolled/.test(n.message)));
    await handleVoiceCommand("speaker bogus", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => n.message === "Usage: /voice speaker off|low|normal|high|forget|learn on|off|that-was-me|reset-learning"));
  });

  it("enroll guides six phrases, embeds, saves, and reports scores", async () => {
    const bag = makeEnv();
    let starts = 0;
    const origStart = bag.env.controller.start.bind(bag.env.controller);
    bag.env.controller.start = async (): Promise<void> => {
      starts++;
      await origStart();
    };
    const sp = makeSpokedEnv(bag, { profile: undefined });
    await handleVoiceCommand("enroll", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((n) => n.message).join("\n");
    assert.ok(text.includes('Enroll 1/6: read aloud'));
    assert.ok(text.includes('Enroll 6/6: read aloud'));
    assert.equal(sp.saved.length, 1);
    assert.ok(/Enrolled 6 clips. Scores: .* Threshold: suggested 0\.78 \(effective 0\.78 at normal\)\./.test(text));
    assert.ok(/Pairwise clip similarity: mean 1\.00, min 1\.00 \(6 clips\)/.test(text), text);
    assert.equal(starts, 1);
  });

  it("enroll repeats a too-short phrase", async () => {
    const bag = makeEnv();
    let calls = 0;
    makeSpokedEnv(bag, {
      profile: undefined,
      captureImpl: async (): Promise<CaptureResult> => {
        calls++;
        if (calls === 1) return { status: "too-short", speechMs: 400 };
        return { status: "ok", pcm: Buffer.from([5, 6]), speechMs: 2000 };
      },
    });
    await handleVoiceCommand("enroll", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /Too short/.test(n.message)));
    assert.ok(bag.notified.some((n) => /Enrolled 6 clips/.test(n.message)));
    assert.equal(calls, 7);
  });

  it("enroll flags an outlier clip and asks to re-record it", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag, { profile: undefined });
    const tags = ["A", "A", "OUT", "A", "A", "A", "A", "A"];
    let n = 0;
    bag.env.speaker!.capturePhrase = async (): Promise<CaptureResult> => ({
      status: "ok",
      pcm: Buffer.from(tags[n++] ?? "A"),
      speechMs: 3000,
    });
    bag.env.speaker!.createEmbedder = () => ({
      embed: (pcm: Buffer): Float32Array =>
        pcm.toString() === "OUT" ? new Float32Array([0, 1]) : new Float32Array([1, 0]),
    });
    await handleVoiceCommand("enroll", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((m) => m.message).join("\n");
    assert.ok(/re-record/i.test(text), text);
    assert.ok(/mean similarity 0\.00/.test(text), text);
    assert.ok(/Enrolled 6 clips/.test(text), text);
    assert.ok(/Pairwise clip similarity: mean 1\.00, min 1\.00 \(6 clips\)/.test(text), text);
    assert.ok(!/audio path may be degraded/.test(text), text);
    assert.equal(n, 7);
  });

  it("enroll warns when the pairwise mean suggests a degraded audio path", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag, { profile: undefined });
    // Three A clips, then three B clips at cosine 0.38 to A: retries are
    // exhausted on the low clips, and the final mean lands below 0.65.
    const tags = ["A", "A", "A", "B", "B", "B", "B", "B", "B", "B"];
    let n = 0;
    bag.env.speaker!.capturePhrase = async (): Promise<CaptureResult> => ({
      status: "ok",
      pcm: Buffer.from(tags[n++] ?? "A"),
      speechMs: 3000,
    });
    bag.env.speaker!.createEmbedder = () => ({
      embed: (pcm: Buffer): Float32Array =>
        pcm.toString() === "B" ? new Float32Array([0.38, 0.925]) : new Float32Array([1, 0]),
    });
    await handleVoiceCommand("enroll", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((m) => m.message).join("\n");
    assert.ok(/Enrolled 6 clips/.test(text), text);
    assert.ok(/Pairwise clip similarity: mean 0\.63, min 0\.38/.test(text), text);
    assert.ok(/audio path may be degraded/.test(text), text);
    assert.ok(/diag\.mjs/.test(text), text);
    assert.equal(n, 10);
  });

  it("enroll is cancellable with /voice off and does not resume listening", async () => {
    const bag = makeEnv();
    let starts = 0;
    const origStart = bag.env.controller.start.bind(bag.env.controller);
    bag.env.controller.start = async (): Promise<void> => {
      starts++;
      await origStart();
    };
    makeSpokedEnv(bag, {
      profile: undefined,
      captureImpl: (_prompt, { signal }) =>
        new Promise<CaptureResult>((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
        }),
    });
    const startsBefore = starts;
    const pending = handleVoiceCommand("enroll", ctxFor(bag.notified), bag.env);
    await new Promise((resolve) => setImmediate(resolve));
    await handleVoiceCommand("off", ctxFor(bag.notified), bag.env);
    await pending;
    assert.ok(bag.notified.some((n) => /Enrollment cancelled/.test(n.message)));
    assert.equal(starts, startsBefore);
  });

  it("test speaker reports score vs threshold and submits nothing", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag);
    await handleVoiceCommand("test speaker", ctxFor(bag.notified), bag.env);
    assert.ok(
      bag.notified.some((n) => /speaker test: score 1\.00 vs threshold 0\.78 \(normal\) — accept \(nothing submitted, speech 2000 ms\)/.test(n.message)),
    );
  });

  it("test speaker uses the gate scoring (exemplar), not raw centroid cosine", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag, {
      profile: {
        version: 1,
        model: "/tmp/speaker.onnx",
        dim: 2,
        centroid: [1, 0],
        enrolledAt: "2026-01-02T00:00:00.000Z",
        enrollScores: [0.9, 0.9, 0.9, 0.9],
        suggestedThreshold: 0.78,
        anchors: [[0, 1]],
      },
    });
    // Raw cosine to the centroid is 0.00 (reject), but the gate's exemplar
    // term scores 1.00 against the anchor (accept).
    bag.env.speaker!.createEmbedder = () => ({
      embed: () => new Float32Array([0, 1]),
    });
    await handleVoiceCommand("test speaker", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((m) => m.message).join("\n");
    assert.ok(/speaker test: score 1\.00 vs threshold 0\.78 \(normal\) — accept/.test(text), text);
    assert.ok(/speech 2000 ms/.test(text), text);
  });

  it("test speaker is off without a profile", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag, { profile: undefined });
    await handleVoiceCommand("test speaker", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /Speaker check is off/.test(n.message)));
  });

  it("setup reports the helper and speaker model results", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag);
    await handleVoiceCommand("setup", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((n) => n.message).join("\n");
    assert.ok(text.includes("voice isolation helper: built (/tmp/voice-io)"));
    assert.ok(text.includes("speaker model: provisioned"));
  });

  it("status shows isolation and speaker lines", async () => {
    const bag = makeEnv();
    makeSpokedEnv(bag);
    await handleVoiceCommand("status", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((n) => n.message).join("\n");
    assert.ok(text.includes("isolation: on (helper built"));
    assert.ok(text.includes("speaker: normal, learning on, enrolled 2026-01-02"));
    assert.ok(text.includes(`learned 0/${LEARN.maxLearned}`));
  });
});

describe("speaker learning commands", () => {
  function makeLearningEnv(opts?: {
    profile?: SpeakerProfile | undefined;
    candidate?: Float32Array | undefined;
  }): {
    bag: ReturnType<typeof makeEnv>;
    savedProfiles: SpeakerProfile[];
    cleared: () => number;
  } {
    const bag = makeEnv();
    let profile: SpeakerProfile | undefined =
      opts && "profile" in opts
        ? opts.profile
        : {
            version: 1,
            model: "/tmp/speaker.onnx",
            dim: 2,
            centroid: [1, 0],
            enrolledAt: "2026-01-02T00:00:00.000Z",
            enrollScores: [0.92, 0.88, 0.9, 0.91, 0.89],
            suggestedThreshold: 0.78,
            anchors: [[1, 0]],
            learned: [],
          };
    const savedProfiles: SpeakerProfile[] = [];
    let candidate = opts?.candidate;
    let clears = 0;
    Object.assign(bag.env.controller, {
      getSpeakerCorrectionCandidate: (): Float32Array | undefined => candidate,
      clearSpeakerCorrectionCandidate: (): void => {
        candidate = undefined;
        clears++;
      },
    });
    bag.env.speaker = {
      loadProfile: async () => profile,
      saveProfile: async (p) => {
        savedProfiles.push(p);
        profile = p;
      },
      deleteProfile: async () => {
        profile = undefined;
      },
      ensureModel: async () => "/tmp/speaker.onnx",
      modelCachedPath: () => "/tmp/speaker.onnx",
      createEmbedder: () => ({
        embed: () => new Float32Array([1, 0]),
      }),
      buildProfile: (embeddings, model) => ({
        version: 1 as const,
        model,
        dim: 2,
        centroid: [1, 0],
        enrolledAt: "2026-01-02T00:00:00.000Z",
        enrollScores: embeddings.map(() => 0.9),
        suggestedThreshold: 0.78,
      }),
      capturePhrase: async () => ({ status: "ok" as const, pcm: Buffer.from([1, 2, 3, 4]), speechMs: 2000 }),
    };
    return { bag, savedProfiles, cleared: () => clears };
  }

  it("parses speaker learning values", () => {
    assert.deepEqual(parseVoiceArgs("speaker that-was-me"), { sub: "speaker", value: "that-was-me" });
    assert.deepEqual(parseVoiceArgs("speaker learn on"), { sub: "speaker", value: "learn on" });
    assert.deepEqual(parseVoiceArgs("speaker learn off"), { sub: "speaker", value: "learn off" });
    assert.deepEqual(parseVoiceArgs("speaker reset-learning"), { sub: "speaker", value: "reset-learning" });
  });

  it("learn toggles the preference and reports it", async () => {
    const { bag } = makeLearningEnv();
    assert.equal(bag.prefs.speakerLearn, true);
    await handleVoiceCommand("speaker learn", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /speaker learning: on/.test(n.message)));
    await handleVoiceCommand("speaker learn off", ctxFor(bag.notified), bag.env);
    assert.equal(bag.prefs.speakerLearn, false);
    assert.ok(bag.notified.some((n) => /speaker learning: off/.test(n.message)));
    await handleVoiceCommand("speaker learn on", ctxFor(bag.notified), bag.env);
    assert.equal(bag.prefs.speakerLearn, true);
    await handleVoiceCommand("speaker learn maybe", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /Usage: \/voice speaker/.test(n.message)));
    assert.equal(bag.prefs.speakerLearn, true);
  });

  it("that-was-me learns a near rejection and consumes it", async () => {
    const { bag, savedProfiles } = makeLearningEnv({ candidate: new Float32Array([1, 0]) });
    await handleVoiceCommand("speaker that-was-me", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /learned/i.test(n.message)), JSON.stringify(bag.notified));
    assert.equal(savedProfiles.length, 1);
    assert.equal(savedProfiles[0]?.learned?.length, 1);
    await handleVoiceCommand("speaker that-was-me", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /nothing recent/i.test(n.message)));
    assert.equal(savedProfiles.length, 1);
  });

  it("that-was-me rejects a sample too different from enrollment", async () => {
    const { bag, savedProfiles } = makeLearningEnv({ candidate: new Float32Array([-1, 0]) });
    await handleVoiceCommand("speaker that-was-me", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /too different from your enrollment/.test(n.message)));
    assert.equal(savedProfiles.length, 0);
  });

  it("that-was-me reports nothing recent without a rejection", async () => {
    const bag = makeEnv();
    bag.env.speaker = makeLearningEnv().bag.env.speaker;
    await handleVoiceCommand("speaker that-was-me", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /nothing recent/i.test(n.message)));
  });

  it("that-was-me needs an enrolled profile", async () => {
    const { bag, savedProfiles } = makeLearningEnv({ profile: undefined, candidate: new Float32Array([1, 0]) });
    await handleVoiceCommand("speaker that-was-me", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /not enrolled/.test(n.message)));
    assert.equal(savedProfiles.length, 0);
  });

  it("reset-learning clears the bank and saves", async () => {
    const { bag, savedProfiles } = makeLearningEnv();
    bag.env.speaker!.loadProfile = async () => ({
      version: 1 as const,
      model: "/tmp/speaker.onnx",
      dim: 2,
      centroid: [1, 0],
      enrolledAt: "2026-01-02T00:00:00.000Z",
      enrollScores: [0.92, 0.88, 0.9, 0.91, 0.89],
      suggestedThreshold: 0.78,
      anchors: [[1, 0]],
      learned: [{ v: [1, 0], at: "2026-01-03T00:00:00.000Z", score: 0.9 }],
    });
    await handleVoiceCommand("speaker reset-learning", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /cleared 1/.test(n.message)), JSON.stringify(bag.notified));
    assert.equal(savedProfiles.length, 1);
    assert.deepEqual(savedProfiles[0]?.learned, []);
  });

  it("reset-learning needs an enrolled profile", async () => {
    const { bag, savedProfiles } = makeLearningEnv({ profile: undefined });
    await handleVoiceCommand("speaker reset-learning", ctxFor(bag.notified), bag.env);
    assert.ok(bag.notified.some((n) => /not enrolled/.test(n.message)));
    assert.equal(savedProfiles.length, 0);
  });

  it("status shows learning off when disabled", async () => {
    const { bag } = makeLearningEnv();
    bag.prefs.speakerLearn = false;
    await handleVoiceCommand("status", ctxFor(bag.notified), bag.env);
    const text = bag.notified.map((n) => n.message).join("\n");
    assert.ok(text.includes("learning off"), text);
  });

  it("help mentions learning controls", async () => {
    const { env, notified } = makeEnv();
    await handleVoiceCommand("help", ctxFor(notified), env);
    const text = notified.map((n) => n.message).join("\n");
    assert.ok(text.includes("that-was-me"), text);
    assert.ok(text.includes("reset-learning"), text);
    assert.ok(text.includes("learn on|off"), text);
  });
});

describe("speaker profile store (authoritative in-memory profile)", () => {
  function fakeProfile(tag: string): SpeakerProfile {
    const v = Array.from({ length: 4 }, (_, i) => i + tag.length);
    return {
      version: 1,
      dim: 4,
      centroid: v,
      enrollScores: [0.9],
      suggestedThreshold: 0.7,
      enrolledAt: "2026-01-02",
      model: "test-model",
    };
  }

  it("a learning flush persists when nothing intervened", async () => {
    const saved: SpeakerProfile[] = [];
    const store = createSpeakerStore({
      save: async (p) => {
        saved.push(p);
      },
      remove: async () => {},
    });
    const dirty = fakeProfile("dirty");
    store.setCurrent(dirty);
    assert.equal(await store.flushDirty(dirty), true);
    assert.equal(saved.length, 1);
    assert.equal(saved[0], dirty);
  });

  it("forget discards a pending learning flush so no file comes back", async () => {
    const saved: SpeakerProfile[] = [];
    let removed = 0;
    const store = createSpeakerStore({
      save: async (p) => {
        saved.push(p);
      },
      remove: async () => {
        removed++;
      },
    });
    const dirty = fakeProfile("dirty");
    store.setCurrent(dirty);
    await store.clearAndDelete();
    assert.equal(store.get(), undefined);
    assert.equal(removed, 1);
    assert.equal(await store.flushDirty(dirty), false);
    assert.equal(saved.length, 0);
  });

  it("that-was-me and reset-learning win over an older pending flush", async () => {
    const saved: SpeakerProfile[] = [];
    const store = createSpeakerStore({
      save: async (p) => {
        saved.push(p);
      },
      remove: async () => {},
    });
    const stale = fakeProfile("stale");
    store.setCurrent(stale);
    const corrected = fakeProfile("corrected");
    await store.saveAndSet(corrected);
    assert.equal(store.get(), corrected);
    assert.equal(await store.flushDirty(stale), false);
    assert.deepEqual(saved, [corrected]);
  });

  it("a save in flight when forget runs does not resurrect the file (deferred save + forget)", async () => {
    // Fake disk with file + temp staging, mimicking atomic write semantics.
    const files = new Map<string, SpeakerProfile>();
    const temps = new Map<string, SpeakerProfile>();
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveEntered = false;
    const store = createSpeakerStore({
      save: async (p) => {
        temps.set("profile", p);
        saveEntered = true;
        // Stall mid-save so the delete below lands while the save is in flight.
        await saveStarted;
        files.set("profile", p);
        temps.delete("profile");
      },
      remove: async () => {
        files.delete("profile");
        temps.delete("profile.tmp");
        temps.delete("profile");
      },
    });
    const dirty = fakeProfile("dirty");
    store.setCurrent(dirty);
    const flushPromise = store.flushDirty(dirty);
    // Wait until the save is stalled mid-flight.
    while (!saveEntered) await new Promise((r) => setImmediate(r));
    const clearPromise = store.clearAndDelete();
    releaseSave();
    await flushPromise;
    await clearPromise;
    // Let any trailing delete settle.
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(files.has("profile"), false, "resurrected file");
    assert.equal(temps.size, 0, "temp file left behind");
    assert.equal(store.get(), undefined);
  });

  it("a save after forget is a no-op", async () => {
    let saves = 0;
    const store = createSpeakerStore({
      save: async () => {
        saves++;
      },
      remove: async () => {},
    });
    const dirty = fakeProfile("dirty");
    store.setCurrent(dirty);
    await store.clearAndDelete();
    assert.equal(await store.flushDirty(dirty), false);
    assert.equal(saves, 0);
  });

  it("reset-learning/that-was-me ordering lands the latest profile", async () => {
    const saved: SpeakerProfile[] = [];
    const files = new Map<string, SpeakerProfile>();
    const store = createSpeakerStore({
      save: async (p) => {
        saved.push(p);
        files.set("profile", p);
      },
      remove: async () => {
        files.delete("profile");
      },
    });
    const stale = fakeProfile("stale");
    store.setCurrent(stale);
    const latest = fakeProfile("latest-correction");
    await store.saveAndSet(latest);
    assert.equal(await store.flushDirty(stale), false);
    assert.deepEqual(saved, [latest]);
    assert.equal(files.get("profile"), latest);
    assert.equal(store.get(), latest);
  });

  it("forget clears the in-memory profile before deleting the file", async () => {
    const order: string[] = [];
    const store = createSpeakerStore({
      save: async () => {},
      remove: async () => {
        order.push(store.get() === undefined ? "cleared-first" : "still-set");
      },
    });
    store.setCurrent(fakeProfile("x"));
    await store.clearAndDelete();
    assert.deepEqual(order, ["cleared-first"]);
  });
});
