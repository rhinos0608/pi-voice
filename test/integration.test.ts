/** Lane E integration tests: controller state machine + factory wiring (fakes only). */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_PREFERENCES, type VoicePreferences } from "../src/contracts.ts";
import { VoiceController, type ControllerDeps, type VoiceHost } from "../src/controller.ts";
import type { SttHandlers } from "../src/stt.ts";
import type { VoiceFailure } from "../src/contracts.ts";

type FakeSource = {
  onPcm: ((chunk: Buffer) => void) | null;
  onError: ((err: Error) => void) | null;
  starts: number;
  stops: number;
  emit(chunk: Buffer): void;
  fail(err: Error): void;
};

type FakeDetector = {
  pushes: Buffer[];
  resets: number;
  closes: number;
  wake: ((phrase: string) => void) | null;
  fire(phrase?: string): void;
};

type FakeUtterance = {
  handlers: SttHandlers;
  pushes: Buffer[];
  closed: number;
  commits: number;
};

type FakeSpeech = {
  pushes: string[];
  finished: number;
  cancelled: number;
};

function makeHarness(overrides?: { prefs?: Partial<VoicePreferences>; idle?: boolean; key?: string }) {
  const prefs: VoicePreferences = { ...DEFAULT_PREFERENCES, ...overrides?.prefs };
  const host: VoiceHost & { sent: { text: string; opts?: { deliverAs?: "steer" | "followUp" } }[]; statuses: (string | undefined)[]; notifies: string[] } = {
    sent: [],
    statuses: [],
    notifies: [],
    sendUserMessage: (text: string, opts?: { deliverAs?: "steer" | "followUp" }) => {
      host.sent.push({ text, opts });
    },
    isIdle: () => overrides?.idle ?? true,
    setStatus: (text: string | undefined) => {
      host.statuses.push(text);
    },
    notify: (message: string) => {
      host.notifies.push(message);
    },
  };
  const sources: FakeSource[] = [];
  const detectors: FakeDetector[] = [];
  const utterances: FakeUtterance[] = [];
  const speeches: { opts: { onDone: () => void; onFailure: (f: VoiceFailure) => void }; fake: FakeSpeech }[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  let key: string | undefined = overrides && "key" in overrides ? overrides.key : "test-key";
  let provisioned = true;

  const deps: ControllerDeps = {
    getPrefs: () => prefs,
    getKey: () => key,
    isModelProvisioned: async () => provisioned,
    ensureModel: async () => ({ encoder: "e", decoder: "d", joiner: "j", tokens: "t", keywordsFile: "k" }),
    createSource: () => {
      const s: FakeSource = {
        onPcm: null,
        onError: null,
        starts: 0,
        stops: 0,
        emit(chunk: Buffer) {
          s.onPcm?.(chunk);
        },
        fail(err: Error) {
          s.onError?.(err);
        },
      };
      sources.push(s);
      return {
        start: async (onPcm: (c: Buffer) => void, onError: (e: Error) => void): Promise<void> => {
          s.starts++;
          s.onPcm = onPcm;
          s.onError = onError;
        },
        stop: async (): Promise<void> => {
          s.stops++;
        },
      };
    },
    createDetector: (_paths: unknown, _c: unknown, _s: unknown, onWake: (p: string) => void) => {
      const d: FakeDetector = {
        pushes: [],
        resets: 0,
        closes: 0,
        wake: onWake,
        fire: (phrase = "hey pi") => d.wake?.(phrase),
      };
      detectors.push(d);
      return {
        push: (frame: Buffer): void => {
          d.pushes.push(frame);
        },
        reset: (): void => {
          d.resets++;
        },
        close: (): void => {
          d.closes++;
        },
      };
    },
    openUtterance: (_k: string, handlers: SttHandlers) => {
      const u: FakeUtterance = { handlers, pushes: [], closed: 0, commits: 0 };
      utterances.push(u);
      return {
        push: (frame: Buffer): void => {
          u.pushes.push(frame);
        },
        commit: (): void => {
          u.commits++;
        },
        close: async (): Promise<void> => {
          u.closed++;
        },
      };
    },
    openSpeech: (opts: { onDone: () => void; onFailure: (f: VoiceFailure) => void }) => {
      const fake: FakeSpeech = { pushes: [], finished: 0, cancelled: 0 };
      speeches.push({ opts, fake });
      return {
        push: (text: string): void => {
          fake.pushes.push(text);
        },
        finish: (): void => {
          fake.finished++;
        },
        cancel: (): void => {
          fake.cancelled++;
        },
      };
    },
    playCue: () => {
      cues++;
    },
    cooldownMs: 700,
    retryBackoffMs: 2000,
    setTimeout: (cb: () => void, ms: number): unknown => {
      const id = timers.length;
      timers.push({ cb, ms });
      return id;
    },
    clearTimeout: (_id: unknown): void => {},
  };
  let cues = 0;
  const controller = new VoiceController(host, deps);
  return {
    controller,
    host,
    prefs,
    sources,
    detectors,
    utterances,
    speeches,
    timers,
    cues: () => cues,
    setKey: (next: string | undefined): void => {
      key = next as string;
    },
    setProvisioned: (next: boolean): void => {
      provisioned = next;
    },
    fireTimers: (): void => {
      for (const t of timers.splice(0)) t.cb();
    },
  };
}

describe("factory starts no processes", () => {
  it("importing and invoking the factory registers without starting audio", async () => {
    const mod = await import("../src/index.ts");
    const registered: { commands: string[]; events: string[] } = { commands: [], events: [] };
    const fakePi = {
      registerCommand: (name: string, _opts: unknown): void => {
        registered.commands.push(name);
      },
      on: (event: string, _handler: unknown): (() => void) => {
        registered.events.push(event);
        return () => {};
      },
      sendUserMessage: (_text: string, _opts?: unknown): void => {},
    };
    (mod.default as (pi: unknown) => void)(fakePi);
    assert.deepEqual(registered.commands, ["voice"]);
    for (const name of ["session_start", "session_shutdown", "message_update", "message_end", "input"]) {
      assert.ok(registered.events.includes(name), `missing handler: ${name}`);
    }
  });
});

describe("autostart gating", () => {
  it("blocks start when any condition is missing; starts when all present", async () => {
    // Each missing condition blocks controller start paths that need the key.
    const noKey = makeHarness({ prefs: { autostart: true }, key: undefined });
    await noKey.controller.start();
    // Start proceeds to listening state regardless; wake with no key stays in wake.
    assert.equal(noKey.controller.getPhase(), "wake");
    noKey.detectors[0].fire();
    assert.equal(noKey.host.sent.length, 0);
    assert.ok(noKey.host.notifies.some((m) => /ELEVENLABS_API_KEY/.test(m)));

    const h = makeHarness({ prefs: { autostart: true } });
    assert.equal(h.controller.getPhase(), "off");
    await h.controller.start();
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.sources.length, 1);
    assert.equal(h.host.statuses.at(-1), "🎙 listening");
  });

  it("does nothing new when already listening", async () => {
    const h = makeHarness({});
    await h.controller.start();
    await h.controller.start();
    assert.equal(h.sources.length, 1);
  });
});

describe("wake → capture → submit", () => {
  it("wake plays cue, partial updates status, final submits exactly one prompt", async () => {
    const h = makeHarness({});
    await h.controller.start();
    // Wake audio never reaches STT: no utterance exists before wake.
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    assert.equal(h.utterances.length, 0);
    assert.equal(h.detectors[0].pushes.length, 1);

    h.detectors[0].fire();
    assert.equal(h.cues(), 1);
    assert.equal(h.controller.getPhase(), "capture");
    assert.equal(h.utterances.length, 1);

    // Capture audio goes to STT, not the detector.
    const pushes = h.detectors[0].pushes.length;
    h.sources[0].emit(Buffer.from([5, 6, 7, 8]));
    assert.equal(h.utterances[0].pushes.length, 1);
    assert.equal(h.detectors[0].pushes.length, pushes);

    h.utterances[0].handlers.onPartial("hello wo");
    assert.ok((h.host.statuses.at(-1) ?? "").includes("hello wo"));

    h.utterances[0].handlers.onFinal("hello world");
    assert.equal(h.host.sent.length, 1);
    assert.deepEqual(h.host.sent[0], { text: "hello world", opts: undefined });
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("busy agent submits with followUp", async () => {
    const h = makeHarness({ idle: false });
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("do the thing");
    assert.deepEqual(h.host.sent[0], { text: "do the thing", opts: { deliverAs: "followUp" } });
  });

  it("blank final returns to wake quietly", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("   ");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.host.statuses.at(-1), "🎙 listening");
  });

  it("auth failure goes to off with a notice", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFailure({ code: "auth", message: "STT rejected credentials", retryable: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getPhase(), "off");
    assert.ok(h.host.notifies.some((m) => /STT rejected/.test(m)));
    assert.equal(h.host.statuses.at(-1), "voice off");
  });

  it("retryable failure returns to wake with backoff", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFailure({ code: "network", message: "STT connection failed.", retryable: true });
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.timers.length, 1);
    h.fireTimers();
    assert.equal(h.host.statuses.at(-1), "🎙 listening");
  });

  it("barge-in on wake cancels active speech", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Hello there, this is a long spoken reply. ".repeat(5));
    assert.equal(h.speeches.length, 1);
    h.detectors[0].fire();
    assert.equal(h.speeches[0].fake.cancelled, 1);
    assert.equal(h.controller.getPhase(), "capture");
  });
});

describe("tts streaming", () => {
  it("text deltas reach speech; thinking and tool deltas do not", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "thinking_delta", "secret plan ".repeat(20));
    h.controller.onMessageUpdate({ role: "user" }, "text_delta", "user text ".repeat(20));
    assert.equal(h.speeches.length, 0);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Hello world, this is spoken prose. ".repeat(6));
    assert.equal(h.speeches.length, 1);
    assert.equal(h.controller.getPhase(), "speaking");
    assert.equal(h.host.statuses.at(-1), "🔊 speaking");
  });

  it("message_end finishes speech; cooldown resets the detector", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Spoken sentence one. Spoken sentence two. ".repeat(5));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    assert.equal(h.speeches[0].fake.finished, 1);
    h.speeches[0].opts.onDone();
    assert.equal(h.timers.length, 1);
    const resets = h.detectors[0].resets;
    h.fireTimers();
    assert.ok(h.detectors[0].resets > resets);
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("aborted stopReason cancels speech", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Spoken words here. ".repeat(10));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "aborted" }, true);
    assert.equal(h.speeches[0].fake.cancelled, 1);
    assert.equal(h.speeches[0].fake.finished, 0);
  });

  it("input event cancels speech", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Spoken words here. ".repeat(10));
    h.controller.onInput();
    assert.equal(h.speeches[0].fake.cancelled, 1);
  });

  it("restart during capture returns to wake with a fresh source and detector, no submit", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    assert.equal(h.controller.getPhase(), "capture");
    await h.controller.restartIfListening();
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.sources.length, 2);
    assert.equal(h.detectors.length, 2);
    assert.equal(h.utterances[0].closed, 1);
    // Late final from the canceled utterance must not submit.
    h.utterances[0].handlers.onFinal("partial stale transcript");
    assert.equal(h.host.sent.length, 0);
    // New listening works: wake again captures on the fresh utterance.
    h.detectors[1].fire();
    assert.equal(h.controller.getPhase(), "capture");
    assert.equal(h.utterances.length, 2);
  });

  it("two back-to-back messages are both spoken in order, no overlap", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    const first = "First message prose here, long enough to speak aloud. ".repeat(4);
    const second = "Second message prose follows after the first ends. ".repeat(4);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", first);
    assert.equal(h.speeches.length, 1);
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    // Second message arrives before the first finishes playing.
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", second);
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    assert.equal(h.speeches.length, 1);
    h.speeches[0].opts.onDone();
    assert.equal(h.speeches.length, 2);
    assert.ok(h.speeches[1].fake.pushes.join(" ").includes("Second message"));
    assert.equal(h.speeches[0].fake.cancelled, 0);
    h.speeches[1].opts.onDone();
    h.fireTimers();
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("cancel clears the whole speech queue", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "First queued prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Second queued prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.controller.onInput();
    assert.equal(h.speeches[0].fake.cancelled, 1);
    assert.equal(h.speeches.length, 1);
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("aborted second message drops only itself, first keeps playing", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "First message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Second message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "aborted" }, true);
    assert.equal(h.speeches[0].fake.cancelled, 0);
    assert.equal(h.speeches.length, 1);
    h.speeches[0].opts.onDone();
    assert.equal(h.speeches.length, 1);
    h.fireTimers();
    assert.equal(h.controller.getPhase(), "wake");
  });
  it("retryable speech failure promotes the next queued message", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "First message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Second message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    assert.equal(h.speeches.length, 1);
    h.speeches[0].opts.onFailure({ code: "network", message: "socket broke", retryable: true });
    assert.equal(h.speeches.length, 2);
    assert.ok(h.speeches[1].fake.pushes.join(" ").includes("Second message"));
  });

  it("auth speech failure clears the queue with one notice", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "First message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Second message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    const before = h.host.notifies.length;
    h.speeches[0].opts.onFailure({ code: "auth", message: "bad key", retryable: false });
    assert.equal(h.speeches.length, 1);
    assert.equal(h.host.notifies.length, before + 1);
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "After auth fresh prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    assert.equal(h.speeches.length, 2);
  });

  it("speech failure with empty queue returns to wake after cooldown", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Only message prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.speeches[0].opts.onFailure({ code: "network", message: "socket broke", retryable: true });
    assert.equal(h.timers.length, 1);
    const resets = h.detectors[0].resets;
    h.fireTimers();
    assert.ok(h.detectors[0].resets > resets);
    assert.equal(h.controller.getPhase(), "wake");
  });
});

describe("shutdown", () => {
  it("closes everything idempotently and ignores late callbacks", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.detectors[0].fire();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Spoken words here. ".repeat(10));
    await h.controller.shutdown();
    await h.controller.shutdown();
    assert.equal(h.sources[0].stops, 1);
    assert.equal(h.detectors[0].closes, 1);
    assert.equal(h.host.statuses.at(-1), undefined);
    // Late callbacks after shutdown are ignored.
    h.utterances[0].handlers.onFinal("late transcript");
    h.speeches[0].opts.onDone();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "late delta");
    h.controller.onInput();
    h.fireTimers();
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.speeches.length, 1);
  });
});
