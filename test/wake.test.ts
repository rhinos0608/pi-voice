import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildKeywordsFile,
  createWakeDetector,
  mapKeywordToGroup,
  mapKeywordToPhrase,
  SENSITIVITY_CONFIG,
  type SpotterLike,
  type SpotterStream,
  type WakeGroup,
} from "../src/wake.ts";
import type { ModelPaths } from "../src/contracts.ts";

const KEYWORDS_TEXT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "keywords.json"),
  "utf8",
);
const KEYWORDS = JSON.parse(KEYWORDS_TEXT) as {
  groups: Record<string, { phrase: string; tokens: string }[]>;
};

const PATHS: ModelPaths = {
  encoder: "/models/encoder.onnx",
  decoder: "/models/decoder.onnx",
  joiner: "/models/joiner.onnx",
  tokens: "/models/tokens.txt",
  keywordsFile: "/models/keywords.txt",
};

type Script = { ready: boolean; keyword: string };

function fakeSpotter(script: Script, seen: { accepted: Float32Array[]; resets: number }): SpotterLike {
  const stream: SpotterStream = {
    acceptWaveform: (input) => {
      seen.accepted.push(input.samples);
    },
  };
  return {
    createStream: () => stream,
    isReady: () => script.ready,
    decode: () => {
      script.ready = false;
    },
    reset: () => {
      seen.resets += 1;
    },
    getResult: () => ({ keyword: script.keyword }),
  };
}

test("keyword file content per choice uses bare tokens", () => {
  for (const choice of ["hey-pi", "hi-pi", "both"] as const) {
    const text = buildKeywordsFile(choice, KEYWORDS);
    assert.ok(!text.includes("@") || choice === "both" || true);
    assert.ok(!/[@#]/.test(text), `no @ or # suffix for ${choice}`);
    assert.ok(text.endsWith("\n"));
  }
  const hey = buildKeywordsFile("hey-pi", KEYWORDS);
  assert.ok(hey.includes("▁HE Y ▁PI"));
  assert.ok(!hey.includes("▁HI"));
  const hi = buildKeywordsFile("hi-pi", KEYWORDS);
  assert.ok(hi.includes("▁HI ▁PI"));
  assert.ok(!hi.includes("▁HE"));
  const both = buildKeywordsFile("both", KEYWORDS);
  assert.ok(both.includes("▁HE Y ▁PI") && both.includes("▁HI ▁PI"));
});

test("sensitivity mapping orders thresholds low > normal > high", () => {
  assert.ok(SENSITIVITY_CONFIG.low.keywordsThreshold > SENSITIVITY_CONFIG.normal.keywordsThreshold);
  assert.ok(SENSITIVITY_CONFIG.normal.keywordsThreshold > SENSITIVITY_CONFIG.high.keywordsThreshold);
});

test("push converts s16le to float32 and fires mapped phrase", () => {
  const script: Script = { ready: true, keyword: "HEY PI" };
  const seen = { accepted: [] as Float32Array[], resets: 0 };
  let capturedConfig = "";
  const phrases: string[] = [];
  const det = createWakeDetector(PATHS, "hey-pi", "normal", (p) => phrases.push(p), {
    keywordsJsonText: KEYWORDS_TEXT,
    createSpotter: (config) => {
      capturedConfig = config.keywordsFile;
      assert.equal(config.keywordsThreshold, SENSITIVITY_CONFIG.normal.keywordsThreshold);
      assert.equal(config.keywordsScore, SENSITIVITY_CONFIG.normal.keywordsScore);
      return fakeSpotter(script, seen);
    },
    writeKeywordsFile: (content) => {
      assert.ok(content.includes("▁HE Y ▁PI"));
      return "/tmp/fake-kws.txt";
    },
    removeKeywordsFile: () => {},
  });
  const frame = Buffer.alloc(3200);
  frame.writeInt16LE(32767, 0);
  frame.writeInt16LE(-32768, 2);
  det.push(frame);
  assert.equal(seen.accepted.length, 1);
  assert.ok(Math.abs((seen.accepted[0]?.[0] ?? 0) - 32767 / 32768) < 1e-6);
  assert.equal(seen.accepted[0]?.[1], -1);
  assert.deepEqual(phrases, ["HEY PI"]);
  assert.ok(seen.resets >= 1, "stream reset after detection");
  assert.equal(capturedConfig, "/tmp/fake-kws.txt");
  det.close();
});

test("both choice reuses model keywords file without temp file", () => {
  let writes = 0;
  const script: Script = { ready: false, keyword: "" };
  const det = createWakeDetector(PATHS, "both", "normal", () => {}, {
    keywordsJsonText: KEYWORDS_TEXT,
    createSpotter: (config) => {
      assert.equal(config.keywordsFile, PATHS.keywordsFile);
      return fakeSpotter(script, { accepted: [], resets: 0 });
    },
    writeKeywordsFile: () => {
      writes += 1;
      return "/tmp/should-not-happen.txt";
    },
    removeKeywordsFile: () => {},
  });
  det.push(Buffer.alloc(64));
  assert.equal(writes, 0);
  det.close();
});

test("refractory period suppresses double fires (real)", () => {
  const script: Script = { ready: true, keyword: "HI PI" };
  const seen = { accepted: [] as Float32Array[], resets: 0 };
  const phrases: string[] = [];
  let t = 10000;
  const det = createWakeDetector(PATHS, "hi-pi", "normal", (p) => phrases.push(p), {
    keywordsJsonText: KEYWORDS_TEXT,
    now: () => t,
    refractoryMs: 1500,
    createSpotter: () => fakeSpotter(script, seen),
    writeKeywordsFile: () => "/tmp/fake.txt",
    removeKeywordsFile: () => {},
  });
  const frame = Buffer.alloc(64, 1);
  script.ready = true;
  det.push(frame);
  script.ready = true;
  det.push(frame);
  assert.equal(phrases.length, 1, "second fire inside window suppressed");
  t += 1600;
  script.ready = true;
  det.push(frame);
  assert.equal(phrases.length, 2, "fire after window allowed");
  assert.deepEqual(phrases, ["HI PI", "HI PI"]);
  det.close();
});

test("reset after wake delegates to spotter reset", () => {
  const script: Script = { ready: false, keyword: "" };
  const seen = { accepted: [] as Float32Array[], resets: 0 };
  const det = createWakeDetector(PATHS, "both", "low", () => {}, {
    keywordsJsonText: KEYWORDS_TEXT,
    createSpotter: () => fakeSpotter(script, seen),
    writeKeywordsFile: () => "/tmp/x.txt",
    removeKeywordsFile: () => {},
  });
  det.reset();
  assert.equal(seen.resets, 2, "both live and staggered streams reset");
  det.close();
});

test("close removes temp file and is idempotent", () => {
  const script: Script = { ready: false, keyword: "" };
  const removed: string[] = [];
  const det = createWakeDetector(PATHS, "hey-pi", "high", () => {}, {
    keywordsJsonText: KEYWORDS_TEXT,
    createSpotter: () => fakeSpotter(script, { accepted: [], resets: 0 }),
    writeKeywordsFile: () => "/tmp/kws-tmp.txt",
    removeKeywordsFile: (p) => removed.push(p),
  });
  det.close();
  det.close();
  assert.deepEqual(removed, ["/tmp/kws-tmp.txt"]);
});

test("send-to-pi group included only with includeSend", () => {
  const without = buildKeywordsFile("hey-pi", KEYWORDS);
  assert.ok(!without.includes("▁S END ▁TO"));
  const withSend = buildKeywordsFile("hey-pi", KEYWORDS, { includeSend: true });
  assert.ok(withSend.includes("▁HE Y ▁PI"));
  assert.ok(withSend.includes("▁S END ▁TO ▁PI"));
  assert.ok(withSend.includes("▁S END ▁TO ▁PI E"));
  assert.ok(withSend.includes("▁S END ▁TO ▁P Y"));
  assert.ok(withSend.endsWith("\n"));
  const bothSend = buildKeywordsFile("both", KEYWORDS, { includeSend: true });
  assert.ok(bothSend.includes("▁HE Y ▁PI") && bothSend.includes("▁HI ▁PI"));
  assert.ok(bothSend.includes("▁S END ▁TO ▁PI"));
  const hiSend = buildKeywordsFile("hi-pi", KEYWORDS, { includeSend: true });
  assert.ok(hiSend.includes("▁HI ▁PI") && hiSend.includes("▁S END ▁TO ▁PI"));
  assert.ok(!hiSend.includes("▁HE Y ▁PI"));
});

test("mapKeywordToGroup reports send-to-pi vs wake groups", () => {
  assert.equal(mapKeywordToGroup("SEND TO PI", KEYWORDS), "send-to-pi");
  assert.equal(mapKeywordToGroup("send to pie", KEYWORDS), "send-to-pi");
  assert.equal(mapKeywordToGroup("SEND TO PY", KEYWORDS), "send-to-pi");
  assert.equal(mapKeywordToGroup("HEY PI", KEYWORDS), "hey-pi");
  assert.equal(mapKeywordToGroup("HI PI", KEYWORDS), "hi-pi");
  assert.equal(mapKeywordToGroup("UNKNOWN WORDS", KEYWORDS), undefined);
});

test("detector reports group alongside phrase (send-to-pi)", () => {
  const script: Script = { ready: true, keyword: "SEND TO PI" };
  const phrases: string[] = [];
  const groups: (WakeGroup | undefined)[] = [];
  const written: string[] = [];
  const det = createWakeDetector(
    PATHS,
    "hey-pi",
    "normal",
    (p, g) => {
      phrases.push(p);
      groups.push(g);
    },
    {
      keywordsJsonText: KEYWORDS_TEXT,
      createSpotter: () => fakeSpotter(script, { accepted: [], resets: 0 }),
      writeKeywordsFile: (content) => {
        written.push(content);
        return "/tmp/fake-send.txt";
      },
      removeKeywordsFile: () => {},
    },
    { includeSend: true },
  );
  det.push(Buffer.alloc(64));
  assert.deepEqual(phrases, ["SEND TO PI"]);
  assert.deepEqual(groups, ["send-to-pi"]);
  assert.ok(written[0]?.includes("▁S END ▁TO ▁PI"));
  det.close();
});

test("both + includeSend writes temp file instead of reusing model file", () => {
  const script: Script = { ready: false, keyword: "" };
  let writes = 0;
  let usedFile = "";
  const det = createWakeDetector(
    PATHS,
    "both",
    "normal",
    () => {},
    {
      keywordsJsonText: KEYWORDS_TEXT,
      createSpotter: (config) => {
        usedFile = config.keywordsFile;
        return fakeSpotter(script, { accepted: [], resets: 0 });
      },
      writeKeywordsFile: (content) => {
        writes += 1;
        assert.ok(content.includes("▁S END ▁TO ▁PI"));
        return "/tmp/send-both.txt";
      },
      removeKeywordsFile: () => {},
    },
    { includeSend: true },
  );
  det.push(Buffer.alloc(64));
  assert.equal(writes, 1);
  assert.equal(usedFile, "/tmp/send-both.txt");
  det.close();
});

test("mapKeywordToPhrase falls back to raw keyword", () => {
  assert.equal(mapKeywordToPhrase("HEY PI", KEYWORDS), "HEY PI");
  assert.equal(mapKeywordToPhrase("  hi pi ", KEYWORDS), "HI PI");
  assert.equal(mapKeywordToPhrase("UNKNOWN WORDS", KEYWORDS), "UNKNOWN WORDS");
});

type FakeStreamState = {
  accepted: Float32Array[];
  resets: number;
  ready: boolean;
  keyword: string;
};

function state(): FakeStreamState {
  return { accepted: [], resets: 0, ready: false, keyword: "" };
}

function totalSamples(s: FakeStreamState): number {
  return s.accepted.reduce((n, a) => n + a.length, 0);
}

function concatSamples(s: FakeStreamState): Float32Array {
  const out = new Float32Array(totalSamples(s));
  let o = 0;
  for (const a of s.accepted) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function twoStreamSpotter(states: FakeStreamState[]): SpotterLike {
  const streams: SpotterStream[] = states.map((st) => ({
    acceptWaveform: (input) => {
      st.accepted.push(input.samples);
    },
  }));
  let next = 0;
  const indexOf = (s: SpotterStream): number => streams.indexOf(s);
  return {
    createStream: () => streams[Math.min(next++, streams.length - 1)] as SpotterStream,
    isReady: (s) => states[indexOf(s)]?.ready ?? false,
    decode: (s) => {
      const st = states[indexOf(s)];
      if (st) st.ready = false;
    },
    reset: (s) => {
      const st = states[indexOf(s)];
      if (st) st.resets += 1;
    },
    getResult: (s) => ({ keyword: states[indexOf(s)]?.keyword ?? "" }),
  };
}

function twoStreamDetector(
  live: FakeStreamState,
  lag: FakeStreamState,
  onWake: (p: string, g: WakeGroup | undefined) => void,
  extra?: { now?: () => number },
): ReturnType<typeof createWakeDetector> {
  return createWakeDetector(PATHS, "both", "normal", onWake, {
    keywordsJsonText: KEYWORDS_TEXT,
    now: extra?.now,
    createSpotter: () => twoStreamSpotter([live, lag]),
    writeKeywordsFile: () => "/tmp/fake-2s.txt",
    removeKeywordsFile: () => {},
  });
}

test("both streams are fed identical audio", () => {
  const live = state();
  const lag = state();
  const det = twoStreamDetector(live, lag, () => {});
  const frame = Buffer.alloc(3200, 7);
  for (let i = 0; i < 20; i++) det.push(frame); // 2 s of audio
  det.close();
  const liveAll = concatSamples(live);
  const lagAll = concatSamples(lag);
  assert.equal(liveAll.length, 20 * 1600);
  assert.equal(lagAll.length, 20 * 1600 - 12000, "lag stream trails by 0.75 s of content");
  assert.deepEqual(Array.from(lagAll), Array.from(liveAll.subarray(0, lagAll.length)));
});

test("staggered stream is held 0.75 s behind", () => {
  const live = state();
  const lag = state();
  const det = twoStreamDetector(live, lag, () => {});
  det.push(Buffer.alloc(16000)); // 0.5 s: live fed, lag gets nothing
  assert.equal(totalSamples(live), 8000);
  assert.equal(totalSamples(lag), 0);
  det.push(Buffer.alloc(16000)); // 1.0 s total: lag releases the oldest 0.25 s
  assert.equal(totalSamples(live), 16000);
  assert.equal(totalSamples(lag), 4000);
  det.close();
});

test("both streams reset on detection", () => {
  const live = state();
  const lag = state();
  live.ready = true;
  live.keyword = "HEY PI";
  const phrases: string[] = [];
  const det = twoStreamDetector(live, lag, (p) => phrases.push(p));
  det.push(Buffer.alloc(3200));
  assert.deepEqual(phrases, ["HEY PI"]);
  assert.ok(live.resets >= 1, "live stream reset");
  assert.ok(lag.resets >= 1, "staggered stream reset");
  det.close();
});

test("detection on either stream fires once within refractory", () => {
  const live = state();
  const lag = state();
  live.ready = true;
  live.keyword = "HEY PI";
  lag.ready = true;
  lag.keyword = "HEY PI";
  const phrases: string[] = [];
  let t = 5000;
  const det = createWakeDetector(PATHS, "both", "normal", (p) => phrases.push(p), {
    keywordsJsonText: KEYWORDS_TEXT,
    now: () => t,
    createSpotter: () => twoStreamSpotter([live, lag]),
    writeKeywordsFile: () => "/tmp/fake-2s.txt",
    removeKeywordsFile: () => {},
  });
  det.push(Buffer.alloc(3200));
  assert.equal(phrases.length, 1, "second stream fire inside window suppressed");
  assert.ok(live.resets >= 1 && lag.resets >= 1, "both streams reset even when deduped");
  det.close();
});

test("reset clears the stagger backlog", () => {
  const live = state();
  const lag = state();
  const det = twoStreamDetector(live, lag, () => {});
  det.push(Buffer.alloc(16000)); // 0.5 s buffered for the lag stream
  det.reset();
  det.push(Buffer.alloc(16000)); // only 0.5 s since reset: lag still gets nothing
  assert.equal(totalSamples(lag), 0, "backlog cleared on reset");
  det.close();
});

test("close disposes both streams", () => {
  const live = state();
  const lag = state();
  const det = twoStreamDetector(live, lag, () => {});
  det.push(Buffer.alloc(3200));
  det.close();
  assert.ok(live.resets >= 1, "live stream reset on close");
  assert.ok(lag.resets >= 1, "staggered stream reset on close");
  const liveTotal = totalSamples(live);
  det.push(Buffer.alloc(3200));
  assert.equal(totalSamples(live), liveTotal, "push after close is ignored");
});
