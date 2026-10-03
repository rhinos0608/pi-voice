export type TranscriptIntent =
  | { kind: "empty" }
  | { kind: "send" }
  | { kind: "dictate"; text: string; thenSend: boolean };

const WAKE_SOURCE = "(?:hey|hi)";
const PI_SOURCE = "(?:pi|pie|py)";
const LEADING_WAKE_RE = new RegExp(`^\\s*${WAKE_SOURCE}\\s+${PI_SOURCE}\\b\\s*,?\\s*`, "i");
const TRAILING_SEND_RE = new RegExp(`\\bsend\\s+to\\s+${PI_SOURCE}\\b[.,!?:;'"\u2018\u2019\u201c\u201d\\s]*$`, "i");
const TRAILING_SEPARATOR_RE = /[\s,;:\-–—'\"‘’“”]+$/;
const PUNCT_RE = /[.,!?;:'"‘’“”]/g;

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(PUNCT_RE, " ")
    .replace(/\bpie\b/g, "pi")
    .replace(/\bpy\b/g, "pi")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLeadingWake(original: string): string {
  return original.replace(LEADING_WAKE_RE, "");
}

function isEffectivelyEmpty(raw: string): boolean {
  return raw.replace(/[\s.,!?;:'"‘’“”\-–—]+/g, "") === "";
}

function trimTrailingSeparators(value: string): string {
  return value.replace(TRAILING_SEPARATOR_RE, "").trim();
}

function removeTrailingSendPhrase(value: string): string {
  return trimTrailingSeparators(value.replace(TRAILING_SEND_RE, ""));
}

function isExactSend(normalized: string): boolean {
  return (
    normalized === "send" ||
    normalized === "send it" ||
    normalized === "submit" ||
    normalized === "send to pi"
  );
}

function endsWithSendPhrase(normalized: string): boolean {
  return /\bsend to pi$/.test(normalized);
}

export function parseTranscriptIntent(raw: string): TranscriptIntent {
  if (isEffectivelyEmpty(raw)) return { kind: "empty" };
  const stripped = stripLeadingWake(raw).trim();
  const normalized = normalizeForMatch(stripped);
  if (normalized === "") return { kind: "empty" };
  if (isExactSend(normalized)) return { kind: "send" };
  if (endsWithSendPhrase(normalized)) {
    const text = removeTrailingSendPhrase(stripped);
    if (text === "" || isEffectivelyEmpty(text)) return { kind: "send" };
    return { kind: "dictate", text, thenSend: true };
  }
  return { kind: "dictate", text: stripped, thenSend: false };
}
