/** Incremental Markdown-to-speech normalizer (lane D). */

export type SpeechChunker = {
  push(delta: string): void;
  finish(): void;
  cancel(): void;
  /** Test-only: current withheld raw length, to assert bounded buffering. */
  __debugRawLength?(): number;
};

const MIN_RELEASE = 120;
const PREFER_MAX = 300;
const FORCE_MAX = 400;
/** Max chars withheld past an incomplete construct start before forced recovery. */
const HOLD_CAP = 300;

function normalizeVisible(text: string): string {
  let out = text;
  out = out.replace(/`[^`]*`/g, " ");
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  out = out.replace(/https?:\/\/\S+/g, " ");
  out = out.replace(/\|/g, " ");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)/gm, "");
  out = out.replace(/(\*\*|__)(.*?)\1/g, "$2");
  out = out.replace(/(^|[\s(])[*_]([^*_]+)[*_]/g, "$1$2");
  out = out.replace(/~~(.*?)~~/g, "$1");
  out = out.replace(/[ \t]+/g, " ");
  return out;
}

/** Incremental fence/inline-code filter state (shared rules for feed + hold scan). */
type FilterState = { fence: "```" | "~~~" | null; inlineLen: number };

/**
 * Strip fenced blocks and inline code spans, returning visible text.
 * Inline code follows CommonMark run-length: a run of N backticks opens a
 * span closed only by a run of exactly N. Fence markers (``` / ~~~) win over
 * backtick runs, matching prior behavior. An unmatched backtick run is
 * literal text (CommonMark): only the backticks are dropped and the held
 * prose is filtered/spoken normally. Unclosed fences still drop their tail.
 */
function filterRaw(raw: string, st: FilterState): string {
  const src = stripAbandonedInlineOpeners(raw, st.fence);
  let i = 0;
  let visible = "";
  while (i < src.length) {
    if (st.fence !== null) {
      const idx = src.indexOf(st.fence, i);
      if (idx === -1) return visible;
      i = idx + 3;
      st.fence = null;
    } else if (src.startsWith("```", i) || src.startsWith("~~~", i)) {
      st.fence = src.startsWith("```", i) ? "```" : "~~~";
      i += 3;
    } else if (src[i] === "`") {
      let j = i;
      while (j < src.length && src[j] === "`") j++;
      const run = j - i;
      if (st.inlineLen === 0) st.inlineLen = run;
      else if (run === st.inlineLen) st.inlineLen = 0;
      i = j;
    } else if (st.inlineLen > 0) {
      i += 1;
    } else {
      visible += src[i];
      i += 1;
    }
  }
  return visible;
}

/**
 * Remove the opening backtick run of any inline span crossed by a paragraph
 * break (blank line) before its closer. Code spans cannot cross paragraphs,
 * so the opener is literal: dropping just the backticks lets the held prose
 * flow through normal filtering. Fenced blocks are honored, not touched.
 */
function stripAbandonedInlineOpeners(s: string, inFence: string | null): string {
  let fence: string | null = inFence;
  let openLen = 0;
  let openPos = -1;
  const dead: Array<[number, number]> = [];
  let i = 0;
  while (i < s.length) {
    if (fence !== null) {
      const idx = s.indexOf(fence, i);
      if (idx === -1) break;
      i = idx + 3;
      fence = null;
    } else if (s.startsWith("```", i) || s.startsWith("~~~", i)) {
      fence = s.startsWith("```", i) ? "```" : "~~~";
      i += 3;
    } else if (s[i] === "`") {
      let j = i;
      while (j < s.length && s[j] === "`") j++;
      const run = j - i;
      if (openLen === 0) {
        openLen = run;
        openPos = i;
      } else if (run === openLen) {
        openLen = 0;
        openPos = -1;
      }
      i = j;
    } else if (openLen > 0 && s[i] === "\n" && /^\n[ \t]*\n/.test(s.slice(i))) {
      dead.push([openPos, openPos + openLen]);
      openLen = 0;
      openPos = -1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (dead.length === 0) return s;
  let out = "";
  let at = 0;
  for (const [a, b] of dead) {
    out += s.slice(at, a);
    at = b;
  }
  return out + s.slice(at);
}

type HoldKind = "code" | "url" | "link" | "emphasis";

/** True when s ends inside an unclosed fenced block. */
function fenceActive(s: string): boolean {
  let fence: string | null = null;
  let i = 0;
  while (i < s.length) {
    if (fence !== null) {
      const idx = s.indexOf(fence, i);
      if (idx === -1) return true;
      i = idx + 3;
      fence = null;
    } else if (s.startsWith("```", i) || s.startsWith("~~~", i)) {
      fence = s.startsWith("```", i) ? "```" : "~~~";
      i += 3;
    } else {
      i += 1;
    }
  }
  return fence !== null;
}

/** Length of the code opener (backtick run or ~~) at the start of held. */
function codeOpenerLen(held: string): number {
  let n = 0;
  while (n < held.length && held[n] === "`") n++;
  if (n > 0) return n;
  if (held.startsWith("~~")) return 2;
  return 0;
}

/** Start index of an unclosed fence/span in s, or -1 when the tail is certain. */
function codeHoldStart(s: string): number {
  const st: FilterState = { fence: null, inlineLen: 0 };
  let fenceStart = -1;
  let inlineStart = -1;
  let i = 0;
  while (i < s.length) {
    if (st.fence !== null) {
      const idx = s.indexOf(st.fence, i);
      if (idx === -1) return fenceStart;
      i = idx + 3;
      st.fence = null;
      fenceStart = -1;
    } else if (s.startsWith("```", i) || s.startsWith("~~~", i)) {
      st.fence = s.startsWith("```", i) ? "```" : "~~~";
      fenceStart = i;
      i += 3;
    } else if (s[i] === "`") {
      let j = i;
      while (j < s.length && s[j] === "`") j++;
      const run = j - i;
      if (st.inlineLen === 0) {
        st.inlineLen = run;
        inlineStart = i;
      } else if (run === st.inlineLen) {
        st.inlineLen = 0;
        inlineStart = -1;
      }
      i = j;
    } else if (st.inlineLen > 0 && s[i] === "\n" && /^\n[ \t]*\n/.test(s.slice(i))) {
      // Code spans cannot cross paragraphs: the opener was literal prose,
      // so forget it and let the tail resolve without the span holding it.
      st.inlineLen = 0;
      inlineStart = -1;
      i += 1;
    } else {
      i += 1;
    }
  }
  if (st.fence !== null) return fenceStart;
  if (st.inlineLen > 0) return inlineStart;
  return -1;
}

/** Extend a link-tail hold back to its opening bracket so label+destination stay atomic. */
function linkConstructStart(s: string, tailAt: number): number {
  const open = s.lastIndexOf("[", tailAt);
  if (open !== -1) {
    const bang = open > 0 && s[open - 1] === "!" ? open - 1 : open;
    return bang;
  }
  return tailAt;
}

/** Length + kind of the trailing incomplete construct to withhold, if any. */
function trailingHold(s: string): { length: number; kind: HoldKind | null } {
  const starts: { start: number; kind: HoldKind }[] = [];
  const codeAt = codeHoldStart(s);
  if (codeAt !== -1) starts.push({ start: codeAt, kind: "code" });
  const url = s.match(/https?:\/\/\S*$/);
  if (url?.[0].length) {
    let start = s.length - url[0].length;
    // A URL that is a link destination keeps label + destination atomic.
    if (s.slice(0, start).endsWith("](")) start = linkConstructStart(s, start - 2);
    starts.push({ start, kind: "url" });
  }
  const bracket = s.match(/\[[^\]]*$/);
  if (bracket) {
    const at = s.length - bracket[0].length;
    starts.push({ start: linkConstructStart(s, at), kind: "link" });
  }
  const dest = s.match(/\]\([^()]*$/);
  if (dest) {
    const at = s.length - dest[0].length;
    starts.push({ start: linkConstructStart(s, at), kind: "link" });
  }
  const labelEnd = s.match(/\][^\s()]*$/);
  if (labelEnd) {
    const at = s.length - labelEnd[0].length;
    starts.push({ start: linkConstructStart(s, at), kind: "link" });
  }
  const tildes = s.match(/~~$/);
  if (tildes) starts.push({ start: s.length - tildes[0].length, kind: "code" });
  const bangOnly = s.match(/!$/);
  if (bangOnly) starts.push({ start: s.length - 1, kind: "link" });
  const doubles = s.match(/\*\*[\s\S]*$|__[\s\S]*$/);
  if (doubles) {
    const marker = doubles[0].startsWith("**") ? "**" : "__";
    const count = s.split(marker).length - 1;
    if (count % 2 === 1) starts.push({ start: s.lastIndexOf(marker), kind: "emphasis" });
  }
  const single = s.match(/(^|[\s(])[*_][^\s]*$/);
  if (single?.[0]) {
    const marker = single[0].trimStart()[0] as string;
    const token = single[0].trimStart();
    const count = token.split(marker).length - 1;
    if (count % 2 === 1) starts.push({ start: s.length - token.length, kind: "emphasis" });
  }
  const token = s.match(/(^|\s)(\S+)$/)?.[2] ?? "";
  const tokenStart = s.length - token.length;
  // Partial URL scheme ("h".."https:/"): the only case the atomic scans
  // above cannot see, since "://" has not arrived yet. All code/link/
  // emphasis cases are covered atomically above (never split on whitespace).
  if (token.length > 0 && /^[a-zA-Z:/?]*$/.test(token) && "https://".startsWith(token.toLowerCase()) && token.length < 8) {
    const lower = token.toLowerCase();
    if (lower !== "https://") starts.push({ start: tokenStart, kind: "url" });
  }
  if (starts.length === 0) return { length: 0, kind: null };
  let best = starts[0] as { start: number; kind: HoldKind };
  for (const c of starts) if (c.start < best.start) best = c;
  return { length: s.length - best.start, kind: best.kind };
}

/**
 * Finalize a withheld tail at finish(): drop incomplete fences, URLs, and
 * link destinations; recover emphasis text minus markers, lone-bracket
 * prose, and unmatched backtick spans (CommonMark literal: backticks dropped,
 * held prose filtered/spoken normally). Unclosed fences still drop content.
 */
function finalizeHeld(held: string, kind: HoldKind | null): string {
  if (held.length === 0 || kind === null) return "";
  if (kind === "code") {
    if (held.startsWith("```") || held.startsWith("~~~")) return "";
    if (held.startsWith("`")) return held.replace(/`/g, "");
    return "";
  }
  if (kind === "url") return "";
  if (kind === "link") {
    if (held.includes("](")) return ""; // label + partial destination dropped together
    return held.replace(/[\[\]]/g, "");
  }
  return held.replace(/\*\*|__/g, "");
}

/**
 * Create a chunker that strips Markdown/code and emits speakable chunks.
 * Fenced-code state (``` / ~~~) survives delta boundaries, including
 * fence markers split across pushes. Raw text accumulates in a buffer and
 * only the certain prefix is filtered per push: a trailing incomplete
 * construct (unclosed fence/code span, unterminated URL, unclosed link, or
 * open emphasis) is held back until it completes or finish() is called.
 */
export function createSpeechChunker(emit: (chunk: string) => void): SpeechChunker {
  let pending = "";
  const filter: FilterState = { fence: null, inlineLen: 0 };
  let rawBuf = "";
  let closed = false;

  function pushDelta(delta: string): void {
    rawBuf += delta;
    enforceHoldCap();
    const h = trailingHold(rawBuf);
    const safe = rawBuf.slice(0, rawBuf.length - h.length);
    rawBuf = rawBuf.slice(rawBuf.length - h.length);
    if (safe.length > 0) pending += normalizeVisible(filterRaw(safe, filter));
    release();
  }

  /**
   * Bound the withheld tail: when an incomplete construct holds more than
   * HOLD_CAP chars, recover by kind so streaming never stalls. Link/emphasis
   * openers are treated as literal prose (markers dropped) and the excess is
   * released; unterminated URLs and unclosed fences are dropped; an unclosed
   * backtick span over HOLD_CAP is literal (opener dropped, prose released).
   * Long fences keep only marker + tail since content is dropped either way.
   */
  function enforceHoldCap(): void {
    for (let guard = 0; guard < 10; guard++) {
      const h = trailingHold(rawBuf);
      if (h.kind === null || h.length <= HOLD_CAP) return;
      const heldStart = rawBuf.length - h.length;
      if (h.kind === "url") {
        // Keep the scheme head so the fragment still reads as a URL token
        // (dropping it all would let the tail through as prose); drop the middle.
        const headKeep = 16;
        if (rawBuf.length <= heldStart + headKeep + HOLD_CAP) return;
        rawBuf = rawBuf.slice(0, heldStart + headKeep) + rawBuf.slice(rawBuf.length - HOLD_CAP);
        continue;
      }
      if (h.kind === "code") {
        if (!fenceActive(rawBuf) && rawBuf.slice(heldStart).startsWith("`")) {
          // Unmatched backtick run is literal: drop just the opener and let
          // the prose release through normal filtering on the next pass.
          rawBuf = rawBuf.slice(0, heldStart) + rawBuf.slice(heldStart + codeOpenerLen(rawBuf.slice(heldStart)));
          continue;
        }
        const keepFrom = fenceActive(rawBuf) ? heldStart + 3 : heldStart + codeOpenerLen(rawBuf.slice(heldStart));
        rawBuf = rawBuf.slice(0, keepFrom) + rawBuf.slice(rawBuf.length - HOLD_CAP);
        continue;
      }
      const excess = h.length - HOLD_CAP;
      let chunk = rawBuf.slice(heldStart, heldStart + excess);
      if (h.kind === "link") chunk = chunk.replace(/!/g, "").replace(/[\[\]]/g, "");
      else chunk = chunk.replace(/\*\*|__/g, "").replace(/[*_]/g, "");
      const prefix = rawBuf.slice(0, heldStart);
      rawBuf = rawBuf.slice(heldStart + excess);
      if (prefix.length > 0 || chunk.length > 0) pending += normalizeVisible(filterRaw(prefix + chunk, filter));
      return;
    }
  }

  function lastSentenceEnd(limit: number): number {
    const slice = pending.slice(0, limit);
    let at = -1;
    for (let i = 0; i < slice.length - 1; i++) {
      const c = slice[i];
      if ((c === "." || c === "!" || c === "?") && /\s/.test(slice[i + 1] ?? "")) {
        at = i + 1;
      }
    }
    return at;
  }

  function release(): void {
    for (;;) {
      if (pending.length < MIN_RELEASE && pending.length <= PREFER_MAX) return;
      let cut = -1;
      if (pending.length >= MIN_RELEASE) {
        cut = lastSentenceEnd(Math.min(pending.length, PREFER_MAX));
      }
      if (cut === -1 && pending.length >= FORCE_MAX) {
        const window = pending.slice(0, FORCE_MAX + 1);
        const ws = window.search(/\s(?!.*\s)/);
        cut = ws === -1 ? FORCE_MAX : ws + 1;
      }
      if (cut === -1) return;
      const chunk = pending.slice(0, cut).replace(/\s+/g, " ").trim();
      pending = pending.slice(cut).replace(/^\s+/, "");
      if (chunk.length > 0) emit(chunk);
    }
  }

  return {
    push(delta: string): void {
      if (closed || delta.length === 0) return;
      pushDelta(delta);
    },
    finish(): void {
      if (closed) return;
      closed = true;
      const h = trailingHold(rawBuf);
      const safe = rawBuf.slice(0, rawBuf.length - h.length);
      const held = rawBuf.slice(rawBuf.length - h.length);
      rawBuf = "";
      if (safe.length > 0) pending += normalizeVisible(filterRaw(safe, filter));
      const recovered = finalizeHeld(held, h.kind);
      if (recovered.length > 0) {
        pending += normalizeVisible(filterRaw(recovered, { fence: null, inlineLen: 0 }));
      }
      release();
      const tail = pending.replace(/\s+/g, " ").trim();
      pending = "";
      if (tail.length > 0) emit(tail);
    },
    cancel(): void {
      closed = true;
      pending = "";
      rawBuf = "";
    },
    __debugRawLength(): number {
      return rawBuf.length;
    },
  };
}
