/** Shared contracts for pi-voice (lane A foundation). */

/** TTS provider: Inworld (default) or ElevenLabs. STT is always ElevenLabs. */
export type TtsProvider = "inworld" | "elevenlabs";

/** Persisted user preferences (schema version 1). */
export type VoicePreferences = {
  version: 1;
  /** Active TTS provider (default "inworld"). */
  ttsProvider: TtsProvider;
  /** ElevenLabs voice id (ElevenLabs provider only). */
  voiceId?: string;
  /** ElevenLabs TTS model id. */
  ttsModel?: string;
  /** Inworld voice id (display name like "Ashley"); default applies when unset. */
  inworldVoiceId?: string;
  /** Inworld TTS model id; default applies when unset. */
  inworldModel?: string;
  wake: "hey-pi" | "hi-pi" | "both";
  sensitivity: "low" | "normal" | "high";
  mic: { kind: "default" } | { kind: "named"; name: string };
  autostart: boolean;
  tts: boolean;
  /** auto: submit transcripts immediately; review: paste into the editor, submit on Enter or "send to pi". */
  sendMode: "auto" | "review";
  /** Voice-isolation helper (echo cancellation, noise suppression, AGC). Default on when built. */
  isolation: boolean;
  /** Owner-voice check strictness. Effective only when a speaker profile is enrolled. Off by default (experimental opt-in). */
  speakerCheck: "off" | "low" | "normal" | "high";
  /** Learn the owner voice from accepted+submitted utterances. Default on. */
  speakerLearn: boolean;
  /** Push-to-talk combo text (e.g. "ctrl+option+space") or "off". */
  pushToTalk: string;
};

export const DEFAULT_PREFERENCES: VoicePreferences = {
  version: 1,
  ttsProvider: "inworld",
  ttsModel: "eleven_flash_v2_5",
  wake: "both",
  sensitivity: "normal",
  mic: { kind: "default" },
  autostart: true,
  tts: false,
  sendMode: "auto",
  isolation: true,
  speakerCheck: "off",
  speakerLearn: true,
  // Must match DEFAULT_PUSH_TO_TALK in src/hotkey.ts (kept literal to avoid a dependency).
  pushToTalk: "ctrl+option+space",
};

/** Threshold offset applied to profile.suggestedThreshold per strictness level. */
export const SPEAKER_CHECK_OFFSETS: Record<VoicePreferences["speakerCheck"], number> = {
  off: 0,
  low: -0.05,
  normal: 0,
  high: 0.05,
};

/** Effective accept threshold for a strictness level over a profile suggestion. */
export function speakerThresholdFor(suggested: number, level: VoicePreferences["speakerCheck"]): number {
  return suggested + (SPEAKER_CHECK_OFFSETS[level] ?? 0);
}

/** Session-scoped voice pipeline phase. */
export type VoicePhase = "off" | "preparing" | "wake" | "capture" | "submit" | "speaking";

/** Classified failure surfaced to status/UI. */
export type VoiceFailure = {
  code: "key_missing" | "model" | "mic" | "auth" | "quota" | "rate" | "network" | "audio" | "protocol" | "terms";
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
