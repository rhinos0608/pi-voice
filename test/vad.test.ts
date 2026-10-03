import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createEndpointer, VAD_WINDOW, type VadLike } from "../src/vad.ts";

const SR = 16000;

function s16le(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

function silenceWindows(n: number): Buffer {
  return Buffer.alloc(n * VAD_WINDOW * 2);
}

function makeFake() {
  const state = {
    windows: [] as Float32Array[],
    detected: false,
    segments: [] as { start: number; len: number }[],
    resets: 0,
  };
  const vad: VadLike = {
    acceptWaveform(s: Float32Array): void {
      state.windows.push(Float32Array.from(s));
    },
    isEmpty(): boolean {
      return state.segments.length === 0;
    },
    isDetected(): boolean {
      return state.detected;
    },
    front(): { start: number; samples: Float32Array } {
      const g = state.segments[0] as { start: number; len: number };
      return { start: g.start, samples: new Float32Array(g.len) };
    },
    pop(): void {
      state.segments.shift();
    },
    reset(): void {
      state.resets += 1;
      state.detected = false;
      state.segments = [];
    },
    flush(): void {},
  };
  return { state, vad };
}

function collectEvents() {
  const starts: number[] = [];
  const ends: number[] = [];
  return {
    starts,
    ends,
    events: {
      onSpeechStart(atSec: number): void {
        starts.push(atSec);
      },
      onSpeechEnd(atSec: number): void {
        ends.push(atSec);
      },
    },
  };
}

describe("vad endpointer", () => {
  it("rechunks arbitrary frames into exact 512-sample windows", () => {
    const { state, vad } = makeFake();
    const { events } = collectEvents();
    const ep = createEndpointer("/model.onnx", events, {}, { createVad: () => vad });
    ep.push(Buffer.alloc(1000)); // 500 samples: no full window yet
    assert.equal(state.windows.length, 0);
    ep.push(Buffer.alloc(1064)); // +532 samples: 1032 total -> 2 windows, 8 left
    assert.equal(state.windows.length, 2);
    for (const w of state.windows) assert.equal(w.length, VAD_WINDOW);
    ep.push(Buffer.alloc(1016)); // +508 samples: 516 total -> 1 window, 4 left
    assert.equal(state.windows.length, 3);
  });

  it("converts int16 to float32 and carries odd bytes across pushes", () => {
    const { state, vad } = makeFake();
    const { events } = collectEvents();
    const ep = createEndpointer("/model.onnx", events, {}, { createVad: () => vad });
    const frame = s16le([16384, -32768, 0]);
    ep.push(frame.subarray(0, 3)); // 1 sample + dangling byte
    assert.equal(state.windows.length, 0);
    ep.push(Buffer.concat([frame.subarray(3), Buffer.alloc(VAD_WINDOW * 2 - 6)]));
    assert.equal(state.windows.length, 1);
    const w = state.windows[0] as Float32Array;
    assert.ok(Math.abs(w[0]! - 0.5) < 1e-6);
    assert.ok(Math.abs(w[1]! + 1) < 1e-6);
    assert.equal(w[2], 0);
  });

  it("fires start on detection rise and end with segment bounds", () => {
    const { state, vad } = makeFake();
    const c = collectEvents();
    const ep = createEndpointer("/model.onnx", c.events, {}, { createVad: () => vad });
    ep.push(silenceWindows(2));
    assert.deepEqual(c.starts, []);
    assert.equal(ep.inSpeech, false);
    state.detected = true;
    ep.push(silenceWindows(1)); // 3 windows fed -> clock 3*512/16000
    assert.deepEqual(c.starts, [(3 * VAD_WINDOW) / SR]);
    assert.equal(ep.inSpeech, true);
    const segStart = 2 * VAD_WINDOW;
    state.detected = false;
    state.segments.push({ start: segStart, len: VAD_WINDOW });
    ep.push(silenceWindows(1));
    assert.deepEqual(c.ends, [(segStart + VAD_WINDOW) / SR]);
    assert.equal(ep.inSpeech, false);
  });

  it("passes options through to the Vad config", () => {
    let seen: unknown;
    const { events } = collectEvents();
    createEndpointer("/m.onnx", events, { threshold: 0.7, minSilenceSec: 0.4, minSpeechSec: 0.1, maxSpeechSec: 5 }, {
      createVad: (config: unknown) => {
        seen = config;
        return makeFake().vad;
      },
    });
    assert.deepEqual(seen, {
      sileroVad: {
        model: "/m.onnx",
        threshold: 0.7,
        minSilenceDuration: 0.4,
        minSpeechDuration: 0.1,
        windowSize: 512,
        maxSpeechDuration: 5,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: "cpu",
    });
  });

  it("reset clears the audio clock and detector state", () => {
    const { state, vad } = makeFake();
    const c = collectEvents();
    const ep = createEndpointer("/model.onnx", c.events, {}, { createVad: () => vad });
    state.detected = true;
    ep.push(silenceWindows(2));
    assert.deepEqual(c.starts, [VAD_WINDOW / SR]);
    ep.reset();
    assert.equal(ep.inSpeech, false);
    assert.equal(state.resets, 1);
    state.detected = true;
    ep.push(silenceWindows(1));
    assert.deepEqual(c.starts, [VAD_WINDOW / SR, VAD_WINDOW / SR]);
  });

  it("close is idempotent and push after close is a no-op", () => {
    const { state, vad } = makeFake();
    const c = collectEvents();
    const ep = createEndpointer("/model.onnx", c.events, {}, { createVad: () => vad });
    ep.push(silenceWindows(1));
    assert.equal(state.windows.length, 1);
    ep.close();
    ep.close();
    state.detected = true;
    ep.push(silenceWindows(4));
    assert.equal(state.windows.length, 1);
    assert.deepEqual(c.starts, []);
  });

  it("drains multiple queued segments with bounded memory", () => {
    const { state, vad } = makeFake();
    const c = collectEvents();
    const ep = createEndpointer("/model.onnx", c.events, {}, { createVad: () => vad });
    state.detected = true;
    state.segments.push({ start: 0, len: VAD_WINDOW }, { start: VAD_WINDOW, len: VAD_WINDOW });
    state.detected = false;
    ep.push(silenceWindows(1));
    assert.deepEqual(c.ends, [VAD_WINDOW / SR, (2 * VAD_WINDOW) / SR]);
    assert.equal(state.segments.length, 0);
  });
});
