// score.mjs — WER + technical-term accuracy per engine x voice x clean/noisy.
// Usage: node score.mjs   (reads corpus.json, apple_results.jsonl, elevenlabs_results.jsonl)
// Writes score.json and prints a summary table.
import { readFileSync, writeFileSync } from 'node:fs';

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

function wer(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean);
  const h = norm(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (r[i-1] === h[j-1] ? 0 : 1));
  return { wer: r.length ? d[r.length][h.length] / r.length : (h.length ? 1 : 0), nRef: r.length, nErr: d[r.length][h.length] };
}

const corpus = JSON.parse(readFileSync('corpus.json', 'utf8'));
const refOf = Object.fromEntries(corpus.utterances.map(u => [u.id, u]));
const techOf = id => refOf[id].tech.map(t => norm(t)).flatMap(t => t.split(' '));

const rows = [];
for (const line of readFileSync('apple_results.jsonl', 'utf8').trim().split('\n')) {
  const d = JSON.parse(line);
  if (d.error) { rows.push({ ...d, wer: null }); continue; }
  const m = d.file.match(/(u\d+)_(samantha|daniel)(_noisy)?\.wav/);
  const id = m[1], voice = m[2], cond = m[3] ? 'noisy' : 'clean';
  const { wer: w } = wer(refOf[id].text, d.text);
  const tech = techOf(id);
  const hypWords = new Set(norm(d.text).split(' '));
  const hit = tech.filter(t => hypWords.has(t)).length;
  rows.push({ engine: `apple:${d.variant}`, mode: d.mode, id, voice, cond, wer: w,
              techHit: hit, techN: tech.length, text: d.text,
              wall_s: d.wall_s, eoa: d.eoa_to_final_s ?? null });
}
for (const line of readFileSync('elevenlabs_results.jsonl', 'utf8').trim().split('\n')) {
  const d = JSON.parse(line);
  if (d.error || !d.text) { rows.push({ ...d, engine: 'elevenlabs:scribe_v2', wer: null }); continue; }
  const m = d.file.match(/(u\d+)_(samantha|daniel)(_noisy)?\.wav/);
  const id = m[1], voice = m[2], cond = m[3] ? 'noisy' : 'clean';
  const { wer: w } = wer(refOf[id].text, d.text);
  const tech = techOf(id);
  const hypWords = new Set(norm(d.text).split(' '));
  const hit = tech.filter(t => hypWords.has(t)).length;
  rows.push({ engine: 'elevenlabs:scribe_v2', mode: 'batch', id, voice, cond, wer: w,
              techHit: hit, techN: tech.length, text: d.text, wall_s: d.latency_s, eoa: null });
}

// aggregate over file/batch mode only (rt reported separately)
const agg = {};
for (const r of rows) {
  if (r.wer === null || r.wer === undefined) continue;
  if (r.mode === 'rt') continue;
  const k = `${r.engine} | ${r.voice} | ${r.cond}`;
  (agg[k] ??= { wers: [], techHit: 0, techN: 0, lat: [] });
  agg[k].wers.push(r.wer); agg[k].techHit += r.techHit; agg[k].techN += r.techN;
  if (r.wall_s) agg[k].lat.push(r.wall_s);
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log('engine | voice | cond | n | meanWER | techAcc | meanLatency_s');
for (const [k, v] of Object.entries(agg)) {
  console.log(`${k} | ${v.wers.length} | ${mean(v.wers).toFixed(3)} | ${(v.techHit / v.techN).toFixed(3)} | ${mean(v.lat).toFixed(2)}`);
}
// rt end-of-audio latency
console.log('\nrt eoa_to_final_s:');
for (const r of rows.filter(r => r.mode === 'rt' && r.eoa !== null))
  console.log(`  ${r.engine} ${r.id}_${r.voice}: ${r.eoa.toFixed(3)}s`);

// worst 5 per engine (file/batch)
const byEngine = {};
for (const r of rows) {
  if (r.wer === null || r.wer === undefined || r.mode === 'rt') continue;
  (byEngine[r.engine] ??= []).push(r);
}
const worst = {};
for (const [e, rs] of Object.entries(byEngine))
  worst[e] = [...rs].sort((a, b) => b.wer - a.wer).slice(0, 5);
writeFileSync('score.json', JSON.stringify({ agg: Object.fromEntries(
  Object.entries(agg).map(([k, v]) => [k, { n: v.wers.length, meanWER: mean(v.wers),
    techAcc: v.techHit / v.techN, meanLatencyS: mean(v.lat) }])), worst }, null, 2));
console.log('\nwrote score.json');
