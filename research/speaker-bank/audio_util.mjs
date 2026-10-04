// Shared helpers: seeded RNG, sentence pool, wav IO, pink noise @ fixed SNR.
import { readFile, writeFile } from "node:fs/promises";

export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ADJ = ["quiet", "bright", "hollow", "patient", "restless", "gentle", "steady", "distant", "eager", "calm", "rough", "silver"];
const NOUN = ["harbor", "station", "garden", "bridge", "market", "window", "river", "tower", "kitchen", "valley", "library", "meadow"];
const VERB = ["waited", "gathered", "returned", "lingered", "crossed", "settled", "wandered", "listened", "rested", "traveled"];
const PLACE = ["harbor wall", "north platform", "old orchard", "stone bridge", "night market", "back porch", "river bend", "clock tower"];
const EXTRA = ["while the kettle sang softly", "as the rain kept time", "before the lights came on", "after the last train left", "while the dog slept soundly", "as the fog began to lift"];
const NUMW = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

// ~12-18 words each so clips comfortably exceed the 2000 ms learn minimum.
export function buildSentences(count, seed = 20261004) {
  const rnd = lcg(seed);
  const out = new Set();
  let guard = 0;
  while (out.size < count && guard++ < count * 50) {
    const a = ADJ[(rnd() * ADJ.length) | 0];
    const n = NOUN[(rnd() * NOUN.length) | 0];
    const v = VERB[(rnd() * VERB.length) | 0];
    const p = PLACE[(rnd() * PLACE.length) | 0];
    const e = EXTRA[(rnd() * EXTRA.length) | 0];
    const k = NUMW[(rnd() * NUMW.length) | 0];
    const n2 = NOUN[(rnd() * NOUN.length) | 0];
    const t = (rnd() * 6) | 0;
    let s;
    if (t === 0) s = `The ${a} ${n} near the ${p} ${v} ${e}, counting slowly to ${k}.`;
    else if (t === 1) s = `We ${v} past the ${a} ${n} by the ${p} ${e}, all ${k} of us together.`;
    else if (t === 2) s = `She kept a small ${n} on the shelf, and it ${v} there ${e} for ${k} long years.`;
    else if (t === 3) s = `Beyond the ${p}, the ${a} ${n2} ${v} ${e} exactly ${k} times.`;
    else if (t === 4) s = `He described the ${a} ${n} in detail, how it ${v} beside the ${p} ${e}.`;
    else s = `Every morning the ${n} ${v} toward the ${p}, and the ${a} ${n2} followed ${k} steps behind.`;
    out.add(s);
  }
  if (out.size < count) throw new Error(`sentence generator stalled at ${out.size}/${count}`);
  return [...out];
}

// Minimal 16-bit mono wav IO (assumes canonical 44-byte header on read).
export function wavToFloat(buf) {
  const data = buf.subarray(44);
  const n = data.length / 2;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = data.readInt16LE(i * 2) / 32768;
  return f;
}

export function floatToWavBuf(f, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + f.length * 2, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(f.length * 2, 40);
  const pcm = Buffer.alloc(f.length * 2);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return Buffer.concat([h, pcm]);
}

// Paul Kellet pink noise, scaled so 20*log10(rmsSpeech/rmsNoise) == snrDb.
export function addPinkNoise(speech, snrDb, seed) {
  const rnd = lcg(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const noise = new Float32Array(speech.length);
  for (let i = 0; i < speech.length; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    noise[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length) || 1e-9;
  const g = rms(speech) / (rms(noise) * 10 ** (snrDb / 20));
  const out = new Float32Array(speech.length);
  for (let i = 0; i < out.length; i++) out[i] = speech[i] + noise[i] * g;
  return { mixed: out, actualSnrDb: 20 * Math.log10(rms(speech) / (rms(noise) * g)) };
}

export async function mixFileWithPinkNoise(path, snrDb, seed) {
  const f = wavToFloat(await readFile(path));
  const { mixed, actualSnrDb } = addPinkNoise(f, snrDb, seed);
  await writeFile(path, floatToWavBuf(mixed));
  return actualSnrDb;
}
