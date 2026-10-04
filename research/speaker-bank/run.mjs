// Sweep learned-bank capacity: enroll 5 clean clips, stream ~300 owner
// utterances (+12 most-similar-voice impostor probes) through score+adapt,
// then evaluate held-out tests at thr, thr±0.05. Writes results.json + results.md.
// Usage: node run.mjs [--caps 0,16,40,64,128,256]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adaptProfile, buildProfile, scoreSample } from "../../src/speaker.ts";
import { speakerModelCachedPath } from "../../src/model.ts";
import { createSpeakerEmbedder } from "../../src/speaker.ts";
import { lcg, wavToFloat } from "./audio_util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "tmp");
const capArg = (process.argv.find((a) => a.startsWith("--caps=")) ?? "--caps=0,16,40,64,128,256").split("=")[1];
const CAPS = capArg.split(",").map(Number);

const { voices: VOICES, manifest } = JSON.parse(await readFile(join(TMP, "manifest.json"), "utf8"));
const byKey = new Map(manifest.map((m) => [`${m.voice}/${m.split}/${m.idx}/${m.corner}`, m]));
const get = (v, s, i, c) => byKey.get(`${v}/${s}/${i}/${c}`);

// --- embeddings (cached) ---
let embCache = {};
try { embCache = JSON.parse(await readFile(join(TMP, "embeddings.json"), "utf8")); console.log(`loaded ${Object.keys(embCache).length} cached embeddings`); } catch { /* fresh */ }
const modelPath = speakerModelCachedPath();
if (!modelPath) throw new Error("speaker model not cached; run ensureSpeakerModel first");
const embedder = createSpeakerEmbedder(modelPath);
const missing = manifest.filter((m) => !embCache[m.wav]);
console.log(`embedding ${missing.length} wavs...`);
for (let i = 0; i < missing.length; i++) {
  const m = missing[i];
  const pcm = await readFile(join(HERE, m.wav));
  embCache[m.wav] = Array.from(embedder.embed(pcm));
  if (i % 200 === 0) console.log(`  ${i}/${missing.length}`);
}
await writeFile(join(TMP, "embeddings.json"), JSON.stringify(embCache));
const E = (m) => Float32Array.from(embCache[m.wav]);

const CORNERS = ["clean", "phone", "muffled", "noisy", "fast", "slow", "pitchup", "pitchdown", "combo"];
const streamItems = (voice) => manifest.filter((m) => m.voice === voice && m.split === "stream");

// Most-similar impostor voice per owner, from enrollment centroids.
const enrollProfile = {};
for (const v of VOICES) {
  const clips = manifest.filter((m) => m.voice === v && m.split === "enroll").map(E);
  enrollProfile[v] = buildProfile(clips, "campplus");
}
const rival = {};
for (const v of VOICES) {
  let best = null, bestScore = -1;
  for (const w of VOICES) {
    if (w === v) continue;
    const s = manifest.filter((m) => m.voice === w && m.split === "enroll").map((m) => scoreSample(enrollProfile[v], E(m)));
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    if (mean > bestScore) { bestScore = mean; best = w; }
  }
  rival[v] = { voice: best, enrollMean: +bestScore.toFixed(3) };
}

// Stream order: 300 owner items (seeded shuffle) + 12 rival-voice probes interleaved.
function streamOrder(voice, seed) {
  const rnd = lcg(seed);
  const owner = streamItems(voice).map((m) => ({ m, owner: true }));
  for (let i = owner.length - 1; i > 0; i--) { const j = (rnd() * (i + 1)) | 0;[owner[i], owner[j]] = [owner[j], owner[i]]; }
  const probes = [];
  for (let k = 0; k < 12; k++) {
    const corner = k < 6 ? "clean" : k < 9 ? "phone" : "noisy";
    probes.push({ m: get(rival[voice].voice, "probe", k, corner), owner: false });
  }
  const out = [...owner];
  probes.forEach((p, k) => out.splice(Math.min(out.length, ((k + 1) * 25) | 0), 0, p));
  return out;
}

const results = { voices: VOICES, caps: CAPS, rival, perOwner: {} };

for (const voice of VOICES) {
  const order = streamOrder(voice, 1000 + VOICES.indexOf(voice));
  const ownerRec = { enrollThreshold: +enrollProfile[voice].suggestedThreshold.toFixed(3), caps: {} };
  for (const cap of CAPS) {
    const cfg = { maxLearned: cap };
    let p = enrollProfile[voice];
    const at2corner = new Map();
    let learnedEvents = 0, probeAdmitted = 0, probeLearned = 0;
    const reasons = {};
    const traj = [{ step: 0, thr: +p.suggestedThreshold.toFixed(3), learned: 0 }];
    let n = 0;
    for (const [k, it] of order.entries()) {
      const emb = E(it.m);
      const score = scoreSample(p, emb);
      const thr = p.suggestedThreshold;
      const accepted = score >= thr;
      if (!it.owner && accepted) probeAdmitted++;
      let adapted = false, reason = "skipped";
      if (cap > 0) {
        const r = adaptProfile(p, { embedding: emb, score, speechMs: it.m.ms, threshold: thr }, new Date(Date.UTC(2026, 9, 4, 0, 0, n++)), cfg);
        p = r.profile; adapted = r.adapted; reason = r.reason;
      }
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      // Track bank membership via unique timestamps.
      for (const s of p.learned ?? []) if (!at2corner.has(s.at)) at2corner.set(s.at, it.owner ? it.m.corner : `IMPOSTOR(${it.m.voice}/${it.m.corner})`);
      if (adapted) { learnedEvents++; if (!it.owner) probeLearned++; }
      if ((k + 1) % 25 === 0 || k === order.length - 1) traj.push({ step: k + 1, thr: +p.suggestedThreshold.toFixed(3), learned: p.learned?.length ?? 0 });
    }
    // Bank composition by corner.
    const bank = {};
    for (const s of p.learned ?? []) bank[at2corner.get(s.at) ?? "?"] = (bank[at2corner.get(s.at) ?? "?"] ?? 0) + 1;

    // Held-out evaluation at final thr, thr±0.05.
    const evalAt = (thr) => {
      const owner = {};
      for (const c of CORNERS) {
        const clips = manifest.filter((m) => m.voice === voice && m.split === "test" && m.corner === c);
        owner[c] = +((clips.filter((m) => scoreSample(p, E(m)) >= thr).length / clips.length).toFixed(3));
      }
      const impClips = manifest.filter((m) => m.voice !== voice && m.split === "test");
      const impByVoice = {};
      for (const w of VOICES) {
        if (w === voice) continue;
        const clips = impClips.filter((m) => m.voice === w);
        impByVoice[w] = +((clips.filter((m) => scoreSample(p, E(m)) >= thr).length / clips.length).toFixed(3));
      }
      const far = impClips.filter((m) => scoreSample(p, E(m)) >= thr).length / impClips.length;
      return { owner, impostor: +far.toFixed(3), impostorByVoice: impByVoice };
    };
    const t0 = p.suggestedThreshold;
    ownerRec.caps[cap] = {
      finalThreshold: +t0.toFixed(3),
      learnedEvents, bankSize: p.learned?.length ?? 0, bank,
      reasons, probeAdmitted, probeLearned,
      traj,
      atMinus: evalAt(t0 - 0.05), atThr: evalAt(t0), atPlus: evalAt(t0 + 0.05),
    };
    console.log(`${voice} cap=${cap}: thr ${ownerRec.caps[cap].finalThreshold} bank=${p.learned?.length ?? 0} probes admitted/learned=${probeAdmitted}/${probeLearned}`);
  }
  results.perOwner[voice] = ownerRec;
}
await writeFile(join(TMP, "results.json"), JSON.stringify(results, null, 1));

// --- markdown report ---
const pct = (x) => `${(x * 100).toFixed(1)}%`;
let md = `# Speaker learned-bank capacity calibration\n\n`;
md += `Owners: ${VOICES.join(", ")} (macOS \`say\` voices). Impostors per owner: the other three voices. `;
md += `Most-similar rival (mean enroll-clip cosine vs owner centroid): ${VOICES.map((v) => `${v}→${rival[v].voice} (${rival[v].enrollMean})`).join(", ")}.\n\n`;
md += `Method: enroll from 5 clean clips (\`buildProfile\`); usage stream of 300 owner utterances (60% clean, 10% phone, 10% noisy, 7% muffled, 3% fast, 3% slow, 2% pitch-up, 2% pitch-down, 3% combo) plus 12 rival-voice impostor probes, all through the real admission path (\`scoreSample\` vs live \`suggestedThreshold\`, then \`adaptProfile\` with \`{maxLearned: cap}\`). Held-out test: 6 clips per corner per owner (54) plus all other voices' test clips as impostors (162). Scores at the final profile's own threshold, and ±0.05. Sentences are disjoint across enroll/stream/test/probe pools. Run: \`node make_audio.mjs && node run.mjs\` from this directory (Node ≥25, ffmpeg at /opt/miniconda3/bin/ffmpeg). Audio kept under \`tmp/\`.\n\n`;
md += `Enroll thresholds: ${VOICES.map((v) => `${v}=${results.perOwner[v].enrollThreshold}`).join(", ")}.\n\n`;
md += `## Owner acceptance per corner at own threshold (atThr)\n\n`;
md += `| owner | cap | ${CORNERS.join(" | ")} |\n|---|---|${CORNERS.map(() => "---").join("|")}|\n`;
for (const v of VOICES) for (const cap of CAPS) {
  const e = results.perOwner[v].caps[cap].atThr.owner;
  md += `| ${v} | ${cap} | ${CORNERS.map((c) => pct(e[c])).join(" | ")} |\n`;
}
md += `\n## Impostor acceptance (FAR) at own threshold, and ±0.05\n\n`;
md += `| owner | cap | FAR(-0.05) | FAR(thr) | FAR(+0.05) | FAR by voice @thr |\n|---|---|---|---|---|---|\n`;
for (const v of VOICES) for (const cap of CAPS) {
  const c = results.perOwner[v].caps[cap];
  md += `| ${v} | ${cap} | ${pct(c.atMinus.impostor)} | ${pct(c.atThr.impostor)} | ${pct(c.atPlus.impostor)} | ${Object.entries(c.atThr.impostorByVoice).map(([w, f]) => `${w}=${pct(f)}`).join(", ")} |\n`;
}
md += `\n## Bank composition (learned-sample corner counts) and threshold trajectory\n\n`;
for (const v of VOICES) {
  md += `### ${v} (enroll thr ${results.perOwner[v].enrollThreshold}, rival ${rival[v].voice})\n\n`;
  md += `| cap | final thr | bank | learned events | composition | adapt reasons | probes admitted/learned |\n|---|---|---|---|---|---|---|\n`;
  for (const cap of CAPS) {
    const c = results.perOwner[v].caps[cap];
    md += `| ${cap} | ${c.finalThreshold} | ${c.bankSize} | ${c.learnedEvents} | ${JSON.stringify(c.bank)} | ${JSON.stringify(c.reasons)} | ${c.probeAdmitted}/${c.probeLearned} |\n`;
  }
  md += `\nTrajectory (step: thr / bank):\n\n`;
  for (const cap of CAPS) {
    const c = results.perOwner[v].caps[cap];
    md += `- cap ${cap}: ${c.traj.map((t) => `${t.step}:${t.thr}/${t.learned}`).join(" ")}\n`;
  }
  md += `\n`;
}
md += `## Recommendation\n\n<!-- filled after reviewing the numbers -->\n\n## Failure modes observed\n\n<!-- filled after reviewing the numbers -->\n\n## Caveats\n\n- All voices are synthetic (\`say\` output from a single TTS pipeline); earlier calibration showed same-voice held-out cosines (0.789–0.871) overlapping cross-voice (0.558–0.807), so absolute thresholds do NOT transfer to real human voices. Re-calibrate on real enrollment audio.\n- Fixed 10 dB pink-noise SNR, single phone/muffle recipes, ±2-semitone pitch: real rooms, mics, codecs, and colds vary more widely.\n- The 300-utterance stream compresses weeks of use into one session with no speaker drift over time; eviction/diversity behaviour under long-term drift was not tested.\n- Impostor probes are the single most-similar synthetic voice, not a dedicated mimic or replay attack.\n`;
await writeFile(join(HERE, "results.md"), md);
console.log("wrote results.md + tmp/results.json");
