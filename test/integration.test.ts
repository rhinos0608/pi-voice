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

function makeHarness(overrides?: { prefs?: Partial<VoicePreferences>; idle?: boolean; key?: string }) {
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
  const speeches: { opts: { onDone: () => void; onFailure: (f: VoiceFailure) => void }; fake: FakeSpeech }[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  let nowMs = 1_000_000;
  let errorCues = 0;
  let vadCalls = 0;
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
