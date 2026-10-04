# Speaker learned-bank capacity calibration

Owners: Samantha, Karen, Moira, Daniel (macOS `say` voices). Impostors per owner: the other three voices. Most-similar rival (mean enroll-clip cosine vs owner centroid): Samantha→Karen (0.585), Karen→Samantha (0.618), Moira→Karen (0.415), Daniel→Moira (0.341).

Method: enroll from 5 clean clips (`buildProfile`); usage stream of 300 owner utterances (60% clean, 10% phone, 10% noisy, 7% muffled, 3% fast, 3% slow, 2% pitch-up, 2% pitch-down, 3% combo) plus 12 rival-voice impostor probes, all through the real admission path (`scoreSample` vs live `suggestedThreshold`, then `adaptProfile` with `{maxLearned: cap}`). Held-out test: 6 clips per corner per owner (54) plus all other voices' test clips as impostors (162). Scores at the final profile's own threshold, and ±0.05. Sentences are disjoint across enroll/stream/test/probe pools. Run: `node make_audio.mjs && node run.mjs` from this directory (Node ≥25, ffmpeg at /opt/miniconda3/bin/ffmpeg). Audio kept under `tmp/`.

Enroll thresholds: Samantha=0.832, Karen=0.653, Moira=0.61, Daniel=0.5.

## Owner acceptance per corner at own threshold (atThr)

| owner | cap | clean | phone | muffled | noisy | fast | slow | pitchup | pitchdown | combo |
|---|---|---|---|---|---|---|---|---|---|---|
| Samantha | 0 | 100.0% | 0.0% | 66.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Samantha | 16 | 100.0% | 0.0% | 83.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Samantha | 40 | 100.0% | 0.0% | 83.3% | 16.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Samantha | 64 | 100.0% | 0.0% | 83.3% | 16.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Samantha | 128 | 100.0% | 0.0% | 83.3% | 16.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Samantha | 256 | 100.0% | 0.0% | 83.3% | 16.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Karen | 0 | 100.0% | 83.3% | 83.3% | 66.7% | 100.0% | 83.3% | 0.0% | 0.0% | 0.0% |
| Karen | 16 | 100.0% | 100.0% | 83.3% | 83.3% | 100.0% | 100.0% | 0.0% | 0.0% | 83.3% |
| Karen | 40 | 100.0% | 100.0% | 83.3% | 83.3% | 100.0% | 100.0% | 0.0% | 0.0% | 83.3% |
| Karen | 64 | 100.0% | 100.0% | 83.3% | 83.3% | 100.0% | 100.0% | 0.0% | 0.0% | 83.3% |
| Karen | 128 | 100.0% | 100.0% | 83.3% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| Karen | 256 | 100.0% | 100.0% | 83.3% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 100.0% |
| Moira | 0 | 100.0% | 66.7% | 83.3% | 66.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Moira | 16 | 100.0% | 50.0% | 83.3% | 16.7% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Moira | 40 | 100.0% | 50.0% | 83.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Moira | 64 | 100.0% | 50.0% | 83.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Moira | 128 | 100.0% | 50.0% | 83.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Moira | 256 | 100.0% | 50.0% | 83.3% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Daniel | 0 | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 50.0% | 0.0% | 0.0% |
| Daniel | 16 | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 50.0% | 33.3% | 16.7% |
| Daniel | 40 | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 16.7% | 50.0% | 50.0% | 16.7% |
| Daniel | 64 | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 50.0% | 50.0% | 16.7% |
| Daniel | 128 | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 50.0% | 33.3% | 16.7% |
| Daniel | 256 | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 0.0% | 50.0% | 33.3% | 16.7% |

## Impostor acceptance (FAR) at own threshold, and ±0.05

| owner | cap | FAR(-0.05) | FAR(thr) | FAR(+0.05) | FAR by voice @thr |
|---|---|---|---|---|---|
| Samantha | 0 | 0.0% | 0.0% | 0.0% | Karen=0.0%, Moira=0.0%, Daniel=0.0% |
| Samantha | 16 | 0.0% | 0.0% | 0.0% | Karen=0.0%, Moira=0.0%, Daniel=0.0% |
| Samantha | 40 | 0.0% | 0.0% | 0.0% | Karen=0.0%, Moira=0.0%, Daniel=0.0% |
| Samantha | 64 | 0.0% | 0.0% | 0.0% | Karen=0.0%, Moira=0.0%, Daniel=0.0% |
| Samantha | 128 | 0.0% | 0.0% | 0.0% | Karen=0.0%, Moira=0.0%, Daniel=0.0% |
| Samantha | 256 | 0.0% | 0.0% | 0.0% | Karen=0.0%, Moira=0.0%, Daniel=0.0% |
| Karen | 0 | 30.2% | 22.2% | 20.4% | Samantha=27.8%, Moira=18.5%, Daniel=20.4% |
| Karen | 16 | 42.6% | 34.6% | 27.8% | Samantha=46.3%, Moira=25.9%, Daniel=31.5% |
| Karen | 40 | 46.3% | 37.7% | 30.2% | Samantha=50.0%, Moira=31.5%, Daniel=31.5% |
| Karen | 64 | 47.5% | 39.5% | 32.1% | Samantha=55.6%, Moira=31.5%, Daniel=31.5% |
| Karen | 128 | 48.8% | 43.2% | 34.0% | Samantha=59.3%, Moira=37.0%, Daniel=33.3% |
| Karen | 256 | 50.0% | 44.4% | 35.2% | Samantha=61.1%, Moira=38.9%, Daniel=33.3% |
| Moira | 0 | 7.4% | 4.3% | 2.5% | Samantha=5.6%, Karen=3.7%, Daniel=3.7% |
| Moira | 16 | 3.7% | 1.9% | 0.0% | Samantha=1.9%, Karen=1.9%, Daniel=1.9% |
| Moira | 40 | 3.7% | 1.9% | 0.0% | Samantha=1.9%, Karen=1.9%, Daniel=1.9% |
| Moira | 64 | 3.7% | 1.9% | 0.0% | Samantha=1.9%, Karen=1.9%, Daniel=1.9% |
| Moira | 128 | 3.7% | 1.9% | 0.0% | Samantha=1.9%, Karen=1.9%, Daniel=1.9% |
| Moira | 256 | 3.7% | 1.9% | 0.0% | Samantha=1.9%, Karen=1.9%, Daniel=1.9% |
| Daniel | 0 | 11.7% | 7.4% | 2.5% | Samantha=3.7%, Karen=5.6%, Moira=13.0% |
| Daniel | 16 | 19.8% | 13.6% | 11.1% | Samantha=7.4%, Karen=9.3%, Moira=24.1% |
| Daniel | 40 | 23.5% | 14.8% | 11.7% | Samantha=5.6%, Karen=11.1%, Moira=27.8% |
| Daniel | 64 | 18.5% | 13.6% | 10.5% | Samantha=5.6%, Karen=9.3%, Moira=25.9% |
| Daniel | 128 | 19.1% | 13.6% | 11.1% | Samantha=7.4%, Karen=9.3%, Moira=24.1% |
| Daniel | 256 | 19.1% | 13.6% | 11.1% | Samantha=7.4%, Karen=9.3%, Moira=24.1% |

## Bank composition (learned-sample corner counts) and threshold trajectory

### Samantha (enroll thr 0.832, rival Karen)

| cap | final thr | bank | learned events | composition | adapt reasons | probes admitted/learned |
|---|---|---|---|---|---|---|
| 0 | 0.832 | 0 | 0 | {} | {"skipped":312} | 0/0 |
| 16 | 0.85 | 16 | 139 | {"clean":13,"muffled":3} | {"low-score":158,"learned":139,"anchor-drift":15} | 0/0 |
| 40 | 0.85 | 40 | 138 | {"clean":36,"muffled":4} | {"low-score":148,"learned":138,"anchor-drift":26} | 0/0 |
| 64 | 0.85 | 64 | 139 | {"clean":60,"muffled":4} | {"low-score":145,"learned":139,"anchor-drift":28} | 0/0 |
| 128 | 0.85 | 114 | 139 | {"clean":109,"muffled":5} | {"low-score":145,"learned":139,"anchor-drift":28} | 0/0 |
| 256 | 0.85 | 138 | 139 | {"clean":133,"muffled":5} | {"low-score":145,"learned":139,"anchor-drift":28} | 0/0 |

Trajectory (step: thr / bank):

- cap 0: 0:0.832/0 25:0.832/0 50:0.832/0 75:0.832/0 100:0.832/0 125:0.832/0 150:0.832/0 175:0.832/0 200:0.832/0 225:0.832/0 250:0.832/0 275:0.832/0 300:0.832/0 312:0.832/0
- cap 16: 0:0.832/0 25:0.85/11 50:0.85/15 75:0.85/16 100:0.849/16 125:0.842/16 150:0.847/16 175:0.839/16 200:0.841/16 225:0.845/16 250:0.85/16 275:0.85/16 300:0.848/16 312:0.85/16
- cap 40: 0:0.832/0 25:0.85/14 50:0.85/22 75:0.85/31 100:0.85/37 125:0.85/39 150:0.847/40 175:0.85/40 200:0.844/40 225:0.846/40 250:0.846/40 275:0.849/40 300:0.85/40 312:0.85/40
- cap 64: 0:0.832/0 25:0.85/14 50:0.85/25 75:0.85/38 100:0.85/47 125:0.85/52 150:0.85/55 175:0.85/59 200:0.848/62 225:0.85/64 250:0.846/64 275:0.846/64 300:0.85/64 312:0.85/64
- cap 128: 0:0.832/0 25:0.85/14 50:0.85/25 75:0.85/41 100:0.85/52 125:0.85/62 150:0.85/71 175:0.85/78 200:0.85/84 225:0.85/92 250:0.85/97 275:0.85/102 300:0.85/112 312:0.85/114
- cap 256: 0:0.832/0 25:0.85/14 50:0.85/25 75:0.85/41 100:0.85/52 125:0.85/62 150:0.85/72 175:0.85/80 200:0.85/89 225:0.85/101 250:0.85/111 275:0.85/120 300:0.85/135 312:0.85/138

### Karen (enroll thr 0.653, rival Samantha)

| cap | final thr | bank | learned events | composition | adapt reasons | probes admitted/learned |
|---|---|---|---|---|---|---|
| 0 | 0.653 | 0 | 0 | {} | {"skipped":312} | 0/0 |
| 16 | 0.674 | 16 | 228 | {"clean":4,"noisy":9,"phone":2,"muffled":1} | {"learned":228,"low-score":53,"anchor-drift":31} | 2/0 |
| 40 | 0.682 | 40 | 226 | {"clean":13,"noisy":17,"phone":7,"muffled":2,"fast":1} | {"learned":226,"low-score":52,"anchor-drift":34} | 2/0 |
| 64 | 0.689 | 64 | 222 | {"clean":24,"noisy":23,"phone":8,"muffled":8,"fast":1} | {"learned":222,"low-score":51,"anchor-drift":39} | 2/0 |
| 128 | 0.699 | 128 | 219 | {"clean":74,"fast":4,"noisy":23,"phone":11,"muffled":13,"slow":3} | {"learned":219,"low-score":50,"anchor-drift":43} | 2/0 |
| 256 | 0.7 | 221 | 221 | {"clean":162,"fast":6,"noisy":23,"phone":11,"muffled":15,"slow":4} | {"learned":221,"low-score":49,"anchor-drift":42} | 2/0 |

Trajectory (step: thr / bank):

- cap 0: 0:0.653/0 25:0.653/0 50:0.653/0 75:0.653/0 100:0.653/0 125:0.653/0 150:0.653/0 175:0.653/0 200:0.653/0 225:0.653/0 250:0.653/0 275:0.653/0 300:0.653/0 312:0.653/0
- cap 16: 0:0.653/0 25:0.715/16 50:0.696/16 75:0.694/16 100:0.688/16 125:0.675/16 150:0.672/16 175:0.675/16 200:0.684/16 225:0.666/16 250:0.667/16 275:0.668/16 300:0.666/16 312:0.674/16
- cap 40: 0:0.653/0 25:0.715/16 50:0.708/32 75:0.705/40 100:0.697/40 125:0.698/40 150:0.699/40 175:0.692/40 200:0.689/40 225:0.686/40 250:0.68/40 275:0.679/40 300:0.683/40 312:0.682/40
- cap 64: 0:0.653/0 25:0.715/16 50:0.708/32 75:0.709/50 100:0.707/64 125:0.7/64 150:0.694/64 175:0.692/64 200:0.695/64 225:0.689/64 250:0.688/64 275:0.689/64 300:0.69/64 312:0.689/64
- cap 128: 0:0.653/0 25:0.715/16 50:0.708/32 75:0.709/50 100:0.71/68 125:0.707/85 150:0.706/104 175:0.701/124 200:0.701/128 225:0.698/128 250:0.698/128 275:0.697/128 300:0.7/128 312:0.699/128
- cap 256: 0:0.653/0 25:0.715/16 50:0.708/32 75:0.709/50 100:0.71/68 125:0.707/85 150:0.706/104 175:0.701/124 200:0.703/142 225:0.7/158 250:0.698/177 275:0.697/195 300:0.698/213 312:0.7/221

### Moira (enroll thr 0.61, rival Karen)

| cap | final thr | bank | learned events | composition | adapt reasons | probes admitted/learned |
|---|---|---|---|---|---|---|
| 0 | 0.61 | 0 | 0 | {} | {"skipped":312} | 0/0 |
| 16 | 0.838 | 16 | 27 | {"clean":15,"phone":1} | {"learned":27,"low-score":175,"anchor-drift":110} | 0/0 |
| 40 | 0.846 | 25 | 27 | {"clean":24,"phone":1} | {"learned":27,"low-score":177,"anchor-drift":108} | 0/0 |
| 64 | 0.846 | 27 | 27 | {"clean":26,"phone":1} | {"learned":27,"low-score":177,"anchor-drift":108} | 0/0 |
| 128 | 0.846 | 27 | 27 | {"clean":26,"phone":1} | {"learned":27,"low-score":177,"anchor-drift":108} | 0/0 |
| 256 | 0.846 | 27 | 27 | {"clean":26,"phone":1} | {"learned":27,"low-score":177,"anchor-drift":108} | 0/0 |

Trajectory (step: thr / bank):

- cap 0: 0:0.61/0 25:0.61/0 50:0.61/0 75:0.61/0 100:0.61/0 125:0.61/0 150:0.61/0 175:0.61/0 200:0.61/0 225:0.61/0 250:0.61/0 275:0.61/0 300:0.61/0 312:0.61/0
- cap 16: 0:0.61/0 25:0.75/9 50:0.81/12 75:0.821/12 100:0.821/12 125:0.84/13 150:0.84/15 175:0.843/15 200:0.843/16 225:0.842/16 250:0.842/16 275:0.842/16 300:0.838/16 312:0.838/16
- cap 40: 0:0.61/0 25:0.75/9 50:0.81/12 75:0.831/14 100:0.831/14 125:0.84/15 150:0.84/17 175:0.843/18 200:0.843/21 225:0.846/23 250:0.846/24 275:0.846/24 300:0.846/25 312:0.846/25
- cap 64: 0:0.61/0 25:0.75/9 50:0.81/12 75:0.831/14 100:0.831/14 125:0.84/15 150:0.84/17 175:0.843/18 200:0.843/21 225:0.846/25 250:0.846/26 275:0.846/26 300:0.846/27 312:0.846/27
- cap 128: 0:0.61/0 25:0.75/9 50:0.81/12 75:0.831/14 100:0.831/14 125:0.84/15 150:0.84/17 175:0.843/18 200:0.843/21 225:0.846/25 250:0.846/26 275:0.846/26 300:0.846/27 312:0.846/27
- cap 256: 0:0.61/0 25:0.75/9 50:0.81/12 75:0.831/14 100:0.831/14 125:0.84/15 150:0.84/17 175:0.843/18 200:0.843/21 225:0.846/25 250:0.846/26 275:0.846/26 300:0.846/27 312:0.846/27

### Daniel (enroll thr 0.5, rival Moira)

| cap | final thr | bank | learned events | composition | adapt reasons | probes admitted/learned |
|---|---|---|---|---|---|---|
| 0 | 0.5 | 0 | 0 | {} | {"skipped":312} | 5/0 |
| 16 | 0.626 | 16 | 197 | {"noisy":5,"clean":3,"phone":3,"muffled":5} | {"learned":197,"low-score":40,"anchor-drift":75} | 7/0 |
| 40 | 0.649 | 40 | 193 | {"clean":16,"noisy":6,"muffled":10,"phone":8} | {"learned":193,"low-score":37,"anchor-drift":82} | 7/0 |
| 64 | 0.699 | 64 | 185 | {"phone":11,"clean":33,"noisy":8,"muffled":12} | {"learned":185,"low-score":37,"anchor-drift":90} | 7/0 |
| 128 | 0.706 | 128 | 183 | {"phone":15,"clean":91,"noisy":10,"muffled":12} | {"learned":183,"low-score":37,"anchor-drift":92} | 7/0 |
| 256 | 0.706 | 183 | 183 | {"clean":145,"phone":16,"noisy":10,"muffled":12} | {"learned":183,"low-score":37,"anchor-drift":92} | 7/0 |

Trajectory (step: thr / bank):

- cap 0: 0:0.5/0 25:0.5/0 50:0.5/0 75:0.5/0 100:0.5/0 125:0.5/0 150:0.5/0 175:0.5/0 200:0.5/0 225:0.5/0 250:0.5/0 275:0.5/0 300:0.5/0 312:0.5/0
- cap 16: 0:0.5/0 25:0.699/16 50:0.64/16 75:0.697/16 100:0.718/16 125:0.718/16 150:0.696/16 175:0.69/16 200:0.691/16 225:0.679/16 250:0.678/16 275:0.656/16 300:0.633/16 312:0.626/16
- cap 40: 0:0.5/0 25:0.699/20 50:0.678/35 75:0.699/40 100:0.699/40 125:0.699/40 150:0.699/40 175:0.699/40 200:0.699/40 225:0.679/40 250:0.647/40 275:0.647/40 300:0.649/40 312:0.649/40
- cap 64: 0:0.5/0 25:0.699/20 50:0.678/35 75:0.706/53 100:0.706/64 125:0.706/64 150:0.699/64 175:0.699/64 200:0.699/64 225:0.699/64 250:0.699/64 275:0.699/64 300:0.699/64 312:0.699/64
- cap 128: 0:0.5/0 25:0.699/20 50:0.678/35 75:0.706/53 100:0.706/67 125:0.706/79 150:0.706/88 175:0.706/98 200:0.706/110 225:0.706/122 250:0.706/128 275:0.706/128 300:0.706/128 312:0.706/128
- cap 256: 0:0.5/0 25:0.699/20 50:0.678/35 75:0.706/53 100:0.706/67 125:0.706/79 150:0.706/89 175:0.706/101 200:0.706/114 225:0.706/130 250:0.706/145 275:0.706/159 300:0.706/178 312:0.706/183

## Recommendation

**Recommended capacity: `maxLearned = 16` (keep the current default's order of magnitude; do not raise it).**

- Coverage gains saturate by cap 16. Karen (the overlap case) jumps from 66.7% to 83.3% noisy and 0% to 83.3% combo at cap 16; larger caps only push noisy/combo to 100% at cap 128 while FAR climbs monotonically (22.2% at cap 0, 34.6% at 16, 44.4% at 256, all at own threshold). Daniel and Samantha show no meaningful coverage difference between 16 and 256; Moira is identical from 16 up (bank self-limits to 27 samples).
- FAR cost grows with capacity whenever voices overlap. Karen's rival (Samantha) acceptance rises 27.8% (cap 0) to 46.3% (cap 16) to 61.1% (cap 256): each extra exemplar widens the top-3 net the rival can match. The mechanism is structural (exemplar max), not a tuning accident, so bigger banks are strictly worse on the impostor side for confusable voices.
- Rare corners (fast/slow/pitch/combo) almost never enter the bank at any capacity: they fail the `margin` (thr+0.05) or anchor-cone gate, so bank composition is clean plus muffled/phone/noisy only. Raising capacity past ~40 mostly stores near-duplicate clean clips (Karen cap-256 bank: 162 clean of 221) with zero coverage payoff.
- Threshold choice matters more than capacity: +0.05 cuts Karen FAR 34.6% to 27.8% (cap 16) with no owner loss except pitch corners already at 0; -0.05 inflates FAR everywhere. Keep the per-profile suggestedThreshold as normal and consider +0.05 for confusable enrollments (worst enroll leave-one-out below ~0.75).

## Failure modes observed

1. **Threshold creep locks out corners (Moira).** Enroll threshold 0.61 goes to final 0.838-0.846: learning clean clips raises the leave-one-out-derived threshold, which then rejects the phone/noisy corners it was supposed to absorb (noisy 66.7% down to 0-16.7%, phone 66.7% down to 50%). The step limiter (+0.02/adaptation) slows but does not prevent this; a threshold anchored partly to the enrollment value would be safer.
2. **Floor threshold from weak enrollment (Daniel).** Worst-leave-one-out-minus-margin hit the 0.5 floor at enroll (threshold 0.5, FAR 7.4%); learning repaired it upward (0.626-0.706). A floor-derived gate plus learning is load-bearing here -- without learning, Daniel's gate is the weakest.
3. **Impostor probes accepted but not learned (guard held).** Karen admitted 2/12 probes, Daniel 7/12 (gate opened at score >= threshold), yet `probeLearned = 0` in all 24 runs: the margin plus anchor-cone checks blocked every bank admission. Acceptance and learning are correctly decoupled -- but note the gate itself still opens for the rival voice up to ~60% (Karen vs Samantha at cap 256); it just does not persist.
4. **Bank self-limits below large caps via redundancy discard.** Moira stops at 27, Samantha at 138, Daniel at 183 samples despite caps of 256: most candidates are discarded as redundant (nearest-neighbour `lastSeen` refresh). Large caps therefore cost disk/memory, not accuracy -- except via the FAR-widening exemplar effect above.
5. **Pitch shifts are a dead zone.** Pitch-up/pitch-down acceptance is 0-50% across all owners/caps and no pitch sample was ever learned; ±2 semitones moves embeddings outside both the margin and the anchor cone. If pitch robustness matters, it needs enrollment-time augmentation, not a bigger bank.

## Caveats

- All voices are synthetic (`say` output from a single TTS pipeline); earlier calibration showed same-voice held-out cosines (0.789–0.871) overlapping cross-voice (0.558–0.807), so absolute thresholds do NOT transfer to real human voices. Re-calibrate on real enrollment audio.
- Fixed 10 dB pink-noise SNR, single phone/muffle recipes, ±2-semitone pitch: real rooms, mics, codecs, and colds vary more widely.
- The 300-utterance stream compresses weeks of use into one session with no speaker drift over time; eviction/diversity behaviour under long-term drift was not tested.
- Impostor probes are the single most-similar synthetic voice, not a dedicated mimic or replay attack.
