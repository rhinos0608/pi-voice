#!/bin/sh
# Full study: synthesize corpus (~1580 utterances, ~10 min) then embed + sweep (~10 min).
set -eu
cd "$(dirname "$0")"
node make_audio.mjs
node run.mjs
