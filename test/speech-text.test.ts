import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSpeechChunker } from "../src/speech-text.ts";

function collect(): { chunks: string[]; emit: (c: string) => void } {
  const chunks: string[] = [];
  return { chunks, emit: (c: string): void => void chunks.push(c) };
}

describe("speech-text chunker", () => {
  it("releases sentences and flushes the tail on finish", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("Hello there, this is a reasonably long opening sentence that keeps going past the release floor. ");
    c.push("Second sentence follows shortly after the first one ends. ");
    assert.ok(chunks.length >= 1);
    assert.ok(chunks[0].startsWith("Hello there"));
    c.finish();
    assert.ok(chunks.join(" ").includes("Second sentence"));
  });

  it("drops fenced code split across deltas", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("Intro prose here. ``");
    c.push("`js\nconst x = 1;\n``` Tail prose after the fence block ends here. ");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("const x"));
    assert.ok(all.includes("Intro prose"));
    assert.ok(all.includes("Tail prose"));
  });

  it("drops tilde fences split across deltas", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("Before the block. ~~");
    c.push("~\nsecret()\n~~~\nAfter the block closes cleanly here. ");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("secret"));
    assert.ok(all.includes("Before the block"));
    assert.ok(all.includes("After the block"));
  });

  it("drops inline code, raw URLs, and link destinations but keeps labels", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("Use `rm -rf` never, see https://example.com/x and [the guide](https://example.com/guide) for details here. ");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("rm -rf"));
    assert.ok(!all.includes("https://"));
    assert.ok(!all.includes("example.com/guide"));
    assert.ok(all.includes("the guide"));
  });

  it("strips heading, list, and emphasis markers", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("## Big Title here\n\n- first item listed\n- second item listed\n\nSome **bold** and *soft* words in a line here. ");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("##"));
    assert.ok(!all.includes("**"));
    assert.ok(!all.includes("- first"));
    assert.ok(all.includes("Big Title"));
    assert.ok(all.includes("bold"));
  });

  it("force-splits long text without sentence punctuation at whitespace", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push(`${"word ".repeat(120)}done. `);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.every((s) => s.length <= 450));
    c.finish();
    assert.ok(chunks.join(" ").includes("done"));
  });

  it("cancel discards buffered text", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("This tail should never be spoken aloud by anyone. ");
    c.cancel();
    c.finish();
    assert.equal(chunks.length, 0);
  });

  it("strips table pipes", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("The table shows | name | value | pairs in a row of text that is long enough to flush out now. ");
    c.finish();
    assert.ok(!chunks.join(" ").includes("|"));
  });

  it("adversarial splits never leak code, URLs, or destinations", () => {
    const cases: { name: string; raw: string; forbidden: string[]; prose: string[] }[] = [
      {
        name: "url",
        raw: "Start here Read https://example.com/secret then continue onward. ",
        forbidden: ["example.com", "secret", "https://"],
        prose: ["Start here Read", "then continue onward."],
      },
      {
        name: "link",
        raw: "Start here see [the guide](https://example.com/guide) then continue onward. ",
        forbidden: ["example.com/guide", "https://", "]("],
        prose: ["Start here see", "the guide", "then continue onward."],
      },
      {
        name: "image",
        raw: "Start here look ![alt text](https://example.com/img.png) then continue onward. ",
        forbidden: ["example.com/img", "https://", "]("],
        prose: ["Start here look", "alt text", "then continue onward."],
      },
      {
        name: "inline-single",
        raw: "Start here use `rm -rf` never then continue onward. ",
        forbidden: ["rm -rf"],
        prose: ["Start here use", "never then continue onward."],
      },
      {
        name: "inline-nested",
        raw: "Start here use `` a ` b `` never then continue onward. ",
        forbidden: [" a ` b "],
        prose: ["Start here use", "never then continue onward."],
      },
      {
        name: "fence",
        raw: "Start here. ```js\nconst x = 1;\n``` Tail prose after the fence. ",
        forbidden: ["const x"],
        prose: ["Start here.", "Tail prose after the fence."],
      },
      {
        name: "emphasis-bold",
        raw: "Start here some **bold words** then continue onward. ",
        forbidden: ["**"],
        prose: ["Start here some", "bold words", "then continue onward."],
      },
      {
        name: "emphasis-underscore",
        raw: "Start here some __flat words__ then continue onward. ",
        forbidden: ["__"],
        prose: ["Start here some", "flat words", "then continue onward."],
      },
    ];
    for (const t of cases) {
      for (let split = 0; split <= t.raw.length; split++) {
        const { chunks, emit } = collect();
        const c = createSpeechChunker(emit);
        c.push(t.raw.slice(0, split));
        c.push(t.raw.slice(split));
        // Mid-stream emissions must already be clean: check before finish too.
        const mid = chunks.join(" ").replace(/\s+/g, " ");
        for (const f of t.forbidden) {
          assert.ok(!mid.includes(f), `${t.name}@${split}: leaked ${JSON.stringify(f)} mid-stream in ${JSON.stringify(mid)}`);
        }
        c.finish();
        const all = chunks.join(" ").replace(/\s+/g, " ");
        for (const f of t.forbidden) {
          assert.ok(!all.includes(f), `${t.name}@${split}: leaked ${JSON.stringify(f)} in ${JSON.stringify(all)}`);
        }
        let pos = 0;
        for (const p of t.prose) {
          const at = all.indexOf(p, pos);
          assert.ok(at >= pos, `${t.name}@${split}: prose ${JSON.stringify(p)} missing/ordered in ${JSON.stringify(all)}`);
          pos = at + p.length;
        }
        const stripped = t.prose.join(" ").replace(/\s+/g, " ");
        assert.equal(all.trim(), stripped, `${t.name}@${split}: prose not exactly-once`);
      }
    }
  });

  it("unclosed bracket releases prose incrementally with marker dropped", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    const prose = "This is a full sentence of prose here. ".repeat(150);
    c.push(`[${prose}`);
    const streamed = chunks.length;
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("["));
    assert.ok(streamed >= 3, `expected incremental emission during push, got ${streamed}`);
    assert.ok(chunks.every((s) => s.length <= 450));
    assert.ok(all.includes("This is a full sentence of prose here."));
  });

  it("unclosed bold opener releases prose incrementally", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    const prose = "Bold prose sentence flows onward here. ".repeat(150);
    c.push(`**${prose}`);
    const streamed = chunks.length;
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("**"));
    assert.ok(streamed >= 3, `expected incremental emission during push, got ${streamed}`);
    assert.ok(chunks.every((s) => s.length <= 450));
    assert.ok(all.includes("Bold prose sentence flows onward here."));
  });

  it("drops a very long unterminated URL token and speaks prose after", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    const token = `https://${"a".repeat(2000)}`;
    let peak = 0;
    for (const ch of token) {
      c.push(ch);
      const n = (c as unknown as { __debugRawLength(): number }).__debugRawLength();
      if (n > peak) peak = n;
    }
    c.push(" After the token comes real spoken prose here.");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("aaaa"));
    assert.ok(all.includes("After the token comes real spoken prose here."));
    assert.ok(peak <= 1200, `rawBuf peak ${peak} exceeds bound`);
  });

  it("treats a long unclosed inline code span as literal prose (wrong-drop regression)", () => {
    // Earlier revision asserted this spoke nothing; that encoded a wrong
    // instruction. CommonMark: unmatched backticks are literal text.
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    const code = `\`${"secretcode ".repeat(400)}`;
    let peak = 0;
    for (const ch of code) {
      c.push(ch);
      const n = (c as unknown as { __debugRawLength(): number }).__debugRawLength();
      if (n > peak) peak = n;
    }
    c.finish();
    assert.ok(chunks.join(" ").includes("secretcode"));
    assert.ok(!chunks.join(" ").includes("`"));
    assert.ok(peak <= 1200, `rawBuf peak ${peak} exceeds bound`);
  });

  it("speaks all prose around an unclosed backtick fed char-by-char", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    const prose = "This is plain prose that should be spoken aloud. ".repeat(80);
    const raw = `Start. \`${prose} End.`;
    for (const ch of raw) c.push(ch);
    c.finish();
    const all = chunks.join(" ").replace(/\s+/g, " ");
    assert.ok(all.includes("Start."));
    assert.ok(all.includes("End."));
    assert.ok(all.includes("plain prose that should be spoken aloud."));
    assert.equal(all.split("End.").length - 1, 1, `End. spoken exactly once in ${JSON.stringify(all.slice(-120))}`);
    assert.ok(chunks.every((s) => s.length <= 400));
  });

  it("releases prose after a paragraph break following an unclosed backtick", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("Before the break `with dangling code prose. \n\nAfter the paragraph break comes spoken prose here. ");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(all.includes("Before the break"));
    assert.ok(all.includes("After the paragraph break comes spoken prose here."));
    assert.ok(!all.includes("`"));
  });

  it("still drops a matched short inline code span", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    c.push("Use `rm -rf` never, then continue onward with spoken prose here. ");
    c.finish();
    const all = chunks.join(" ");
    assert.ok(!all.includes("rm -rf"));
    assert.ok(all.includes("then continue onward"));
  });

  it("keeps rawBuf bounded inside a long fence fed char-by-char", () => {
    const { chunks, emit } = collect();
    const c = createSpeechChunker(emit);
    const fence = "```\n" + "code line\n".repeat(2000);
    let peak = 0;
    for (const ch of fence) {
      c.push(ch);
      const n = (c as unknown as { __debugRawLength(): number }).__debugRawLength();
      if (n > peak) peak = n;
    }
    c.finish();
    assert.ok(!chunks.join(" ").includes("code line"));
    assert.ok(peak <= 1200, `rawBuf peak ${peak} exceeds bound`);
  });
});
