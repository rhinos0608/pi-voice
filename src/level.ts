/** PCM level analysis and metering for 16-kHz mono s16le capture. */

export type PcmStats = {
  samples: number;
  rmsDbfs: number;
  peakDbfs: number;
  allZero: boolean;
};

const FLOOR_DBFS = -100;
const FULL_SCALE = 32768;

function sampleToDbfs(magnitude: number): number {
  if (magnitude <= 0) return FLOOR_DBFS;
  const db = 20 * Math.log10(magnitude / FULL_SCALE);
  return Math.max(db, FLOOR_DBFS);
}

/** Analyze one s16le mono frame. Odd trailing bytes are ignored. Silence floors at -100 dBFS. */
export function analyzePcm(buf: Buffer): PcmStats {
  const samples = Math.floor(buf.length / 2);
  if (samples === 0) {
    return { samples: 0, rmsDbfs: FLOOR_DBFS, peakDbfs: FLOOR_DBFS, allZero: true };
  }
  let sumSquares = 0;
  let peak = 0;
  let allZero = true;
  for (let i = 0; i < samples; i++) {
    const sample = buf.readInt16LE(i * 2);
    if (sample !== 0) allZero = false;
    const magnitude = Math.abs(sample) / FULL_SCALE;
    sumSquares += magnitude * magnitude;
    if (Math.abs(sample) > peak) peak = Math.abs(sample);
  }
  const rms = Math.sqrt(sumSquares / samples);
  return {
    samples,
    rmsDbfs: sampleToDbfs(rms * FULL_SCALE),
    peakDbfs: sampleToDbfs(peak),
    allZero,
  };
}

export type CaptureHealth = "ok" | "silent-zero" | "very-quiet";

/** Classify capture health: all-zero frames mean permission is likely denied; peak below -50 dBFS is very quiet. */
export function classifyCapture(s: PcmStats): CaptureHealth {
  if (s.allZero) return "silent-zero";
  if (s.peakDbfs < -50) return "very-quiet";
  return "ok";
}

const SMOOTHING_WINDOW_MS = 150;
const FRAME_MS_AT_16K = 10;

export class LevelMeter {
  private smoothed: number = FLOOR_DBFS;
  private initialized = false;
  private readonly alpha: number;

  constructor(windowMs: number = SMOOTHING_WINDOW_MS) {
    const frames = Math.max(1, Math.round(windowMs / FRAME_MS_AT_16K));
    this.alpha = 1 / frames;
  }

  push(frame: Buffer): void {
    const stats = analyzePcm(frame);
    const target = Math.max(stats.rmsDbfs, FLOOR_DBFS);
    if (!this.initialized) {
      this.smoothed = target;
      this.initialized = true;
      return;
    }
    this.smoothed += this.alpha * (target - this.smoothed);
  }

  get db(): number {
    return this.smoothed;
  }

  reset(): void {
    this.smoothed = FLOOR_DBFS;
    this.initialized = false;
  }
}

const METER_MIN_DB = -60;
const METER_MAX_DB = -10;
const METER_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇"] as const;

/** Map -60..-10 dBFS onto block glyphs ▁▂▃▄▅▆▇. Output is exactly `width` glyphs. */
export function meterBar(db: number, width = 3): string {
  const clamped = Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, db));
  const ratio = (clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB);
  const index = Math.min(METER_GLYPHS.length - 1, Math.floor(ratio * METER_GLYPHS.length));
  const glyph = METER_GLYPHS[index] ?? METER_GLYPHS[0];
  return glyph.repeat(Math.max(0, width));
}
