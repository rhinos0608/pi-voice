// elevenlabs.mjs — transcribe clean WAVs with ElevenLabs batch STT (scribe_v2).
// Usage: ELEVENLABS_API_KEY=... node elevenlabs.mjs
// Emits one JSON object per line into elevenlabs_results.jsonl. Never prints the key.
import { readFileSync, readdirSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';

const API = 'https://api.elevenlabs.io/v1/speech-to-text';
const MODEL = 'scribe_v2';
const key = process.env.ELEVENLABS_API_KEY;
if (!key) { console.error('ELEVENLABS_API_KEY is not set'); process.exit(1); }

const OUT = 'elevenlabs_results.jsonl';
if (existsSync(OUT)) unlinkSync(OUT);
const files = readdirSync('wav').filter(f => f.endsWith('.wav') && !f.includes('noisy')).sort();
console.error(`transcribing ${files.length} clean files with ${MODEL}`);

for (const f of files) {
  const path = `wav/${f}`;
  const buf = readFileSync(path);
  const form = new FormData();
  form.append('model_id', MODEL);
  form.append('file', new Blob([buf], { type: 'audio/wav' }), f);
  const t0 = performance.now();
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    });
    const dt = (performance.now() - t0) / 1000;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      appendFileSync(OUT, JSON.stringify({ file: path, model: MODEL, latency_s: dt, error: `HTTP ${res.status}: ${body}` }) + '\n');
      console.error(`${f}: HTTP ${res.status}`);
      continue;
    }
    const j = await res.json();
    appendFileSync(OUT, JSON.stringify({ file: path, model: MODEL, latency_s: dt, text: j.text ?? '', lang: j.language_code ?? '' }) + '\n');
    console.error(`${f}: ${dt.toFixed(2)}s`);
  } catch (e) {
    appendFileSync(OUT, JSON.stringify({ file: path, model: MODEL, error: String(e).slice(0, 300) }) + '\n');
    console.error(`${f}: ERROR ${String(e).slice(0, 120)}`);
  }
}
console.error('done');
