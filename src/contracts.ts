/** Shared contracts for pi-voice (lane A foundation). */

/** Persisted user preferences (schema version 1). */
export type VoicePreferences = {
  version: 1;
  voiceId?: string;
  ttsModel?: string;
  wake: "hey-pi" | "hi-pi" | "both";
  sensitivity: "low" | "normal" | "high";
  mic: { kind: "default" } | { kind: "named"; name: string };
  autostart: boolean;
  tts: boolean;
};

export const DEFAULT_PREFERENCES: VoicePreferences = {
  version: 1,
  ttsModel: "eleven_v4_turbo",
  wake: "both",
  sensitivity: "normal",
  mic: { kind: "default" },
  autostart: true,
  tts: false,
};

/** Session-scoped voice pipeline phase. */
export type VoicePhase = "off" | "preparing" | "wake" | "capture" | "submit" | "speaking";

/** Classified failure surfaced to status/UI. */
export type VoiceFailure = {
  code: "key_missing" | "model" | "mic" | "auth" | "quota" | "rate" | "network" | "audio" | "protocol";
  message: string;
  retryable: boolean;
};

export interface Disposable {
  close(): Promise<void>;
}

/**
 * One PCM audio frame: signed 16-bit LE, mono, 16 kHz.
 * Even byte length required; chunk boundaries arbitrary.
 */
export type PcmFrame = Buffer;

/**
 * Audio input. Contract: emits 16-kHz mono s16le PCM via onPcm;
 * chunk boundaries arbitrary. Session-scoped; stop() is idempotent.
 */
export interface AudioSource {
  start(onPcm: (chunk: Buffer) => void, onError: (error: Error) => void): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Audio output. Contract: accepts 24-kHz mono s16le PCM.
 * write() is backpressure-aware and ordered; finish() drains a
 * normal response; stop() cancels immediately (barge-in).
 */
export interface AudioSink {
  start(format: { sampleRate: 24000; channels: 1; encoding: "s16le" }): Promise<void>;
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<void>;
  stop(): Promise<void>;
}

/** AVFoundation microphone device (name-based selection; index is display-only). */
export type MicDevice = {
  name: string;
  index: number;
};

/** Absolute paths to the provisioned on-disk wake model files. */
export type ModelPaths = {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
  keywordsFile: string;
};
