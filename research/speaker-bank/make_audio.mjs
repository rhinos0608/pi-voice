// Generate the full audio corpus: `say` synth per (voice, sentence), then
// ffmpeg corner transforms. One wav per utterance; manifest to tmp/manifest.json.
// Usage: node make_audio.mjs [--voices Samantha,Karen,Moira,Daniel]
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSentences, mixFileWithPinkNoise, wavToFloat } from "./audio_util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "tmp");
const WAV = join(TMP, "wav");
const RAW = join(TMP, "raw");
const FF = "/opt/miniconda3/bin/ffmpeg";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"];
  }),
);
const VOICES = (args.voices ?? "Samantha,Karen,Moira,Daniel").split(",");
const CONC = 8;

const CORNERS = ["clean", "phone", "muffled", "noisy", "fast", "slow", "pitchup", "pitchdown", "combo"];
const RATE = { fast: 250, slow: 130, combo: 130 };
const FILTER = {
  phone: "highpass=f=300,lowpass=f=3400,aresample=8000,aresample=16000",
  muffled: "lowpass=f=2000,aecho=0.8:0.7:50:0.25",
  pitchup: "asetrate=17920,aresample=16000,atempo=0.8909",
  pitchdown: "asetrate=14254,aresample=16000,atempo=1.12246",
  combo: "lowpass=f=2000",
};

function run(cmd, argv) {
  return new Promise((res, rej) => execFile(cmd, argv, (e, stdout, stderr) => (e ? rej(new Error(`${cmd} ${argv.join(" ")}: ${stderr}`.slice(0, 400))) : res(stdout))));
}

// Splits use disjoint sentence pools: enroll S[0:5], stream S[5:305],
// test S[305:359] (6 per corner x 9), impostor-probe S[359:371] (12).
const SENT = buildSentences(371);
const POOL = { enroll: SENT.slice(0, 5), stream: SENT.slice(5, 305), test: SENT.slice(305, 359), probe: SENT.slice(359, 371) };

// Skewed usage mix over 300 stream items: 60/10/10/7/3/3/2/2/3 %.
const MIX = [["clean", 180], ["phone", 30], ["noisy", 30], ["muffled", 21], ["fast", 9], ["slow", 9], ["pitchup", 6], ["pitchdown", 6], ["combo", 9]];
const streamCorners = MIX.flatMap(([c, n]) => Array(n).fill(c));
const testCorners = CORNERS.flatMap((c) => Array(6).fill(c)); // 54

const jobs = []; // {voice, split, idx, corner, sentence, out}
for (const voice of VOICES) {
  POOL.enroll.forEach((sentence, idx) => jobs.push({ voice, split: "enroll", idx, corner: "clean", sentence, out: `${voice}_enroll_${idx}_clean.wav` }));
  POOL.stream.forEach((sentence, idx) => jobs.push({ voice, split: "stream", idx, corner: streamCorners[idx], sentence, out: `${voice}_stream_${idx}_${streamCorners[idx]}.wav` }));
  POOL.test.forEach((sentence, k) => { const corner = testCorners[k]; jobs.push({ voice, split: "test", idx: k, corner, sentence, out: `${voice}_test_${k}_${corner}.wav` }); });
  POOL.probe.forEach((sentence, idx) => {
    jobs.push({ voice, split: "probe", idx, corner: "clean", sentence, out: `${voice}_probe_${idx}_clean.wav` });
    for (const corner of ["phone", "noisy"]) jobs.push({ voice, split: "probe", idx, corner, sentence, out: `${voice}_probe_${idx}_${corner}.wav` });
  });
}

async function one(j, tag) {
  const raw = join(RAW, `${tag}.aiff`);
  const sayArgs = ["-v", j.voice, "-o", raw, j.sentence];
  if (RATE[j.corner]) sayArgs.splice(1, 0, "-r", String(RATE[j.corner]));
  await run("say", sayArgs);
  const out = join(WAV, j.out);
  const conv = ["-y", "-v", "error", "-i", raw];
  if (FILTER[j.corner]) conv.push("-af", FILTER[j.corner]);
  conv.push("-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out);
  await run(FF, conv);
  let snr = null;
  if (j.corner === "noisy" || j.corner === "combo") snr = await mixFileWithPinkNoise(out, 10, 7000 + tag.length * 13 + j.idx * 7919);
  const ms = Math.round((wavToFloat(await readFile(out)).length / 16000) * 1000);
  return { ...j, wav: join("tmp", "wav", j.out), ms, snrDb: snr === null ? undefined : +snr.toFixed(2) };
}

await mkdir(WAV, { recursive: true });
await mkdir(RAW, { recursive: true });
const manifest = new Array(jobs.length);
let done = 0;
const workers = Array.from({ length: CONC }, async (_, w) => {
  for (let i = w; i < jobs.length; i += CONC) {
    manifest[i] = await one(jobs[i], `u${i}`);
    if (++done % 100 === 0) console.log(`  ${done}/${jobs.length} utterances`);
  }
});
// Sequential tag counter would collide across workers, so preassign tags.
await Promise.all(workers);
await writeFile(join(TMP, "manifest.json"), JSON.stringify({ voices: VOICES, pools: { enroll: 5, stream: 300, test: 54, probe: 12 }, manifest }, null, 1));
await rm(RAW, { recursive: true, force: true });
const short = manifest.filter((m) => m.ms < 2000).length;
console.log(`done: ${manifest.length} wavs, ${short} under 2000ms (too-short for learning)`);
