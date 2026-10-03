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
  assert.equal(seen.resets, 1);
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
