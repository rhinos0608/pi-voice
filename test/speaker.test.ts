import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  addCorrection,
  adaptProfile,
  buildProfile,
  cosineSimilarity,
  createSpeakerEmbedder,
  createSpeakerGate,
  deleteSpeakerProfile,
  LEARN,
  learnedCount,
  loadSpeakerProfile,
  MIN_ENROLL_CLIPS,
  RECOMMENDED_ENROLL_CLIPS,
  resetLearning,
  saveSpeakerProfile,
  scoreSample,
  scoreUtterance,
  SPEAKER_THRESHOLDS,
  suggestedThresholdFor,
  type SpeakerExtractorLike,
  type SpeakerProfile,
} from "../src/speaker.ts";
import { speakerModelCachedPath } from "../src/model.ts";

function fakeExtractor(dim: number, embedding: Float32Array): (modelPath: string) => SpeakerExtractorLike {
  return (_modelPath: string) => ({
    dim,
    createStream: () => ({
      acceptWaveform: (_input: { samples: Float32Array; sampleRate: number }) => {},
      inputFinished: () => {},
    }),
    isReady: (_stream: unknown) => true,
    compute: (_stream: unknown) => embedding,
  });
}

function pcmOf(seconds: number, value = 1000): Buffer {
  const buf = Buffer.alloc(Math.floor(seconds * 16000) * 2);
  for (let i = 0; i < buf.length; i += 2) buf.writeInt16LE(value, i);
  return buf;
}

const PROFILE: SpeakerProfile = {
  version: 1,
  model: "test-model",
  dim: 3,
  centroid: [1, 0, 0],
  enrolledAt: new Date().toISOString(),
  enrollScores: [1, 1, 1],
  suggestedThreshold: 0.9,
};

describe("cosineSimilarity", () => {
  it("scores identical/opposite/orthogonal vectors", () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("returns 0 for zero vectors", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  });
});

describe("createSpeakerEmbedder", () => {
  it("L2-normalizes the embedding", () => {
    const embedder = createSpeakerEmbedder("fake", { extractorFactory: fakeExtractor(2, new Float32Array([3, 4])) });
    assert.equal(embedder.dim, 2);
    const out = embedder.embed(pcmOf(0.1));
    assert.ok(Math.abs(out[0]! - 0.6) < 1e-6);
    assert.ok(Math.abs(out[1]! - 0.8) < 1e-6);
  });

  it("rejects empty or odd-length PCM", () => {
    const embedder = createSpeakerEmbedder("fake", { extractorFactory: fakeExtractor(2, new Float32Array([1, 0])) });
    assert.throws(() => embedder.embed(Buffer.alloc(0)), /non-empty/);
    assert.throws(() => embedder.embed(Buffer.alloc(3)), /even-length/);
  });
});

describe("buildProfile", () => {
  const v = (...xs: number[]): Float32Array => new Float32Array(xs);
  it("computes the normalized mean and leave-one-out per-clip scores", () => {
    const clips = [new Float32Array([1, 0]), new Float32Array([0, 1]), new Float32Array([1, 1]), new Float32Array([1, 0.5])];
    const profile = buildProfile(clips, "m");
    const norm = Math.hypot(0.75, 0.625);
    assert.ok(Math.abs(profile.centroid[0]! - (0.75 / norm)) < 1e-6);
    assert.equal(profile.enrollScores.length, 4);
    // Each LOO score matches the clip's cosine to the centroid of the other three.
    for (let i = 0; i < clips.length; i++) {
      const rest = clips.filter((_, j) => j !== i);
      const m = new Float32Array(2);
      for (const c of rest) for (let k = 0; k < 2; k++) m[k]! += c[k]!;
      const expected = cosineSimilarity(clips[i]!, m);
      assert.ok(Math.abs(profile.enrollScores[i]! - expected) < 1e-6);
    }
    assert.equal(profile.version, 1);
  });

  it("requires at least 4 clips with one shared dimension", () => {
    assert.throws(() => buildProfile([new Float32Array([1]), new Float32Array([1])], "m"), /at least 4/);
    assert.throws(
      () =>
        buildProfile(
          [new Float32Array([1, 0]), new Float32Array([1, 0]), new Float32Array([1, 0]), new Float32Array([1])],
          "m",
        ),
      /one dimension/,
    );
  });
});

describe("thresholds", () => {
  it("is an ordered low/normal/high ladder inside (0, 1)", () => {
    const { low, normal, high } = SPEAKER_THRESHOLDS;
    assert.ok(low > 0 && low < normal && normal < high && high < 1);
  });

  it("derives a per-user threshold 0.05 below the worst enroll score, clamped to [0.5, 0.85]", () => {
    assert.equal(suggestedThresholdFor([0.95, 0.9, 0.93]), 0.85);
    assert.equal(suggestedThresholdFor([]), SPEAKER_THRESHOLDS.normal);
    assert.equal(suggestedThresholdFor([0.55, 0.6, 0.58]), 0.5);
    assert.equal(suggestedThresholdFor([0.99, 0.99, 0.99]), 0.85);
    assert.equal(suggestedThresholdFor([0.8, 0.85]), 0.75);
  });

  it("stores the derived threshold on the built profile", () => {
    const profile = buildProfile(
      [new Float32Array([1, 0]), new Float32Array([0, 1]), new Float32Array([1, 1]), new Float32Array([1, 0.5])],
      "m",
    );
    assert.equal(profile.suggestedThreshold, suggestedThresholdFor(profile.enrollScores));
  });

  it("requires at least 4 enrollment clips and recommends 5", () => {
    assert.equal(MIN_ENROLL_CLIPS, 4);
    assert.equal(RECOMMENDED_ENROLL_CLIPS, 5);
    assert.throws(
      () =>
        buildProfile([new Float32Array([1, 0]), new Float32Array([0, 1]), new Float32Array([1, 1])], "m"),
      /at least 4/,
    );
  });

  it("stores leave-one-out enrollScores so an outlier scores much lower than its include-self score", () => {
    const clips = [
      new Float32Array([1, 0]),
      new Float32Array([1, 0.05]),
      new Float32Array([1, -0.05]),
      new Float32Array([0, 1]),
    ];
    const profile = buildProfile(clips, "test-model");
    assert.equal(profile.enrollScores.length, 4);
    assert.ok(profile.enrollScores[3]! < 0.2, `outlier LOO score ${profile.enrollScores[3]} should be < 0.2`);
    const mean = new Float32Array(2);
    for (const c of clips) for (let i = 0; i < 2; i++) mean[i]! += c[i]!;
    for (let i = 0; i < 2; i++) mean[i]! /= clips.length;
    const includeSelf = cosineSimilarity(clips[3]!, mean);
    assert.ok(
      includeSelf - profile.enrollScores[3]! > 0.2,
      `include-self ${includeSelf} should exceed LOO ${profile.enrollScores[3]} by > 0.2`,
    );
  });
});

describe("speaker profile persistence", () => {
  it("round-trips through save/load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-speaker-"));
    try {
      await saveSpeakerProfile(PROFILE, dir);
      // PROFILE predates enrollThreshold: load migrates it from the enforced gate.
      assert.deepEqual(await loadSpeakerProfile(dir), {
        ...PROFILE,
        enrollThreshold: PROFILE.suggestedThreshold,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing or corrupt files without throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-speaker-"));
    try {
      assert.equal(await loadSpeakerProfile(dir), undefined);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "speaker.json"), "{not json");
      const warnings: string[] = [];
      assert.equal(await loadSpeakerProfile(dir, (m) => warnings.push(m)), undefined);
      assert.equal(warnings.length, 1);
      writeFileSync(join(dir, "speaker.json"), JSON.stringify({ ...PROFILE, centroid: [1, 0] }));
      assert.equal(await loadSpeakerProfile(dir, (m) => warnings.push(m)), undefined);
      assert.equal(warnings.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects wrong-version payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-speaker-"));
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "speaker.json"), JSON.stringify({ ...PROFILE, version: 2 }));
      assert.equal(await loadSpeakerProfile(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes the profile and tolerates a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-speaker-"));
    try {
      await deleteSpeakerProfile(dir);
      await saveSpeakerProfile(PROFILE, dir);
      await deleteSpeakerProfile(dir);
      assert.equal(await loadSpeakerProfile(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes file mode 0600 under dir mode 0700", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-speaker-"));
    try {
      await saveSpeakerProfile(PROFILE, dir);
      assert.equal((await stat(join(dir, "speaker.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tightens a pre-existing loose directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-speaker-"));
    try {
      await chmod(dir, 0o755);
      await saveSpeakerProfile(PROFILE, dir);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createSpeakerGate", () => {
  function gateWith(embedding: Float32Array, threshold = 0.7, extra?: { minSpeechMs?: number; maxSpeechMs?: number }) {
    return createSpeakerGate({
      embed: (_pcm: Buffer) => embedding,
      profile: { ...PROFILE, dim: 2, centroid: [1, 0] },
      threshold,
      ...extra,
    });
  }

  it("stays pending below minSpeechMs then accepts a matching voice", () => {
    const gate = gateWith(new Float32Array([1, 0]));
    gate.push(pcmOf(0.5));
    assert.equal(gate.decision(), "pending");
    gate.push(pcmOf(1.0)); // 1.5 s total clears the 1500 ms insufficient floor
    assert.equal(gate.decision(), "accept");
    assert.equal(gate.finalize().decision, "accept");
  });

  it("rejects a non-matching voice", () => {
    const gate = gateWith(new Float32Array([0, 1]));
    gate.push(pcmOf(1.5));
    assert.equal(gate.decision(), "reject");
  });

  it("push past maxSpeechMs performs no extra embeddings; finalize scores head and tail", () => {
    let calls = 0;
    const gate = createSpeakerGate({
      embed: (_pcm: Buffer) => {
        calls += 1;
        return new Float32Array([1, 0]);
      },
      profile: { ...PROFILE, dim: 2, centroid: [1, 0] },
      threshold: 0.7,
      maxSpeechMs: 1000,
    });
    gate.push(pcmOf(0.6));
    gate.push(pcmOf(0.6));
    assert.equal(gate.decision(), "accept");
    gate.push(pcmOf(1)); // speech past maxSpeechMs is retained for the tail window
    assert.equal(calls, 1);
    const done = gate.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.speechMs > 900 && done.speechMs <= 1100, `speechMs ${done.speechMs} should be the 1000 ms head window`);
    assert.ok(calls <= 6, `expected at most 6 embeddings, got ${calls}`);
  });

  it("finalize reports insufficient below 1500 ms without embedding", () => {
    const tiny = gateWith(new Float32Array([1, 0]));
    tiny.push(pcmOf(0.3));
    assert.equal(tiny.finalize().decision, "insufficient");

    // 0.8 s of even matching speech is still insufficient: it proceeds but
    // is never scored, so it can never seed learning.
    let calls = 0;
    const mid = createSpeakerGate({
      embed: (_pcm: Buffer): Float32Array => {
        calls += 1;
        return new Float32Array([1, 0]);
      },
      profile: { ...PROFILE, dim: 2, centroid: [1, 0] },
      threshold: 0.7,
    });
    mid.push(pcmOf(0.8));
    const out = mid.finalize();
    assert.equal(out.decision, "insufficient");
    assert.equal(out.embedding, undefined);
    assert.equal(calls, 0);
    assert.ok(out.speechMs > 700 && out.speechMs < 900);

    const enough = gateWith(new Float32Array([1, 0]));
    enough.push(pcmOf(2.0));
    const done = enough.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.score !== undefined && done.score > 0.99);
    assert.ok(done.speechMs > 1900 && done.speechMs < 2100);
  });

  it("reset clears the verdict so the gate can be reused", () => {
    const gate = gateWith(new Float32Array([1, 0]));
    gate.push(pcmOf(1.5));
    assert.equal(gate.decision(), "accept");
    gate.reset();
    assert.equal(gate.decision(), "pending");
    gate.push(pcmOf(1.5));
    assert.equal(gate.decision(), "accept");
  });
});

describe("speaker gate provisional accept", () => {
  const OWNER = new Float32Array([1, 0]);
  const IMPOSTOR = new Float32Array([0, 1]);
  const profileOf = (): SpeakerProfile => ({ ...PROFILE, dim: 2, centroid: [1, 0] });
  /** Deterministic embedder: any 2000-valued sample marks impostor audio. */
  function contentEmbed(calls: { n: number }): (pcm: Buffer) => Float32Array {
    return (pcm: Buffer) => {
      calls.n += 1;
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        if (pcm.readInt16LE(i) === 2000) return IMPOSTOR.slice();
      }
      return OWNER.slice();
    };
  }
  const gateWithCalls = (calls: { n: number }, threshold = 0.7) =>
    createSpeakerGate({ embed: contentEmbed(calls), profile: profileOf(), threshold });

  it("2.5 s of speech accumulates past the early verdict and is learnable", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    for (let i = 0; i < 5; i++) gate.push(pcmOf(0.5));
    assert.equal(gate.decision(), "accept");
    const done = gate.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.speechMs > 2400 && done.speechMs < 2600, `speechMs ${done.speechMs} should be ~2500`);
    assert.ok(done.score !== undefined && done.embedding !== undefined);
    assert.ok(calls.n <= 2, `expected at most 2 embeddings, got ${calls.n}`);
    // The finalize result clears the 2 s learning minimum.
    const res = adaptProfile(profileOf(), {
      embedding: done.embedding,
      score: done.score!,
      speechMs: done.speechMs,
      threshold: 0.7,
    });
    assert.equal(res.reason, "learned");
    assert.equal(res.adapted, true);
  });

  it("two segments of 1.25 s accumulate to 2.5 s", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    gate.push(pcmOf(1.25));
    assert.equal(gate.decision(), "accept");
    gate.push(pcmOf(1.25)); // resumed speech after a pause keeps accumulating
    const done = gate.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.speechMs > 2400 && done.speechMs < 2600, `speechMs ${done.speechMs} should be ~2500`);
    assert.ok(calls.n <= 2, `expected at most 2 embeddings, got ${calls.n}`);
  });

  it("provisional accept flips to reject at finalize when later audio is a different speaker", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    gate.push(pcmOf(1.25, 1000));
    assert.equal(gate.decision(), "accept");
    gate.push(pcmOf(1.25, 2000)); // different speaker in the later segment
    assert.equal(gate.decision(), "accept"); // still provisional mid-utterance
    const done = gate.finalize();
    assert.equal(done.decision, "reject");
    assert.equal(gate.decision(), "reject");
    assert.ok(calls.n <= 2, `expected at most 2 embeddings, got ${calls.n}`);
  });

  it("early reject is terminal and finalize adds no extra embedding", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    gate.push(pcmOf(1.5, 2000));
    assert.equal(gate.decision(), "reject");
    assert.equal(calls.n, 1);
    gate.push(pcmOf(1.5, 1000)); // late owner audio never revives a reject
    assert.equal(gate.decision(), "reject");
    assert.equal(gate.finalize().decision, "reject");
    assert.equal(calls.n, 1);
  });

  it("caps learned speech at the head window with at most 6 embeddings", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    for (let i = 0; i < 8; i++) gate.push(pcmOf(0.5)); // 4 s offered, 4 s head window
    const done = gate.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.speechMs > 3900 && done.speechMs <= 4100, `speechMs ${done.speechMs} should cap at ~4000`);
    gate.finalize();
    assert.ok(calls.n <= 6, `expected at most 6 embeddings, got ${calls.n}`);
  });

  it("owner speech over two segments then a different speaker flips to reject", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    gate.push(pcmOf(1.25, 1000)); // owner-like speech
    assert.equal(gate.decision(), "accept");
    gate.push(pcmOf(1.25, 1000)); // owner-like second segment
    const mid = gate.finalize(); // VAD-end settle spends the budget
    assert.equal(mid.decision, "accept");
    assert.equal(calls.n, 2);
    gate.push(pcmOf(1.25, 2000)); // a different speaker resumes
    const done = gate.finalize(); // submission settle must re-score the new speech
    assert.equal(done.decision, "reject");
    assert.equal(gate.decision(), "reject");
    assert.ok(calls.n <= 6, `expected at most 6 embeddings, got ${calls.n}`);
  });

  it("resume/finalize cycles always reflect the newest speech", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    gate.push(pcmOf(1.5, 1000));
    assert.equal(gate.finalize().decision, "accept");
    const afterFirst = calls.n;
    gate.push(pcmOf(0.5, 1000));
    assert.equal(gate.finalize().decision, "accept");
    assert.ok(calls.n > afterFirst, "resumed speech must be re-scored");
    const afterSecond = calls.n;
    gate.push(pcmOf(0.5, 1000));
    assert.equal(gate.finalize().decision, "accept");
    assert.ok(calls.n > afterSecond, "resumed speech must be re-scored");
    gate.push(pcmOf(0.5, 2000)); // impostor tail
    assert.equal(gate.finalize().decision, "reject");
    assert.ok(calls.n <= 6, `expected at most 6 embeddings, got ${calls.n}`);
  });

  it("fails closed with reason unverified once the 6-embedding budget is spent", () => {
    const calls = { n: 0 };
    const gate = gateWithCalls(calls);
    gate.push(pcmOf(1.5, 1000)); // early accept, first embedding
    assert.equal(gate.decision(), "accept");
    let last = gate.finalize(); // no new speech: no new embedding
    assert.equal(last.decision, "accept");
    assert.equal(calls.n, 1);
    for (let i = 0; i < 5; i++) {
      gate.push(pcmOf(0.2, 1000)); // owner-like resume
      last = gate.finalize();
      assert.equal(last.decision, "accept");
    }
    assert.equal(calls.n, 6); // 1 early + 5 rescored finalizes
    gate.push(pcmOf(0.2, 1000)); // unscored speech remains, budget spent
    last = gate.finalize();
    assert.equal(last.decision, "reject");
    assert.equal(last.reason, "unverified");
    assert.equal(last.embedding, undefined); // never learned from an unscored verdict
    assert.ok(calls.n <= 6, `expected at most 6 embeddings, got ${calls.n}`);
    assert.equal(gate.decision(), "reject");
  });

  it("long owner-only utterance scores head and tail windows within 6 embeddings", () => {
    const seen: { first: number; last: number; len: number }[] = [];
    const gate = createSpeakerGate({
      embed: (pcm: Buffer) => {
        seen.push({ first: pcm.readInt16LE(0), last: pcm.readInt16LE(pcm.length - 2), len: pcm.length });
        return OWNER.slice();
      },
      profile: profileOf(),
      threshold: 0.7,
    });
    for (let i = 0; i < 9; i++) gate.push(pcmOf(0.5, 1000 + i)); // 4.5 s, values 1000..1008
    const done = gate.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.speechMs > 3900 && done.speechMs <= 4100, `speechMs ${done.speechMs} should cap at ~4000`);
    assert.ok(seen.length <= 6, `expected at most 6 embeddings, got ${seen.length}`);
    const head = seen.find((s) => s.len === 128000 && s.first === 1000);
    const tail = seen.find((s) => s.len === 128000 && s.last === 1008);
    assert.ok(head !== undefined, `expected a scored head window, got ${JSON.stringify(seen)}`);
    assert.ok(tail !== undefined, `expected a scored tail window, got ${JSON.stringify(seen)}`);
  });
});

describe("short-utterance provisional gate", () => {
  // Owner real-voice enrollment is noisy (self-cosine 0.35-0.76), so a
  // genuine-but-noisy short segment can score just under the gate while a
  // clearly different speaker scores far below it.
  const THRESHOLD = 0.53;
  const prof = (): SpeakerProfile => ({ ...PROFILE, dim: 2, centroid: [1, 0] });
  const NOISY = new Float32Array([0.5, Math.sqrt(0.75)]); // cosine 0.5 to the centroid
  const OWNER = new Float32Array([1, 0]);
  const IMPOSTOR = new Float32Array([0, 1]); // cosine 0 to the centroid

  it("scoreUtterance uses scoreSample semantics", () => {
    const profile = prof();
    assert.equal(scoreUtterance(profile, OWNER), scoreSample(profile, OWNER));
    assert.equal(scoreUtterance(profile, NOISY), scoreSample(profile, NOISY));
    assert.equal(scoreUtterance(profile, IMPOSTOR), scoreSample(profile, IMPOSTOR));
  });

  it("a genuine-but-noisy early segment is not rejected and accepts at end", () => {
    let calls = 0;
    const gate = createSpeakerGate({
      profile: prof(),
      threshold: THRESHOLD,
      // First (1.2 s) window is noisy; the full-utterance re-score is clean.
      embed: (_pcm: Buffer): Float32Array => {
        calls += 1;
        return (calls === 1 ? NOISY : OWNER).slice();
      },
    });
    gate.push(pcmOf(1.2));
    assert.equal(gate.decision(), "pending");
    gate.push(pcmOf(1.8)); // 3.0 s total
    const done = gate.finalize();
    assert.equal(done.decision, "accept");
    assert.ok(done.score !== undefined && done.score >= THRESHOLD);
    assert.ok(calls <= 6, `expected at most 6 embeddings, got ${calls}`);
  });

  it("a clearly different speaker still rejects early", () => {
    let calls = 0;
    const gate = createSpeakerGate({
      profile: prof(),
      threshold: THRESHOLD,
      embed: (_pcm: Buffer): Float32Array => {
        calls += 1;
        return IMPOSTOR.slice();
      },
    });
    gate.push(pcmOf(1.2));
    assert.equal(gate.decision(), "reject");
    assert.equal(gate.finalize().decision, "reject");
    assert.ok(calls <= 6, `expected at most 6 embeddings, got ${calls}`);
  });

  it("short utterances are insufficient and never learned", () => {
    let calls = 0;
    const gate = createSpeakerGate({
      profile: prof(),
      threshold: THRESHOLD,
      embed: (_pcm: Buffer): Float32Array => {
        calls += 1;
        return OWNER.slice();
      },
    });
    gate.push(pcmOf(0.8));
    const done = gate.finalize();
    assert.equal(done.decision, "insufficient");
    assert.equal(done.embedding, undefined);
    assert.equal(calls, 0);
    const res = adaptProfile(prof(), {
      embedding: OWNER,
      score: 1,
      speechMs: done.speechMs,
      threshold: THRESHOLD,
    });
    assert.equal(res.adapted, false);
    assert.equal(res.reason, "too-short");
  });
});

describe("speaker model (real, cached only)", () => {
  it("embeds real audio when the model is already cached", { skip: speakerModelCachedPath() === undefined }, () => {
    const { createSpeakerEmbedder: create } = { createSpeakerEmbedder };
    const embedder = create(speakerModelCachedPath() as string);
    assert.ok(embedder.dim > 0);
    const out = embedder.embed(pcmOf(1, 500));
    assert.equal(out.length, embedder.dim);
    let norm = 0;
    for (const v of out) norm += v * v;
    assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-5);
  });
});

describe("online learning", () => {
  const nv = (xs: number[]): Float32Array => {
    const norm = Math.hypot(...xs);
    return new Float32Array(xs.map((x) => x / norm));
  };
  const ownerClip = (dx: number, dy: number): Float32Array => nv([1 + dx, dy]);
  const ownerAnchors = (): Float32Array[] => [
    ownerClip(0, 0),
    ownerClip(0.01, 0.05),
    ownerClip(-0.01, -0.05),
    ownerClip(0.02, 0.02),
  ];
  const enrollOwner = (): SpeakerProfile => buildProfile(ownerAnchors(), "test-model");
  const ownerSample = (
    profile: SpeakerProfile,
    embedding: Float32Array = nv([1, 0.01]),
    threshold = 0.7,
  ): { embedding: Float32Array; score: number; speechMs: number; threshold: number } => ({
    embedding,
    score: scoreSample(profile, embedding),
    speechMs: LEARN.minSpeechMs + 500,
    threshold,
  });

  it("buildProfile stores enrollment embeddings as anchors with empty learned", () => {
    const clips = ownerAnchors();
    const profile = buildProfile(clips, "test-model");
    assert.deepEqual(
      profile.anchors,
      clips.map((c) => Array.from(c)),
    );
    assert.deepEqual(profile.learned, []);
    assert.equal(profile.version, 1);
  });

  it("loads legacy profiles without anchors/learned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "speaker-legacy-"));
    try {
      const modern = enrollOwner();
      const { anchors: _a, learned: _l, ...legacy } = modern;
      void _a;
      void _l;
      writeFileSync(join(dir, "speaker.json"), JSON.stringify(legacy));
      const loaded = await loadSpeakerProfile(dir);
      assert.ok(loaded);
      assert.equal(loaded.anchors, undefined);
      assert.equal(loaded.learned, undefined);
      // Legacy profiles anchor on the centroid: an owner-like sample still learns.
      const res = adaptProfile(loaded, ownerSample(loaded));
      assert.equal(res.reason, "learned");
      assert.equal(learnedCount(res.profile), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips anchors and learned through save/load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "speaker-learn-"));
    try {
      const base = enrollOwner();
      const learned = adaptProfile(base, ownerSample(base)).profile;
      await saveSpeakerProfile(learned, dir);
      const loaded = await loadSpeakerProfile(dir);
      assert.ok(loaded);
      assert.deepEqual(loaded.anchors, learned.anchors);
      assert.deepEqual(loaded.learned, learned.learned);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects dimension mismatches without mutating", () => {
    const profile = enrollOwner();
    const before = JSON.stringify(profile);
    const res = adaptProfile(profile, { ...ownerSample(profile), embedding: new Float32Array(7) });
    assert.equal(res.adapted, false);
    assert.equal(res.reason, "dim-mismatch");
    assert.equal(JSON.stringify(profile), before);
    const corr = addCorrection(profile, new Float32Array(7));
    assert.equal(corr.reason, "dim-mismatch");
    assert.equal(corr.adapted, false);
  });

  it("rejects short utterances", () => {
    const profile = enrollOwner();
    const res = adaptProfile(profile, {
      ...ownerSample(profile),
      speechMs: LEARN.minSpeechMs - 1,
    });
    assert.equal(res.adapted, false);
    assert.equal(res.reason, "too-short");
    assert.equal(learnedCount(res.profile), 0);
  });

  it("rejects scores that do not clear threshold + margin", () => {
    const profile = enrollOwner();
    const threshold = 0.7;
    const res = adaptProfile(profile, {
      ...ownerSample(profile, nv([1, 0.01]), threshold),
      score: threshold + LEARN.margin - 0.001,
    });
    assert.equal(res.adapted, false);
    assert.equal(res.reason, "low-score");
  });

  it("rejects samples outside the anchor cone even with a high score", () => {
    const profile = enrollOwner();
    // Cosine 0.78 to the anchor mean: clears a 0.7 gate + margin but not the anchor bar.
    const drifter = nv([0.78, Math.sqrt(1 - 0.78 * 0.78)]);
    const res = adaptProfile(profile, ownerSample(profile, drifter, 0.7));
    assert.ok(cosineSimilarity(drifter, profile.centroid) >= 0.7 + LEARN.margin);
    assert.equal(res.adapted, false);
    assert.equal(res.reason, "anchor-drift");
  });

  it("learns a good owner sample and stays pure", () => {
    const profile = enrollOwner();
    const before = JSON.stringify(profile);
    const res = adaptProfile(profile, ownerSample(profile), new Date("2026-01-02T03:04:05.000Z"));
    assert.equal(res.adapted, true);
    assert.equal(res.reason, "learned");
    assert.equal(learnedCount(res.profile), 1);
    assert.equal(res.profile.learned![0]!.at, "2026-01-02T03:04:05.000Z");
    assert.equal(JSON.stringify(profile), before);
    assert.notEqual(res.profile, profile);
  });

  it("corner conditions survive a flood of ordinary samples", () => {
    // One corner anchor makes a distinct condition anchor-compatible.
    const cornerDir = nv([0.88, 0.475]);
    const anchors: Float32Array[] = [nv([1, 0]), nv([1.01, 0.05]), nv([0.99, -0.05]), cornerDir];
    const opts = { maxLearned: 8 };
    let profile = buildProfile(anchors, "test-model");
    assert.ok(
      cosineSimilarity(cornerDir, profile.centroid) >= profile.suggestedThreshold,
      "corner must clear the anchor bar",
    );
    const cornerAt = (wobble: number): Float32Array => nv([0.88 + wobble, 0.475 - wobble]);
    const learn = (emb: Float32Array): void => {
      const res = adaptProfile(profile, {
        embedding: emb,
        score: scoreSample(profile, emb),
        speechMs: LEARN.minSpeechMs + 100,
        threshold: 0.7,
      }, undefined, opts);
      assert.equal(res.reason, "learned");
      profile = res.profile;
    };
    // Learn a few corner samples first.
    learn(cornerAt(0));
    learn(cornerAt(0.002));
    const cornerSeen = (): number =>
      profile.learned!.filter((s) => cosineSimilarity(s.v, cornerDir) >= LEARN.sameCondition).length;
    assert.ok(cornerSeen() >= 1, "corner samples retained");
    // A fresh corner sample is still accepted.
    learn(cornerAt(-0.002));
    // Flood with ordinary samples: corners must not be evicted.
    for (let i = 0; i < 12; i++) learn(nv([1, 0.01 + i * 0.0003]));
    assert.ok(learnedCount(profile) <= opts.maxLearned);
    assert.ok(cornerSeen() >= 1, "corner condition survives the ordinary flood");
    assert.ok(
      scoreSample(profile, cornerAt(0.001)) >= 0.7,
      "corner still scores after the flood",
    );
  });

  it("a flood of near-identical samples cannot exceed maxClusterShare", () => {
    let profile = enrollOwner();
    const cap = Math.max(1, Math.floor(LEARN.maxClusterShare * LEARN.maxLearned));
    for (let i = 0; i < LEARN.maxLearned; i++) {
      const emb = nv([1, 0.01 + (i % 3) * 0.0002]); // one tight neighbourhood
      const res = adaptProfile(profile, ownerSample(profile, emb));
      assert.equal(res.reason, "learned");
      profile = res.profile;
    }
    assert.ok(learnedCount(profile) <= LEARN.maxLearned);
    let biggest = 0;
    for (const s of profile.learned!) {
      const hood = profile.learned!.filter((o) => cosineSimilarity(s.v, o.v) >= LEARN.sameCondition).length;
      biggest = Math.max(biggest, hood);
    }
    assert.ok(biggest <= cap, `one condition holds ${biggest} of ${learnedCount(profile)}, cap is ${cap}`);
  });

  it("accepts LEARN overrides for calibration sweeps", () => {
    let profile = enrollOwner();
    for (let i = 0; i < 6; i++) {
      const res = adaptProfile(profile, ownerSample(profile, nv([1, 0.01 + i * 0.001])), undefined, {
        maxLearned: 4,
      });
      assert.equal(res.reason, "learned");
      profile = res.profile;
    }
    assert.ok(learnedCount(profile) <= 4, `override capacity respected, got ${learnedCount(profile)}`);
    // A short utterance learns when minSpeechMs is overridden.
    const short = adaptProfile(enrollOwner(), {
      ...ownerSample(enrollOwner()),
      speechMs: 100,
    }, undefined, { minSpeechMs: 50 });
    assert.equal(short.reason, "learned");
  });

  it("keeps at least anchorWeight of centroid weight on the anchors", () => {
    let profile = enrollOwner();
    const anchorMean = profile.centroid.slice();
    const pull = nv([0.88, Math.sqrt(1 - 0.88 * 0.88)]); // passes the anchor bar, pulls sideways
    assert.ok(cosineSimilarity(pull, anchorMean) >= profile.suggestedThreshold);
    // Capacity is orthogonal here: use a wide bank so the dilution setup holds
    // regardless of the default maxLearned.
    for (let i = 0; i < 64; i++) {
      const res = adaptProfile(profile, ownerSample(profile, pull), undefined, { maxLearned: 64 });
      assert.equal(res.reason, "learned");
      profile = res.profile;
    }
    const nA = profile.anchors!.length;
    const nL = learnedCount(profile);
    const equalShare = nA / (nA + nL);
    assert.ok(equalShare < LEARN.anchorWeight, "setup must dilute anchors below the floor under equal weighting");
    const dim = profile.dim;
    const mean = new Array<number>(dim).fill(0);
    for (const a of profile.anchors!) for (let i = 0; i < dim; i++) mean[i]! += a[i]!;
    for (const s of profile.learned!) for (let i = 0; i < dim; i++) mean[i]! += s.v[i]!;
    const norm = Math.hypot(...mean);
    const equalWeighted = mean.map((x) => x / norm);
    const actual = cosineSimilarity(profile.centroid, anchorMean);
    const equal = cosineSimilarity(equalWeighted, anchorMean);
    assert.ok(actual > equal, `anchored centroid (${actual}) must stay nearer anchors than equal weighting (${equal})`);
    assert.ok(actual >= 0.97, `centroid must stay near anchors, got ${actual}`);
  });

  it("limits threshold movement to maxThresholdStep and clamps to absolute bounds", () => {
    // Tight anchors derive a high raw threshold; start low to force a big upward pull.
    const low = { ...enrollOwner(), suggestedThreshold: 0.6 };
    const up = adaptProfile(low, ownerSample(low));
    assert.equal(up.reason, "learned");
    assert.ok(
      up.profile.suggestedThreshold - 0.6 <= LEARN.maxThresholdStep + 1e-9,
      `step up too large: ${up.profile.suggestedThreshold}`,
    );
    assert.ok(up.profile.suggestedThreshold <= 0.85);

    // Wide anchors derive a low raw threshold; start high to force a big downward pull.
    const spread: Float32Array[] = [nv([1, 0]), nv([0.8, 0.6]), nv([0.85, -0.5]), nv([0.9, 0.2])];
    const high = { ...buildProfile(spread, "test-model"), suggestedThreshold: 0.8 };
    const down = adaptProfile(high, {
      embedding: nv([0.86, 0.1]),
      score: 0.8,
      speechMs: LEARN.minSpeechMs + 100,
      threshold: 0.5,
    });
    assert.equal(down.reason, "learned");
    assert.ok(
      0.8 - down.profile.suggestedThreshold <= LEARN.maxThresholdStep + 1e-9,
      `step down too large: ${down.profile.suggestedThreshold}`,
    );
    assert.ok(down.profile.suggestedThreshold >= 0.5);

    // Absolute clamp holds at the top edge.
    const top = { ...enrollOwner(), suggestedThreshold: 0.85 };
    const capped = adaptProfile(top, ownerSample(top));
    assert.equal(capped.reason, "learned");
    assert.ok(capped.profile.suggestedThreshold <= 0.85);
  });

  it("adversarial drift: a near-threshold impostor is never learned", () => {
    const original = enrollOwner();
    const anchorMean = original.centroid.slice();
    // Sits above a 0.7 gate + margin yet below the anchor bar.
    const impostor = nv([0.78, Math.sqrt(1 - 0.78 * 0.78)]);
    assert.ok(scoreSample(original, impostor) >= 0.7 + LEARN.margin);
    assert.ok(cosineSimilarity(impostor, anchorMean) < original.suggestedThreshold);
    const gateVerdict = (profile: SpeakerProfile): string => {
      const gate = createSpeakerGate({ profile, threshold: 0.8, embed: (_buf: Buffer) => impostor });
      // 3 s: past the early-decision floor, so the FINAL verdict (not a
      // provisional short-window reject) decides. A near-threshold impostor
      // must never abort mid-utterance on a noisy 1.2 s window alone.
      gate.push(pcmOf(1));
      gate.push(pcmOf(1));
      gate.push(pcmOf(1));
      assert.equal(gate.decision(), "pending");
      return gate.finalize().decision;
    };
    assert.equal(gateVerdict(original), "reject");
    let profile = original;
    for (let i = 0; i < 50; i++) {
      const res = adaptProfile(profile, ownerSample(profile, impostor, 0.7));
      assert.equal(res.reason, "anchor-drift");
      assert.equal(res.adapted, false);
      profile = res.profile;
    }
    assert.equal(learnedCount(profile), 0);
    assert.deepEqual(profile.centroid, original.centroid);
    assert.ok(cosineSimilarity(profile.centroid, anchorMean) >= 0.999);
    // Learning ordinary owner speech must not make the impostor more acceptable.
    let learned = original;
    for (let i = 0; i < 10; i++) learned = adaptProfile(learned, ownerSample(learned)).profile;
    assert.ok(learnedCount(learned) > 0);
    assert.equal(gateVerdict(learned), "reject");
    assert.ok(scoreSample(learned, impostor) < learned.suggestedThreshold);
  });

  it("correction accepts owner-confirmed samples without score/duration", () => {
    const profile = enrollOwner();
    const res = addCorrection(profile, nv([1, 0.02]), new Date("2026-03-04T05:06:07.000Z"));
    assert.equal(res.reason, "learned");
    assert.equal(res.adapted, true);
    assert.equal(learnedCount(res.profile), 1);
    assert.equal(res.profile.learned![0]!.at, "2026-03-04T05:06:07.000Z");
  });

  it("correction rejects far samples beyond the slack", () => {
    const profile = enrollOwner();
    const far = nv([-1, 0]);
    assert.ok(cosineSimilarity(far, profile.centroid) < profile.suggestedThreshold - LEARN.correctionSlack);
    const res = addCorrection(profile, far);
    assert.equal(res.reason, "anchor-drift");
    assert.equal(res.adapted, false);
    assert.equal(learnedCount(res.profile), 0);
  });

  it("resetLearning drops learned and restores the anchor centroid", () => {
    let profile = enrollOwner();
    const anchorCentroid = new Float32Array(profile.centroid);
    // Capacity is orthogonal here: a wide bank keeps all five near-identical
    // setup samples (one condition cluster) instead of refreshing at the cap.
    for (let i = 0; i < 8 && learnedCount(profile) < 5; i++) {
      profile = adaptProfile(profile, ownerSample(profile), undefined, { maxLearned: 64 }).profile;
    }
    assert.equal(learnedCount(profile), 5);
    const reset = resetLearning(profile);
    assert.equal(learnedCount(reset), 0);
    assert.deepEqual(reset.learned, []);
    assert.ok(cosineSimilarity(reset.centroid, anchorCentroid) > 0.9999);
    assert.deepEqual(reset.anchors, profile.anchors);
  });

  it("pins enrollThreshold at build and bounds learning-driven drift to [enroll-0.03, enroll]", () => {
    const profile = enrollOwner();
    assert.equal(profile.enrollThreshold, profile.suggestedThreshold);
    const enroll = profile.enrollThreshold!;
    let cur = profile;
    // Creep simulation: many high-similarity learned samples must not raise
    // the threshold above the enrollment value.
    for (let i = 0; i < 40; i++) {
      const res = adaptProfile(cur, ownerSample(cur, nv([1, 0.005 + i * 0.0001])));
      assert.equal(res.reason, "learned");
      cur = res.profile;
    }
    assert.ok(
      cur.suggestedThreshold <= enroll + 1e-9,
      `creep: threshold ${cur.suggestedThreshold} rose above enroll ${enroll}`,
    );
    assert.ok(
      cur.suggestedThreshold >= enroll - 0.03 - 1e-9,
      `drop: threshold ${cur.suggestedThreshold} fell more than 0.03 below enroll ${enroll}`,
    );
  });

  it("loads legacy profiles without enrollThreshold from their suggestedThreshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "speaker-enroll-thr-"));
    try {
      const modern = enrollOwner();
      const { anchors: _a, learned: _l, enrollThreshold: _e, ...legacy } = modern as SpeakerProfile & Record<string, unknown>;
      void _a;
      void _l;
      void _e;
      assert.equal("enrollThreshold" in legacy, false);
      writeFileSync(join(dir, "speaker.json"), JSON.stringify(legacy));
      const loaded = await loadSpeakerProfile(dir);
      assert.ok(loaded);
      assert.equal(loaded.enrollThreshold, loaded.suggestedThreshold);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resetLearning restores suggestedThreshold to enrollThreshold", () => {
    let profile = enrollOwner();
    const enroll = profile.enrollThreshold!;
    for (let i = 0; i < 5; i++) profile = adaptProfile(profile, ownerSample(profile)).profile;
    const reset = resetLearning(profile);
    assert.equal(reset.suggestedThreshold, enroll);
    assert.equal(reset.enrollThreshold, enroll);
  });

  it("LEARN exposes the documented provisional knobs", () => {
    assert.deepEqual({ ...LEARN }, {
      margin: 0.05,
      minSpeechMs: 2000,
      maxLearned: 16,
      anchorWeight: 0.3,
      maxThresholdStep: 0.02,
      correctionSlack: 0.15,
      sameCondition: 0.9,
      maxClusterShare: 0.25,
    });
  });

  it("gate finalize exposes the scored embedding without extra embedding work", () => {
    const profile = enrollOwner();
    const vectors = [nv([1, 0]), nv([0, 1])];
    let calls = 0;
    const gate = createSpeakerGate({
      profile,
      threshold: 0.5,
      embed: (_buf: Buffer) => {
        calls += 1;
        return vectors[Math.min(calls - 1, vectors.length - 1)]!;
      },
    });
    assert.equal(gate.lastEmbedding(), undefined);
    gate.push(pcmOf(1));
    gate.push(pcmOf(1));
    const mid = gate.decision();
    assert.equal(mid, "accept");
    const exposed = gate.lastEmbedding();
    assert.ok(exposed instanceof Float32Array);
    assert.deepEqual(Array.from(exposed!), [1, 0]);
    const done = gate.finalize();
    assert.deepEqual(done.embedding ? Array.from(done.embedding) : undefined, [1, 0]);
    assert.equal(calls, 1);
    gate.reset();
    assert.equal(gate.lastEmbedding(), undefined);
  });
});
