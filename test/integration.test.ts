/** Lane E integration tests: controller state machine + factory wiring (fakes only). */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_PREFERENCES, type VoicePreferences } from "../src/contracts.ts";
import { VoiceController, type ControllerDeps, type VoiceHost } from "../src/controller.ts";
import { MicError } from "../src/mic.ts";
import type { SttEndInfo, SttHandlers } from "../src/stt.ts";
import type { EndpointerEvents } from "../src/vad.ts";
import type { WakeGroup } from "../src/wake.ts";
import type { VoiceFailure } from "../src/contracts.ts";
import type { SpeakerProfile } from "../src/speaker.ts";
import { createSpeakerGate } from "../src/speaker.ts";

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
  includeSend: boolean;
  wake: ((phrase: string, group: WakeGroup | undefined) => void) | null;
  fire: (phrase?: string, group?: WakeGroup | undefined) => void;
};

type FakeEndpointer = {
  events: EndpointerEvents;
  pushes: Buffer[];
  closes: number;
  start: (atSec?: number) => void;
  end: (atSec?: number) => void;
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

function makeHarness(overrides?: { prefs?: Partial<VoicePreferences>; idle?: boolean; key?: string; ttsKey?: string }) {
  const prefs: VoicePreferences = { ...DEFAULT_PREFERENCES, ...overrides?.prefs };
  const host: VoiceHost & { sent: { text: string; opts?: { deliverAs?: "steer" | "followUp" } }[]; statuses: (string | undefined)[]; notifies: string[]; notifyTypes: (string | undefined)[]; editor: string } = {
    sent: [],
    statuses: [],
    notifies: [],
    notifyTypes: [],
    editor: "",
    sendUserMessage: (text: string, opts?: { deliverAs?: "steer" | "followUp" }) => {
      host.sent.push({ text, opts });
    },
    isIdle: () => overrides?.idle ?? true,
    setStatus: (text: string | undefined) => {
      host.statuses.push(text);
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      host.notifies.push(message);
      host.notifyTypes.push(type);
    },
    pasteToEditor: (text: string) => {
      host.editor += text;
    },
    getEditorText: () => host.editor,
    setEditorText: (text: string) => {
      host.editor = text;
    },
  };
  const sources: FakeSource[] = [];
  const detectors: FakeDetector[] = [];
  const utterances: FakeUtterance[] = [];
  const endpointers: FakeEndpointer[] = [];
  const logs: { event: string; data?: Record<string, unknown> }[] = [];
  const speeches: {
    opts: { key: string; voiceId: string; modelId?: string; onDone: () => void; onFailure: (f: VoiceFailure) => void };
    fake: FakeSpeech;
  }[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  let nowMs = 1_000_000;
  let errorCues = 0;
  let vadCalls = 0;
  let key: string | undefined = overrides && "key" in overrides ? overrides.key : "test-key";
  let ttsKey: string | undefined = overrides && "ttsKey" in overrides ? overrides.ttsKey : key;
  let provisioned = true;

  const deps: ControllerDeps = {
    getPrefs: () => prefs,
    getKey: () => key,
    getTtsKey: () => ttsKey,
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
    createDetector: (
      _paths: unknown,
      _c: unknown,
      _s: unknown,
      onWake: (phrase: string, group: WakeGroup | undefined) => void,
      options: { includeSend: boolean },
    ) => {
      const d: FakeDetector = {
        pushes: [],
        resets: 0,
        closes: 0,
        includeSend: options.includeSend,
        wake: onWake,
        fire: (phrase = "hey pi", group?: WakeGroup | undefined) => d.wake?.(phrase, group),
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
    openSpeech: (opts: { key: string; voiceId: string; modelId?: string; onDone: () => void; onFailure: (f: VoiceFailure) => void }) => {
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
    ensureVadModel: async (): Promise<string> => {
      vadCalls++;
      return "/fake/silero_vad.onnx";
    },
    createEndpointer: (modelPath: string, events: EndpointerEvents) => {
      void modelPath;
      const ep: FakeEndpointer = {
        events,
        pushes: [],
        closes: 0,
        start: (atSec = 0.5) => events.onSpeechStart(atSec),
        end: (atSec = 1.3) => events.onSpeechEnd(atSec),
      };
      endpointers.push(ep);
      return {
        push: (frame: Buffer): void => {
          ep.pushes.push(frame);
        },
        reset: (): void => {},
        close: (): void => {
          ep.closes++;
        },
        get inSpeech(): boolean {
          return false;
        },
      };
    },
    log: (event: string, data?: Record<string, unknown>): void => {
      logs.push({ event, data });
    },
    playErrorCue: () => {
      errorCues++;
    },
    noSpeechMs: 5000,
    now: () => nowMs,
    cooldownMs: 700,
    retryBackoffMs: 2000,
    setTimeout: (cb: () => void, ms: number): unknown => {
      const entry = { cb, ms };
      timers.push(entry);
      return entry;
    },
    clearTimeout: (id: unknown): void => {
      const index = timers.indexOf(id as { cb: () => void; ms: number });
      if (index >= 0) timers.splice(index, 1);
    },
  };
  let cues = 0;
  const controller = new VoiceController(host, deps);
  return {
    controller,
    host,
    prefs,
    deps,
    sources,
    detectors,
    utterances,
    endpointers,
    logs,
    speeches,
    timers,
    cues: () => cues,
    errorCues: () => errorCues,
    vadCalls: () => vadCalls,
    advance: (ms: number): void => {
      nowMs += ms;
    },
    setKey: (next: string | undefined): void => {
      key = next as string;
    },
    setTtsKey: (next: string | undefined): void => {
      ttsKey = next;
    },
    setProvisioned: (next: boolean): void => {
      provisioned = next;
    },
    fireTimers: (): void => {
      for (const t of timers.splice(0)) t.cb();
    },
    fireMs: (ms: number): void => {
      for (let i = timers.length - 1; i >= 0; i--) {
        const t = timers[i];
        if (t && t.ms === ms) {
          timers.splice(i, 1);
          t.cb();
        }
      }
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

    h.advance(150);
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

  it("blank final plays cue and returns to listening after a beat", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("   ");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.errorCues(), 1);
    assert.equal(h.host.statuses.at(-1), "🎙 didn't catch that");
    h.fireMs(2000);
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

  it("retryable failure warns, cues, and returns to listening after backoff", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFailure({ code: "network", message: "STT connection failed.", retryable: true });
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.timers.length, 1);
    assert.ok(h.host.notifies.some((m) => /STT connection failed/.test(m)));
    assert.equal(h.host.notifyTypes.at(-1), "warning");
    assert.equal(h.errorCues(), 1);
    assert.ok((h.host.statuses.at(-1) ?? "").startsWith("⚠"));
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

  it("logs why an assistant message was not spoken", async () => {
    const h = makeHarness({ prefs: { tts: false, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Not spoken. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    const skipped = h.logs.filter((l) => l.event === "tts-skipped");
    assert.equal(skipped.length, 1);
    // Field names avoid /key|token|auth/ so the debug-log redactor keeps them.
    assert.deepEqual(skipped[0].data, { ttsOn: false, hasVoice: true, hasCredential: true });
  });

  it("logs speech start, done, and failure detail", async () => {
    const h = makeHarness({ prefs: { tts: true, voiceId: "v1" } });
    await h.controller.start();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Spoken prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
    h.speeches[0].opts.onDone();
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "More prose here. ".repeat(8));
    h.speeches[1].opts.onFailure({ code: "protocol", message: "speech failed (protocol)", retryable: false });
    const events = h.logs.map((l) => l.event).filter((e) => e.startsWith("tts-"));
    assert.deepEqual(events, ["tts-start", "tts-done", "tts-start", "tts-failure"]);
    const failure = h.logs.find((l) => l.event === "tts-failure");
    assert.deepEqual(failure?.data, { code: "protocol", retryable: false, detail: "speech failed (protocol)" });
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

describe("provider TTS dispatch", () => {
  function speak(h: ReturnType<typeof makeHarness>): void {
    h.controller.onMessageUpdate({ role: "assistant" }, "text_delta", "Spoken prose here. ".repeat(8));
    h.controller.onMessageEnd({ role: "assistant", stopReason: "stop" }, true);
  }

  it("inworld speaks with the default voice and no explicit selection", async () => {
    const h = makeHarness({ prefs: { tts: true }, ttsKey: "iw-key" });
    await h.controller.start();
    speak(h);
    assert.equal(h.speeches.length, 1);
    assert.equal(h.speeches[0].opts.key, "iw-key");
    assert.equal(h.speeches[0].opts.voiceId, "Ashley");
    assert.equal(h.speeches[0].opts.modelId, "inworld-tts-2");
  });

  it("inworld uses saved voice and model overrides", async () => {
    const h = makeHarness({
      prefs: { tts: true, inworldVoiceId: "Hades", inworldModel: "inworld-tts-2-flash" },
      ttsKey: "iw-key",
    });
    await h.controller.start();
    speak(h);
    assert.equal(h.speeches[0].opts.voiceId, "Hades");
    assert.equal(h.speeches[0].opts.modelId, "inworld-tts-2-flash");
  });

  it("elevenlabs speaks with its own key, voice, and model", async () => {
    const h = makeHarness({
      prefs: { tts: true, ttsProvider: "elevenlabs", voiceId: "v1", ttsModel: "eleven_flash_v2_5" },
      key: "el-key",
      ttsKey: "el-tts-key",
    });
    await h.controller.start();
    speak(h);
    assert.equal(h.speeches.length, 1);
    assert.equal(h.speeches[0].opts.key, "el-tts-key");
    assert.equal(h.speeches[0].opts.voiceId, "v1");
    assert.equal(h.speeches[0].opts.modelId, "eleven_flash_v2_5");
  });

  it("elevenlabs without a voice stays silent", async () => {
    const h = makeHarness({ prefs: { tts: true, ttsProvider: "elevenlabs" }, key: "el-key", ttsKey: "el-key" });
    await h.controller.start();
    speak(h);
    assert.equal(h.speeches.length, 0);
  });

  it("inworld without its key stays silent even with the STT key present", async () => {
    const h = makeHarness({ prefs: { tts: true }, key: "el-key", ttsKey: undefined });
    await h.controller.start();
    speak(h);
    assert.equal(h.speeches.length, 0);
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

describe("capture endpointing and delivery", () => {
  it("ensures the VAD model during preparing", async () => {
    const h = makeHarness({});
    await h.controller.start();
    assert.equal(h.vadCalls(), 1);
  });

  it("committed transcribing status is not overwritten by the capture meter", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.endpointers[0].end(1.3);
    assert.equal(h.host.statuses.at(-1), "🎙 transcribing…");
    const base = h.host.statuses.length;
    // Late mic frames arrive while the transcript is pending; the throttled
    // meter must not repaint over the committed status.
    h.advance(150);
    h.sources[0].emit(Buffer.from([9, 9, 9, 9]));
    h.advance(150);
    h.sources[0].emit(Buffer.from([9, 9, 9, 9]));
    // Nor may a late partial transcript.
    h.advance(150);
    h.utterances[0].handlers.onPartial("late partial words");
    assert.equal(h.host.statuses.length, base);
    assert.equal(h.host.statuses.at(-1), "🎙 transcribing…");
    // The utterance still resolves normally.
    h.utterances[0].handlers.onFinal("done deal");
    assert.deepEqual(h.host.sent[0], { text: "done deal", opts: undefined });
  });

  it("session start is logged once with the server message_type name", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    const u = h.utterances[0];
    const sessionLogs = (): (string | undefined)[] =>
      h.logs
        .filter(
          (l) =>
            l.event === "stt-event" &&
            typeof l.data?.["type"] === "string" &&
            /session.started/.test(l.data["type"] as string),
        )
        .map((l) => l.data?.["type"] as string);
    const before = sessionLogs().length;
    u.handlers.onSession?.();
    u.handlers.onEvent?.("session_started");
    const after = sessionLogs();
    assert.equal(after.length - before, 1);
    assert.deepEqual(after.slice(-1), ["session_started"]);
  });

  it("VAD end commits the utterance and transcribes", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    assert.equal(h.endpointers.length, 1);
    h.endpointers[0].start(0.5);
    h.endpointers[0].end(1.3);
    assert.equal(h.utterances[0].commits, 1);
    assert.equal(h.host.statuses.at(-1), "🎙 transcribing…");
    h.utterances[0].handlers.onFinal("done deal");
    assert.deepEqual(h.host.sent[0], { text: "done deal", opts: undefined });
    assert.equal(h.endpointers[0].closes, 1);
  });

  it("speech start cancels the no-speech timeout", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.4);
    assert.equal(h.timers.length, 0);
    h.fireMs(5000);
    assert.equal(h.errorCues(), 0);
    assert.equal(h.controller.getPhase(), "capture");
  });

  it("no-speech timeout cues and recovers without notify", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    const notices = h.host.notifies.length;
    h.fireMs(5000);
    assert.equal(h.utterances[0].closed, 1);
    assert.equal(h.endpointers[0].closes, 1);
    assert.equal(h.errorCues(), 1);
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.host.notifies.length, notices);
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.host.statuses.at(-1), "🎙 didn't hear anything");
    h.fireMs(2000);
    assert.equal(h.host.statuses.at(-1), "🎙 listening");
  });

  it("onEnd blank cues and recovers without submit", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onEnd!({ reason: "blank", text: "" });
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.errorCues(), 1);
    assert.equal(h.host.statuses.at(-1), "🎙 didn't catch that");
    h.fireMs(2000);
    assert.equal(h.host.statuses.at(-1), "🎙 listening");
  });

  it("partial-fallback onEnd submits and logs the source", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onEnd!({ reason: "final", text: "fallback words", source: "partial-fallback" });
    assert.deepEqual(h.host.sent[0], { text: "fallback words", opts: undefined });
    assert.ok(h.logs.some((l) => l.data?.["source"] === "partial-fallback"));
  });

  it("auto dictate submits immediately and strips trailing send", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("take notes send to pi");
    assert.deepEqual(h.host.sent[0], { text: "take notes", opts: undefined });
    assert.ok(h.logs.some((l) => l.event === "intent" && l.data?.["kind"] === "dictate"));
  });

  it("review dictate appends to the draft without submitting", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("take notes");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.host.editor, "take notes");
    assert.ok((h.host.statuses.at(-1) ?? "").includes("draft"));
  });

  it("review dictate appends to an existing draft", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.host.editor = "prior";
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("more words");
    assert.equal(h.host.editor, "prior more words");
    assert.equal(h.host.sent.length, 0);
  });

  it("review trailing send submits draft plus text and clears the editor", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.host.editor = "prior";
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("more words send to pi");
    assert.deepEqual(h.host.sent[0], { text: "prior more words", opts: undefined });
    assert.equal(h.host.editor, "");
  });

  it("review trailing send keeps the existing draft when submit throws", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.host.editor = "prior";
    h.host.sendUserMessage = () => {
      throw new Error("boom");
    };
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("more words send to pi");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.host.editor, "prior");
    assert.ok(h.host.notifies.some((m) => m.startsWith("Voice submit failed:")));
  });

  it("stop aborts an in-flight model download without a failed-start notify", async () => {
    const h = makeHarness({});
    let seen: AbortSignal | undefined;
    h.deps.ensureModel = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        seen = signal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const started = h.controller.start();
    await new Promise((r) => setTimeout(r, 0));
    await h.controller.stop();
    const outcome = await Promise.race([
      started.then(() => "settled"),
      new Promise((r) => setTimeout(() => r("hung"), 50)),
    ]);
    assert.equal(outcome, "settled");
    assert.equal(seen?.aborted, true);
    assert.ok(!h.host.notifies.some((m) => m.startsWith("Voice failed to start")));
  });

  it("send intent submits the draft and clears the editor", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.host.editor = "do the thing";
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("send to pi");
    assert.deepEqual(h.host.sent[0], { text: "do the thing", opts: undefined });
    assert.equal(h.host.editor, "");
  });

  it("send intent with an empty draft shows nothing-to-send, no notify", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.detectors[0].fire();
    const notices = h.host.notifies.length;
    h.utterances[0].handlers.onFinal("send to pi");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.host.notifies.length, notices);
    assert.equal(h.host.statuses.at(-1), "📝 nothing to send");
    h.fireMs(2000);
    assert.equal(h.host.statuses.at(-1), "🎙 listening");
  });

  it("spotter send-to-pi submits the draft without opening an utterance", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.host.editor = "drafted words";
    h.detectors[0].fire("send to pi", "send-to-pi");
    assert.deepEqual(h.host.sent[0], { text: "drafted words", opts: undefined });
    assert.equal(h.host.editor, "");
    assert.equal(h.utterances.length, 0);
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("spotter send-to-pi with an empty draft is ignored", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    await h.controller.start();
    h.detectors[0].fire("send to pi", "send-to-pi");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.utterances.length, 0);
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("includeSend tracks sendMode", async () => {
    const auto = makeHarness({});
    await auto.controller.start();
    assert.equal(auto.detectors[0].includeSend, false);
    const review = makeHarness({ prefs: { sendMode: "review" } });
    await review.controller.start();
    assert.equal(review.detectors[0].includeSend, true);
  });

  it("retryable failure notifies at most once per minute per code", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    const fail = { code: "network", message: "STT connection failed.", retryable: true } as const;
    h.utterances[0].handlers.onFailure({ ...fail });
    h.utterances[0].handlers.onFailure({ ...fail });
    assert.equal(h.host.notifies.filter((m) => /STT connection failed/.test(m)).length, 1);
    assert.equal(h.errorCues(), 2);
    h.advance(61_000);
    h.utterances[0].handlers.onFailure({ ...fail });
    assert.equal(h.host.notifies.filter((m) => /STT connection failed/.test(m)).length, 2);
  });

  it("terms failure stops with an error notice", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFailure({ code: "terms", message: "STT terms not accepted", retryable: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getPhase(), "off");
    assert.equal(h.host.notifyTypes.at(-1), "error");
    assert.ok(h.host.notifies.some((m) => /terms/.test(m)));
  });

  it("mic stall restarts with backoff and gives up after three", async () => {
    const h = makeHarness({});
    await h.controller.start();
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    h.sources[0].fail(new MicError("stalled", "no data"));
    assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
    h.fireMs(1000);
    await flush();
    await flush();
    assert.equal(h.sources.length, 2);
    h.sources[1].fail(new MicError("stalled", "no data"));
    assert.deepEqual(h.timers.map((t) => t.ms), [2000]);
    h.fireMs(2000);
    await flush();
    await flush();
    assert.equal(h.sources.length, 3);
    h.sources[2].fail(new MicError("exited", "gone"));
    assert.deepEqual(h.timers.map((t) => t.ms), [4000]);
    h.fireMs(4000);
    await flush();
    await flush();
    assert.equal(h.sources.length, 4);
    h.sources[3].fail(new MicError("device", "gone"));
    await flush();
    await flush();
    assert.equal(h.controller.getPhase(), "off");
    assert.equal(h.host.notifyTypes.at(-1), "error");
    assert.equal(h.host.notifies.filter((m) => /restarting/.test(m)).length, 1);
  });

  it("mic permission failure stops with a settings notice", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.sources[0].fail(new MicError("permission", "denied"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.getPhase(), "off");
    assert.equal(h.host.notifyTypes.at(-1), "error");
    assert.ok(h.host.notifies.some((m) => /Privacy & Security/.test(m)));
  });

  it("flowing audio resets the mic restart count", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.sources[0].fail(new MicError("stalled", "no data"));
    assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
    h.fireMs(1000);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    h.sources[1].emit(Buffer.from([1, 2, 3, 4]));
    h.sources[1].fail(new MicError("stalled", "no data"));
    assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
  });

  it("pure digital silence warns once per session", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.sources[0].emit(Buffer.alloc(96000));
    assert.equal(h.host.notifies.filter((m) => /pure silence/.test(m)).length, 1);
    assert.equal(h.host.notifyTypes.at(-1), "warning");
    h.sources[0].emit(Buffer.alloc(96000));
    assert.equal(h.host.notifies.filter((m) => /pure silence/.test(m)).length, 1);
  });

  it("capture status writes throttle to one per 100 ms", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    const base = h.host.statuses.length;
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    assert.equal(h.host.statuses.length, base);
    h.advance(150);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    assert.equal(h.host.statuses.length, base + 1);
    assert.ok((h.host.statuses.at(-1) ?? "").includes("listening"));
  });

  it("onEnd error after a failure does not blank-handle", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFailure({ code: "network", message: "STT connection failed.", retryable: true });
    const cues = h.errorCues();
    h.utterances[0].handlers.onEnd!({ reason: "error", text: "" });
    assert.equal(h.errorCues(), cues);
    assert.ok((h.host.statuses.at(-1) ?? "").startsWith("⚠"));
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("debug log records events with lengths, never transcript text", async () => {
    const h = makeHarness({});
    await h.controller.start();
    h.detectors[0].fire();
    h.advance(150);
    h.utterances[0].handlers.onPartial("xylophone partial");
    h.utterances[0].handlers.onFinal("xylophone zebra seven");
    const blob = JSON.stringify(h.logs);
    assert.ok(!blob.includes("xylophone"), "transcript text leaked into debug log");
    assert.ok(!blob.includes("zebra"), "transcript text leaked into debug log");
    assert.ok(h.logs.some((l) => l.event === "phase"));
    assert.ok(h.logs.some((l) => l.event === "wake"));
    assert.ok(h.logs.some((l) => l.event === "intent" && l.data?.["kind"] === "dictate"));
    assert.ok(h.logs.some((l) => l.event === "delivery" && typeof l.data?.["length"] === "number"));
  });
});

describe("speaker gate", () => {
  type GateHarness = ReturnType<typeof makeHarness>;

  /** Controllable gate: evaluates (calls embed) once enough speech arrives, then caches the verdict. */
  function armGate(h: GateHarness, opts: { accept: boolean; evaluateAfterPushes?: number; finalDecision?: "accept" | "reject" | "insufficient"; finalScore?: number }): {
    pushes: number;
    embedCalls: number;
  } {
    const state = { pushes: 0, embedCalls: 0 };
    const evaluateAfter = opts.evaluateAfterPushes ?? 2;
    let verdict: "accept" | "reject" | undefined;
    h.deps.getSpeakerCheck = () => "normal";
    h.deps.getSpeakerProfile = () => ({
      version: 1 as const,
      model: "/tmp/speaker.onnx",
      dim: 2,
      centroid: [1, 0],
      enrolledAt: "2026-01-02T00:00:00.000Z",
      enrollScores: [0.9, 0.9, 0.9, 0.9],
      suggestedThreshold: 0.75,
    });
    h.deps.getSpeakerEmbed = () => () => {
      state.embedCalls++;
      return { length: 2, 0: 1, 1: 0 };
    };
    h.deps.createSpeakerGate = () => ({
      push: (_pcm: Buffer): void => {
        state.pushes++;
        if (verdict === undefined && state.pushes >= evaluateAfter) {
          h.deps.getSpeakerEmbed?.()?.(Buffer.from([0]));
          verdict = opts.accept ? "accept" : "reject";
        }
      },
      decision: (): "accept" | "reject" | "pending" => verdict ?? "pending",
      finalize: (): { decision: "accept" | "reject" | "insufficient"; score?: number; speechMs: number } => {
        if (verdict !== undefined) return { decision: verdict, score: 0.9, speechMs: 1500 };
        return { decision: opts.finalDecision ?? "accept", score: opts.finalScore ?? 0.81, speechMs: 900 };
      },
      reset: (): void => {
        verdict = undefined;
      },
    });
    return state;
  }

  async function captureWithSpeech(h: GateHarness): Promise<void> {
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
  }

  it("reject mid-utterance cancels STT and submits nothing", async () => {
    const h = makeHarness({});
    armGate(h, { accept: false });
    await captureWithSpeech(h);
    const errorCues = h.errorCues();
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    assert.equal(h.controller.getPhase(), "capture");
    h.sources[0].emit(Buffer.from([5, 6, 7, 8]));
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.utterances[0].closed, 1);
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.errorCues(), errorCues + 1);
    assert.equal(h.host.statuses.at(-1), "\uD83C\uDF99 not your voice");
    h.fireMs(2000);
    assert.equal(h.host.statuses.at(-1), "\uD83C\uDF99 listening");
    // Late finals from the canceled utterance never submit.
    h.utterances[0].handlers.onFinal("impostor words");
    assert.equal(h.host.sent.length, 0);
    const speakerLogs = h.logs.filter((l) => l.event === "speaker");
    assert.equal(speakerLogs.length, 1);
    assert.equal(speakerLogs[0].data?.["decision"], "reject");
  });

  it("finalize reject at end of speech cancels without submit", async () => {
    const h = makeHarness({});
    armGate(h, { accept: true, evaluateAfterPushes: 100, finalDecision: "reject", finalScore: 0.4 });
    await captureWithSpeech(h);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    assert.equal(h.controller.getPhase(), "capture");
    h.endpointers[0].end(1.3);
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.utterances[0].commits, 0);
    assert.equal(h.host.statuses.at(-1), "\uD83C\uDF99 not your voice");
    assert.ok(h.logs.some((l) => l.event === "speaker" && l.data?.["decision"] === "reject" && l.data?.["score"] === 0.4));
  });

  it("unverified reject shows the unverified cue and stores no correction candidate", async () => {
    const h = makeHarness({});
    const errorCues = h.errorCues();
    h.deps.getSpeakerCheck = () => "normal";
    h.deps.getSpeakerProfile = () => ({
      version: 1 as const,
      model: "/tmp/speaker.onnx",
      dim: 2,
      centroid: [1, 0],
      enrolledAt: "2026-01-02T00:00:00.000Z",
      enrollScores: [0.9, 0.9, 0.9, 0.9],
      suggestedThreshold: 0.75,
    });
    h.deps.getSpeakerEmbed = () => () => ({ length: 2, 0: 1, 1: 0 });
    h.deps.createSpeakerGate = () => ({
      push: (_pcm: Buffer): void => {},
      decision: (): "accept" | "reject" | "pending" => "pending",
      finalize: (): { decision: "accept" | "reject" | "insufficient"; score?: number; speechMs: number; reason?: "unverified" } => ({
        decision: "reject",
        reason: "unverified",
        speechMs: 1500,
      }),
      reset: (): void => {},
    });
    await captureWithSpeech(h);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    assert.equal(h.controller.getPhase(), "wake");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.utterances[0].commits, 0);
    assert.equal(h.errorCues(), errorCues + 1);
    assert.equal(h.host.statuses.at(-1), "\uD83C\uDF99 couldn't verify your voice \u2014 try a shorter request");
    assert.equal(h.controller.getSpeakerCorrectionCandidate(), undefined);
    assert.ok(h.logs.some((l) => l.event === "speaker" && l.data?.["decision"] === "reject" && l.data?.["reason"] === "unverified"));
    h.fireMs(2000);
    assert.equal(h.host.statuses.at(-1), "\uD83C\uDF99 listening");
    h.utterances[0].handlers.onFinal("late unverified words");
    assert.equal(h.host.sent.length, 0);
  });

  it("finalize accept and insufficient proceed to submit", async () => {
    for (const finalDecision of ["accept", "insufficient"] as const) {
      const h = makeHarness({});
      armGate(h, { accept: true, evaluateAfterPushes: 100, finalDecision });
      await captureWithSpeech(h);
      h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
      h.endpointers[0].end(1.3);
      assert.equal(h.utterances[0].commits, 1);
      h.utterances[0].handlers.onFinal("owner words here");
      assert.deepEqual(h.host.sent[0], { text: "owner words here", opts: undefined });
      assert.ok(h.logs.some((l) => l.event === "speaker" && l.data?.["decision"] === finalDecision));
    }
  });

  it("partial-fallback onEnd from a non-owner submits nothing", async () => {
    const h = makeHarness({});
    // Gate stays pending during capture (no VAD end); finalize rejects.
    armGate(h, { accept: true, evaluateAfterPushes: 100, finalDecision: "reject", finalScore: 0.4 });
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onEnd!({ reason: "final", text: "fallback impostor words", source: "partial-fallback" });
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.controller.getPhase(), "wake");
    assert.ok(h.logs.some((l) => l.event === "speaker" && l.data?.["decision"] === "reject"));
    // Late final from the rejected utterance never submits either.
    h.utterances[0].handlers.onFinal("fallback impostor words");
    assert.equal(h.host.sent.length, 0);
  });

  it("partial-fallback direct onFinal from a non-owner submits nothing", async () => {
    const h = makeHarness({});
    armGate(h, { accept: true, evaluateAfterPushes: 100, finalDecision: "reject", finalScore: 0.4 });
    await h.controller.start();
    h.detectors[0].fire();
    // stt.ts partial fallback calls onFinal directly before onEnd.
    h.utterances[0].handlers.onFinal("fallback impostor words");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.controller.getPhase(), "wake");
  });

  it("review-mode staging from a non-owner appends nothing", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    armGate(h, { accept: true, evaluateAfterPushes: 100, finalDecision: "reject", finalScore: 0.4 });
    await h.controller.start();
    h.detectors[0].fire();
    h.utterances[0].handlers.onFinal("staged impostor words");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.host.editor, "");
  });

  it("embedding runs at evaluation, not on every frame", async () => {
    const h = makeHarness({});
    const state = armGate(h, { accept: true, evaluateAfterPushes: 3 });
    await captureWithSpeech(h);
    for (let i = 0; i < 5; i++) h.sources[0].emit(Buffer.from([9, 9, 9, 9]));
    assert.equal(state.pushes, 5);
    assert.equal(state.embedCalls, 1);
  });

  it("check is off without a profile or embedder", async () => {
    for (const missing of ["profile", "embedder"] as const) {
      const h = makeHarness({});
      armGate(h, { accept: false });
      if (missing === "profile") h.deps.getSpeakerProfile = () => undefined;
      else h.deps.getSpeakerEmbed = () => undefined;
      await captureWithSpeech(h);
      h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
      h.sources[0].emit(Buffer.from([5, 6, 7, 8]));
      assert.equal(h.controller.getPhase(), "capture");
      h.endpointers[0].end(1.3);
      h.utterances[0].handlers.onFinal("normal words");
      assert.deepEqual(h.host.sent[0], { text: "normal words", opts: undefined });
    }
  });
});

describe("speaker gate vad scoping", () => {
  // 16 kHz s16le mono: 32 bytes per millisecond, so 3200 bytes == 100 ms.
  const FRAME_100MS = 3200;
  const speechFrame = (): Buffer => Buffer.alloc(FRAME_100MS, 1);
  const silenceFrame = (): Buffer => Buffer.alloc(FRAME_100MS, 0);

  function ownerProfile(): SpeakerProfile {
    return {
      version: 1,
      model: "test",
      dim: 2,
      centroid: [1, 0],
      enrolledAt: "2026-01-01T00:00:00Z",
      enrollScores: [0.9],
      suggestedThreshold: 0.7,
      anchors: [[1, 0]],
    };
  }

  function armRealGate(h: ReturnType<typeof makeHarness>): {
    saves: SpeakerProfile[];
    embeddedBytes: number[];
  } {
    const saves: SpeakerProfile[] = [];
    const embeddedBytes: number[] = [];
    const box = { profile: ownerProfile() };
    h.deps.getSpeakerCheck = () => "normal";
    h.deps.getSpeakerProfile = () => box.profile;
    h.deps.getSpeakerEmbed = () => () => ({ length: 2, 0: 1, 1: 0 });
    h.deps.createSpeakerGate = (opts) =>
      createSpeakerGate({
        embed: (pcm: Buffer): Float32Array => {
          embeddedBytes.push(pcm.length);
          return Float32Array.from([1, 0]);
        },
        profile: opts.profile,
        threshold: opts.threshold,
      });
    h.deps.setSpeakerProfile = (p: SpeakerProfile): void => {
      box.profile = p;
    };
    h.deps.saveSpeakerProfile = async (p: SpeakerProfile): Promise<void> => {
      saves.push(p);
    };
    return { saves, embeddedBytes };
  }

  it("0.8 s speech plus 3 s silence reports speech-only ms and is not learned", async () => {
    const h = makeHarness({});
    const { saves, embeddedBytes } = armRealGate(h);
    await h.controller.start();
    h.detectors[0]!.fire();
    // Pre-speech audio never reaches the gate.
    h.sources[0]!.emit(silenceFrame());
    h.endpointers[0]!.start(0.5);
    for (let i = 0; i < 8; i++) h.sources[0]!.emit(speechFrame()); // 0.8 s of speech
    h.endpointers[0]!.end(1.3);
    for (let i = 0; i < 30; i++) h.sources[0]!.emit(silenceFrame()); // 3 s trailing silence
    h.utterances[0]!.handlers.onFinal("owner words here");
    // The transcript still submits normally; only learning is gated on speech.
    assert.deepEqual(h.host.sent[0], { text: "owner words here", opts: undefined });
    // Only the 0.8 s of VAD-flagged speech counts: 800 ms, not 800 + 3000.
    // Below the 1500 ms insufficient floor nothing is embedded at all.
    assert.deepEqual(embeddedBytes, []);
    const speakerLogs = h.logs.filter((l) => l.event === "speaker");
    const last = speakerLogs.at(-1);
    assert.ok(last !== undefined, "expected a speaker verdict log");
    assert.ok(
      Math.abs((last?.data?.["speechMs"] as number) - 800) < 1,
      `expected speechMs ~= 800, got ${String(last?.data?.["speechMs"])}`,
    );
    // 800 ms is below the 1500 ms insufficient floor: submitted, never
    // scored, never learned (no accepted embedding, no learn attempt).
    assert.equal(saves.length, 0);
    assert.ok(!h.logs.some((l) => l.event === "speaker-learn"), "expected no speaker-learn attempt for insufficient speech");
  });

  it("two speech segments separated by a pause accumulate in the real gate; pause audio is not", async () => {
    const h = makeHarness({});
    const { embeddedBytes } = armRealGate(h);
    await h.controller.start();
    h.detectors[0]!.fire();
    h.endpointers[0]!.start(0.5);
    const segment = Buffer.alloc(40000, 1); // 1.25 s of speech per segment
    const pause = Buffer.alloc(6000, 0);
    h.sources[0]!.emit(segment);
    assert.equal(h.controller.getPhase(), "capture");
    h.endpointers[0]!.end(1.0);
    h.sources[0]!.emit(pause); // pause audio after VAD end
    h.endpointers[0]!.start(1.8); // speech resumes within the same utterance
    h.sources[0]!.emit(segment);
    // STT still receives every frame, pause included; only the gate is filtered.
    const sttBytes = h.utterances[0]!.pushes.reduce((n, b) => n + b.length, 0);
    assert.equal(sttBytes, 86000);
    h.utterances[0]!.handlers.onFinal("owner words here");
    assert.deepEqual(h.host.sent[0], { text: "owner words here", opts: undefined });
    // The real gate accumulated both speech segments (2.5 s) and ignored the
    // pause, with at most one early plus one finalize embedding.
    assert.equal(embeddedBytes.at(-1), 80000);
    assert.ok(embeddedBytes.length <= 2, `expected at most 2 embeddings, got ${embeddedBytes.length}`);
    const speakerLogs = h.logs.filter((l) => l.event === "speaker");
    const last = speakerLogs.at(-1);
    assert.ok(last !== undefined, "expected a speaker verdict log");
    assert.ok(
      Math.abs((last?.data?.["speechMs"] as number) - 2500) < 1,
      `expected speechMs ~= 2500, got ${String(last?.data?.["speechMs"])}`,
    );
  });
});

describe("speaker learning", () => {
  type GateHarness = ReturnType<typeof makeHarness>;

  function learnProfile(): SpeakerProfile {
    return {
      version: 1,
      model: "/tmp/speaker.onnx",
      dim: 2,
      centroid: [1, 0],
      enrolledAt: "2026-01-02T00:00:00.000Z",
      enrollScores: [0.92, 0.88, 0.9, 0.91, 0.89],
      suggestedThreshold: 0.7,
      anchors: [[1, 0]],
      learned: [],
    };
  }

  /** Gate fake that reports a scored embedding, plus learning persistence capture. */
  function armLearningGate(
    h: GateHarness,
    opts: {
      finalDecision?: "accept" | "reject" | "insufficient";
      score?: number;
      speechMs?: number;
      embedding?: Float32Array;
    } = {},
  ): { saves: SpeakerProfile[]; current: () => SpeakerProfile } {
    const box = { profile: learnProfile() };
    const saves: SpeakerProfile[] = [];
    const embedding = opts.embedding ?? new Float32Array([1, 0]);
    h.deps.getSpeakerCheck = () => "normal";
    h.deps.getSpeakerProfile = () => box.profile;
    h.deps.getSpeakerEmbed = () => () => ({ length: 2, 0: 1, 1: 0 });
    h.deps.createSpeakerGate = () => ({
      push: (_pcm: Buffer): void => {},
      decision: (): "accept" | "reject" | "pending" => "pending",
      finalize: (): {
        decision: "accept" | "reject" | "insufficient";
        score?: number;
        speechMs: number;
        embedding?: Float32Array;
      } => ({
        decision: opts.finalDecision ?? "accept",
        score: opts.score ?? 1.0,
        speechMs: opts.speechMs ?? 2500,
        ...(opts.finalDecision === "insufficient" ? {} : { embedding }),
      }),
      reset: (): void => {},
      lastEmbedding: (): Float32Array | undefined =>
        opts.finalDecision === "insufficient" ? undefined : embedding,
    });
    h.deps.setSpeakerProfile = (p) => {
      box.profile = p;
    };
    h.deps.saveSpeakerProfile = async (p) => {
      saves.push(p);
    };
    return { saves, current: () => box.profile };
  }

  async function submitAccepted(h: GateHarness, text = "owner words here"): Promise<void> {
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    assert.equal(h.utterances[0].commits, 1);
    h.utterances[0].handlers.onFinal(text);
  }

  it("learns on accepted+submitted and persists immediately", async () => {
    const h = makeHarness({});
    const { saves, current } = armLearningGate(h);
    await submitAccepted(h);
    assert.deepEqual(h.host.sent[0], { text: "owner words here", opts: undefined });
    assert.equal(current().learned?.length, 1);
    assert.equal(saves.length, 1);
    assert.equal(saves[0]?.learned?.length, 1);
    const learnLogs = h.logs.filter((l) => l.event === "speaker-learn");
    assert.equal(learnLogs.length, 1);
    assert.deepEqual(learnLogs[0]?.data, { reason: "learned", learned: 1 });
  });

  it("does not learn without an accepted embedding (insufficient)", async () => {
    const h = makeHarness({});
    const { saves, current } = armLearningGate(h, { finalDecision: "insufficient" });
    await submitAccepted(h);
    assert.equal(h.host.sent.length, 1);
    assert.equal(current().learned?.length ?? 0, 0);
    assert.equal(saves.length, 0);
    assert.ok(!h.logs.some((l) => l.event === "speaker-learn"));
  });

  it("does not learn on rejection but keeps the embedding for correction", async () => {
    const h = makeHarness({});
    const { saves } = armLearningGate(h, { finalDecision: "reject", score: 0.4 });
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    assert.equal(h.host.sent.length, 0);
    assert.equal(saves.length, 0);
    const candidate = h.controller.getSpeakerCorrectionCandidate();
    assert.ok(candidate instanceof Float32Array);
    h.utterances[0].handlers.onFinal("impostor words");
    assert.equal(h.host.sent.length, 0);
    assert.equal(saves.length, 0);
  });

  it("does not learn on STT failure", async () => {
    const h = makeHarness({});
    const { saves } = armLearningGate(h);
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    h.utterances[0].handlers.onFailure({ code: "network", message: "STT broke", retryable: true });
    assert.equal(h.host.sent.length, 0);
    assert.equal(saves.length, 0);
    assert.ok(!h.logs.some((l) => l.event === "speaker-learn"));
  });

  it("does not learn on blank transcripts", async () => {
    const h = makeHarness({});
    const { saves } = armLearningGate(h);
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    h.utterances[0].handlers.onFinal("   ");
    assert.equal(h.host.sent.length, 0);
    assert.equal(saves.length, 0);
  });

  it("does not learn on a failed send", async () => {
    const h = makeHarness({});
    const { saves } = armLearningGate(h);
    h.host.sendUserMessage = () => {
      throw new Error("boom");
    };
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    h.utterances[0].handlers.onFinal("owner words here");
    assert.equal(h.host.sent.length, 0);
    assert.equal(saves.length, 0);
  });

  it("does not learn when capture is stopped or restarted before submit", async () => {
    const stopped = makeHarness({});
    const stoppedLearn = armLearningGate(stopped);
    await stopped.controller.start();
    stopped.detectors[0].fire();
    stopped.endpointers[0].start(0.5);
    stopped.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    stopped.endpointers[0].end(1.3);
    await stopped.controller.stop();
    stopped.utterances[0].handlers.onFinal("late words");
    assert.equal(stopped.host.sent.length, 0);
    assert.equal(stoppedLearn.saves.length, 0);

    const restarted = makeHarness({});
    const restartedLearn = armLearningGate(restarted);
    await restarted.controller.start();
    restarted.detectors[0].fire();
    restarted.endpointers[0].start(0.5);
    await restarted.controller.restartIfListening();
    restarted.utterances[0].handlers.onFinal("stale words");
    assert.equal(restarted.host.sent.length, 0);
    assert.equal(restartedLearn.saves.length, 0);
  });

  it("review dictation without send does not learn; trailing send does", async () => {
    const h = makeHarness({ prefs: { sendMode: "review" } });
    const { saves } = armLearningGate(h);
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    h.utterances[0].handlers.onFinal("take notes");
    assert.equal(h.host.sent.length, 0);
    assert.equal(h.host.editor, "take notes");
    assert.equal(saves.length, 0);
    h.detectors[0].fire();
    h.endpointers[1].start(0.5);
    h.sources[0].emit(Buffer.from([5, 6, 7, 8]));
    h.endpointers[1].end(1.4);
    h.utterances[1].handlers.onFinal("more words send to pi");
    assert.deepEqual(h.host.sent[0], { text: "take notes more words", opts: undefined });
    assert.equal(saves.length, 1);
  });

  it("learning disabled skips adaptation", async () => {
    const h = makeHarness({ prefs: { speakerLearn: false } });
    const { saves, current } = armLearningGate(h);
    await submitAccepted(h);
    assert.equal(h.host.sent.length, 1);
    assert.equal(current().learned?.length ?? 0, 0);
    assert.equal(saves.length, 0);
    assert.ok(!h.logs.some((l) => l.event === "speaker-learn"));
  });

  it("persistence is debounced and flushed on stop", async () => {
    const h = makeHarness({});
    const { saves, current } = armLearningGate(h);
    await submitAccepted(h, "first");
    assert.equal(saves.length, 1);
    h.detectors[0].fire();
    h.endpointers[1].start(0.5);
    h.sources[0].emit(Buffer.from([5, 6, 7, 8]));
    h.endpointers[1].end(1.4);
    h.utterances[1].handlers.onFinal("second");
    assert.equal(h.host.sent.length, 2);
    assert.equal(current().learned?.length, 2);
    assert.equal(saves.length, 1);
    await h.controller.stop();
    assert.equal(saves.length, 2);
    assert.equal(saves[1]?.learned?.length, 2);
  });

  it("slow persistence never delays submission", async () => {
    const h = makeHarness({});
    armLearningGate(h);
    h.deps.saveSpeakerProfile = () => new Promise<never>(() => {});
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    h.utterances[0].handlers.onFinal("owner words here");
    assert.deepEqual(h.host.sent[0], { text: "owner words here", opts: undefined });
  });

  it("rejected embeddings expire after two minutes", async () => {
    const h = makeHarness({});
    armLearningGate(h, { finalDecision: "reject", score: 0.4 });
    await h.controller.start();
    h.detectors[0].fire();
    h.endpointers[0].start(0.5);
    h.sources[0].emit(Buffer.from([1, 2, 3, 4]));
    h.endpointers[0].end(1.3);
    assert.ok(h.controller.getSpeakerCorrectionCandidate() instanceof Float32Array);
    h.advance(119_000);
    assert.ok(h.controller.getSpeakerCorrectionCandidate() instanceof Float32Array);
    h.advance(2_000);
    assert.equal(h.controller.getSpeakerCorrectionCandidate(), undefined);
  });

  it("no correction candidate without a rejection", async () => {
    const h = makeHarness({});
    armLearningGate(h);
    await submitAccepted(h);
    assert.equal(h.controller.getSpeakerCorrectionCandidate(), undefined);
  });
});
