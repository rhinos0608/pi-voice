#!/bin/bash
# Render corpus.json utterances with `say` (2 voices) -> 16kHz mono s16le WAV,
# plus a noisy variant (~10 dB SNR pink noise) per file.
# Usage: ./make-corpus.sh
set -euo pipefail
cd "$(dirname "$0")"
FF=/opt/miniconda3/bin/ffmpeg
VOICE_A="Samantha"   # en_US female
VOICE_B="Daniel"     # en_GB male
mkdir -p wav tmp

render() {
  local id="$1" text="$2" voice="$3" tag="$4"
  local aiff="tmp/${id}_${tag}.aiff" out="wav/${id}_${tag}.wav"
  [ -f "$out" ] && return 0
  say -v "$voice" --file-format=AIFF -o "$aiff" "$text"
  "$FF" -nostdin -hide_banner -loglevel error -y -i "$aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$out"
}

noisy() {
  local clean="$1"
  local out="${clean%.wav}_noisy.wav"
  [ -f "$out" ] && return 0
  local dur
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$clean" 2>/dev/null || "$FF" -i "$clean" 2>&1 | grep Duration | awk '{print $2}' | tr -d , | awk -F: '{print $1*3600+$2*60+$3}')
  # per-file calibrated pink-noise gain for ~10 dB SNR (amix normalize=0 keeps speech at full level)
  local gain
  gain=$(python3 -c "import wave,struct,math;w=wave.open('$clean');n=w.getnframes();s=struct.unpack('<'+str(n)+'h',w.readframes(n));r=math.sqrt(sum(x*x for x in s)/n)/32768.0;print(f'{r/(0.1842*3.1623):.4f}')")
  "$FF" -nostdin -hide_banner -loglevel error -y -i "$clean" -f lavfi -i "anoisesrc=color=pink:sample_rate=16000:duration=${dur}:seed=42,volume=${gain}" \
    -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0" \
    -ar 16000 -ac 1 -c:a pcm_s16le "tmp/mix.wav"
  # peak-normalize the mix to 0.95 if it clips (linear gain: preserves SNR exactly)
  "$FF" -nostdin -hide_banner -loglevel error -y -i tmp/mix.wav -ar 16000 -ac 1 -c:a pcm_s16le "$out" \
    -af "volume=$(python3 -c "import wave,struct;w=wave.open('tmp/mix.wav');n=w.getnframes();s=struct.unpack('<'+str(n)+'h',w.readframes(n));p=max(abs(x) for x in s)/32768.0;print(f'{min(0.95/p,1.0):.4f}')")"
}

# export FF for ffprobe fallback (prefer ffprobe if present)
if ! command -v ffprobe >/dev/null 2>&1 && [ -x /opt/miniconda3/bin/ffprobe ]; then
  export PATH="/opt/miniconda3/bin:$PATH"
fi

python3 - <<'EOF' > tmp/render-list.tsv
import json
c = json.load(open('corpus.json'))
for u in c['utterances']:
    print(f"{u['id']}\t{u['text']}")
EOF

while IFS=$'\t' read -r id text; do
  render "$id" "$text" "$VOICE_A" "samantha"
  render "$id" "$text" "$VOICE_B" "daniel"
done < tmp/render-list.tsv

for f in wav/*_samantha.wav wav/*_daniel.wav; do
  case "$f" in *noisy*) continue;; esac
  noisy "$f"
done

echo "files: $(ls wav/*.wav | wc -l)"
"$FF" -nostdin -hide_banner -loglevel error -i wav/u01_samantha.wav 2>&1 | head -5 || true
# total duration
python3 - <<'EOF'
import subprocess, glob
tot = 0.0
for f in sorted(glob.glob('wav/*.wav')):
    o = subprocess.run(['ffprobe','-v','error','-show_entries','format=duration',
                        '-of','csv=p=0',f],capture_output=True,text=True)
    try: tot += float(o.stdout.strip())
    except ValueError: pass
print(f"total audio: {tot:.1f}s ({tot/60:.2f} min), files: {len(glob.glob('wav/*.wav'))}")
EOF
