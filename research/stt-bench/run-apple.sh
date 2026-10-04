#!/bin/bash
# Full Apple matrix: 3 variants x 80 files (file mode) + rt subset.
# Usage: ./run-apple.sh   (appends to apple_results.jsonl)
set -uo pipefail
cd "$(dirname "$0")"
[ -x ./apple-stt ] || xcrun swiftc -O apple-stt.swift -o apple-stt
python3 -c "import json; json.dump(json.load(open('corpus.json'))['context_terms'], open('terms.json','w'))"
: > apple_results.jsonl
for v in transcribe dictation context; do
  echo "=== file/$v ===" >&2
  ./apple-stt --terms terms.json file "$v" wav/*.wav >> apple_results.jsonl 2> "apple_stderr_$v.log"
done
echo "=== rt subset ===" >&2
./apple-stt --terms terms.json rt transcribe wav/u01_samantha.wav wav/u01_daniel.wav wav/u12_samantha.wav wav/u12_daniel.wav >> apple_results.jsonl 2> apple_stderr_rt.log
./apple-stt --terms terms.json rt dictation wav/u01_samantha.wav wav/u12_samantha.wav >> apple_results.jsonl 2>> apple_stderr_rt.log
./apple-stt --terms terms.json rt context wav/u01_samantha.wav wav/u12_samantha.wav >> apple_results.jsonl 2>> apple_stderr_rt.log
echo "lines: $(wc -l < apple_results.jsonl)" >&2
