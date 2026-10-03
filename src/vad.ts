import { createRequire } from "node:module";

export const VAD_WINDOW = 512;
const VAD_SAMPLE_RATE = 16000;

export type EndpointerEvents = { onSpeechStart(atSec: number): void; onSpeechEnd(atSec: number): void };
export type EndpointerOptions = {
  threshold?: number;
  minSilenceSec?: number;
  minSpeechSec?: number;
  maxSpeechSec?: number;
};
export type VadLike = {
  acceptWaveform(s: Float32Array): void;
  isEmpty(): boolean;
  isDetected(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  reset(): void;
  flush(): void;
};
export type EndpointerDeps = { createVad?: (config: unknown, bufferSizeInSeconds: number) => VadLike };
export type Endpointer = { push(frame: Buffer): void; reset(): void; close(): void; readonly inSpeech: boolean };

function defaultCreateVad(config: unknown, bufferSizeInSeconds: number): VadLike {
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Vad } = req("sherpa-onnx-node") as {
    Vad: new (config: unknown, bufferSizeInSeconds: number) => VadLike;
  };
  return new Vad(config, bufferSizeInSeconds);
}

/**
 * Local end-of-speech detection over 16 kHz s16le frames. Live-verified
 * 2026-10-03: sherpa-onnx Vad.isDetected() is a live signal — it goes true
 * ~0.38 s after true speech onset (while speech is ongoing) and false
 * ~minSilenceDuration after true offset, at which point the completed
 * segment is available via front()/pop(). So onSpeechStart fires on the
 * false→true transition and onSpeechEnd when the segment pops.
 *
 * Sherpa-onnx aborts natively on any windowSize other than 512, so input
 * is rechunked internally into exact 512-sample windows (leftover bytes
 * and samples carried across push calls).
 */
export function createEndpointer(
  modelPath: string,
  events: EndpointerEvents,
  opts?: EndpointerOptions,
  deps?: EndpointerDeps,
): Endpointer {
  const vad = (deps?.createVad ?? defaultCreateVad)(
    {
      sileroVad: {
        model: modelPath,
        threshold: opts?.threshold ?? 0.5,
        minSilenceDuration: opts?.minSilenceSec ?? 0.8,
        minSpeechDuration: opts?.minSpeechSec ?? 0.25,
        windowSize: VAD_WINDOW,
        maxSpeechDuration: opts?.maxSpeechSec ?? 30,
      },
      sampleRate: VAD_SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
    },
    60,
  );

  let pendingByte: number | undefined;
  let carry = new Float32Array(0);
  let fedSamples = 0;
  let speech = false;
  let closed = false;

  function clockSec(): number {
    return fedSamples / VAD_SAMPLE_RATE;
  }

  function drain(): void {
    if (vad.isDetected() && !speech) {
      speech = true;
      events.onSpeechStart(clockSec());
    }
    while (!vad.isEmpty()) {
      const seg = vad.front();
      vad.pop();
      speech = false;
      events.onSpeechEnd((seg.start + seg.samples.length) / VAD_SAMPLE_RATE);
    }
    if (vad.isDetected() && !speech) {
      speech = true;
      events.onSpeechStart(clockSec());
    }
  }

  function feedWindow(window: Float32Array): void {
    vad.acceptWaveform(window);
    fedSamples += VAD_WINDOW;
    drain();
  }

  return {
    get inSpeech(): boolean {
      return speech;
    },
    push(frame: Buffer): void {
      if (closed || frame.length === 0) return;
      let off = 0;
      if (pendingByte !== undefined && frame.length > 0) {
        const sample = pendingByte | (frame[0]! << 8);
        const signed = sample >= 0x8000 ? sample - 0x10000 : sample;
        const grown = new Float32Array(carry.length + 1);
        grown.set(carry);
        grown[carry.length] = signed / 32768;
        carry = grown;
        pendingByte = undefined;
        off = 1;
      }
      const rest = frame.length - off;
      const whole = Math.floor(rest / 2);
      if (whole > 0) {
        const grown = new Float32Array(carry.length + whole);
        grown.set(carry);
        for (let i = 0; i < whole; i++) {
          grown[carry.length + i] = frame.readInt16LE(off + i * 2) / 32768;
        }
        carry = grown;
        off += whole * 2;
      }
      if (off < frame.length) pendingByte = frame[frame.length - 1];
      while (carry.length >= VAD_WINDOW) {
        feedWindow(carry.subarray(0, VAD_WINDOW));
        carry = carry.slice(VAD_WINDOW);
      }
    },
    reset(): void {
      pendingByte = undefined;
      carry = new Float32Array(0);
      fedSamples = 0;
      speech = false;
      if (!closed) vad.reset();
    },
    close(): void {
      if (closed) return;
      closed = true;
    },
  };
}
