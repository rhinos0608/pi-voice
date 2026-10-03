import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscriptIntent } from "../src/intent.ts";

type Case = { name: string; input: string; expected: unknown };

const cases: Case[] = [
  { name: "empty string", input: "", expected: { kind: "empty" } },
  { name: "whitespace only", input: "  ", expected: { kind: "empty" } },
  { name: "punctuation only", input: "...", expected: { kind: "empty" } },
  { name: "comma soup", input: " , , ", expected: { kind: "empty" } },

  { name: "bare send", input: "send", expected: { kind: "send" } },
  { name: "send with period", input: "Send it.", expected: { kind: "send" } },
  { name: "send it bare", input: "send it", expected: { kind: "send" } },
  { name: "submit", input: "submit", expected: { kind: "send" } },
  { name: "submit punctuated", input: "Submit!", expected: { kind: "send" } },
  { name: "send to pi", input: "send to pi", expected: { kind: "send" } },
  { name: "send to pie variant", input: "Send to pie!", expected: { kind: "send" } },
  { name: "send to py variant", input: "send to py", expected: { kind: "send" } },
  { name: "wake plus send", input: "Hey Pi, send.", expected: { kind: "send" } },
  { name: "hi pi send it", input: "hi pi send it", expected: { kind: "send" } },
  { name: "wake pie spelling send", input: "hey pie send", expected: { kind: "send" } },
  { name: "wake py spelling submit", input: "hi py, submit", expected: { kind: "send" } },
  { name: "wake plus send to pi", input: "Hey Pi, send to pi", expected: { kind: "send" } },
  { name: "lone wake is empty", input: "Hey Pi,", expected: { kind: "empty" } },

  {
    name: "dictate with trailing send",
    input: "Fix the failing test. Send to Pi.",
    expected: { kind: "dictate", text: "Fix the failing test.", thenSend: true },
  },
  {
    name: "trailing comma trimmed",
    input: "Fix the test, send to pi",
    expected: { kind: "dictate", text: "Fix the test", thenSend: true },
  },
  {
    name: "trailing dash trimmed",
    input: "Fix the test - send to pi",
    expected: { kind: "dictate", text: "Fix the test", thenSend: true },
  },
  {
    name: "casing preserved",
    input: "Add the API Endpoint Now Send To Pi",
    expected: { kind: "dictate", text: "Add the API Endpoint Now", thenSend: true },
  },
  {
    name: "inner punctuation preserved",
    input: "Hey Pi, fix the bug, then send to pi",
    expected: { kind: "dictate", text: "fix the bug, then", thenSend: true },
  },
  {
    name: "only trailing phrase after wake is send",
    input: "Hey Pi send to pi",
    expected: { kind: "send" },
  },
  {
    name: "pie trailing variant",
    input: "Ship it send to pie",
    expected: { kind: "dictate", text: "Ship it", thenSend: true },
  },

  {
    name: "plain dictation",
    input: "Fix the failing test",
    expected: { kind: "dictate", text: "Fix the failing test", thenSend: false },
  },
  {
    name: "wake stripped dictation",
    input: "Hey Pi, fix the failing test",
    expected: { kind: "dictate", text: "fix the failing test", thenSend: false },
  },
  {
    name: "send mid-sentence is dictation",
    input: "Please send the report tomorrow",
    expected: {
      kind: "dictate",
      text: "Please send the report tomorrow",
      thenSend: false,
    },
  },

  {
    name: "negative: pipeline",
    input: "send to the pipeline",
    expected: { kind: "dictate", text: "send to the pipeline", thenSend: false },
  },
  {
    name: "negative: resend",
    input: "resend to pi",
    expected: { kind: "dictate", text: "resend to pi", thenSend: false },
  },
  {
    name: "negative: server",
    input: "send it to the server",
    expected: { kind: "dictate", text: "send it to the server", thenSend: false },
  },
  {
    name: "negative: form",
    input: "please submit the form",
    expected: { kind: "dictate", text: "please submit the form", thenSend: false },
  },
  {
    name: "negative: pizza",
    input: "send to pizza place",
    expected: { kind: "dictate", text: "send to pizza place", thenSend: false },
  },
  {
    name: "negative: pipeline trailing",
    input: "Push the fix send to the pipeline",
    expected: {
      kind: "dictate",
      text: "Push the fix send to the pipeline",
      thenSend: false,
    },
  },
];

for (const c of cases) {
  test(c.name, () => {
    assert.deepEqual(parseTranscriptIntent(c.input), c.expected);
  });
}
