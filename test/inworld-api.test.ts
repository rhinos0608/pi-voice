import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";
import type { ElevenFetch } from "../src/elevenlabs-api.ts";
import {
  INWORLD_LEGACY_VOICES_URL,
  INWORLD_VOICES_URL,
  __clearInworldDiscoveryCache,
  listInworldVoices,
} from "../src/inworld-api.ts";

type Res = { ok: boolean; status: number; body: unknown };
type Call = { url: string; headers: Record<string, string>; signal: AbortSignal };

function stub(calls: Call[], responses: Res[]): ElevenFetch {
  let i = 0;
  return async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url, headers: init.headers, signal: init.signal });
    const res = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: res.ok,
      status: res.status,
      json: async (): Promise<unknown> => res.body,
    };
  };
}

beforeEach(() => {
  __clearInworldDiscoveryCache();
});

describe("inworld listInworldVoices", () => {
  it("sends Basic auth header to the primary endpoint", async () => {
    const calls: Call[] = [];
    const fetchImpl = stub(calls, [{ ok: true, status: 200, body: { voices: [] } }]);
    await listInworldVoices("c2VjcmV0LWtleQ==", { fetchImpl });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith(`${INWORLD_VOICES_URL}?pageSize=500`), calls[0].url);
    assert.equal(calls[0].headers["Authorization"], "Basic c2VjcmV0LWtleQ==");
  });

  it("maps voices and follows nextPageToken", async () => {
    const calls: Call[] = [];
    const fetchImpl = stub(calls, [
      { ok: true, status: 200, body: { voices: [{ voiceId: "v1", displayName: "Ada" }], nextPageToken: "t2" } },
      { ok: true, status: 200, body: { voices: [{ voiceId: "v2" }] } },
    ]);
    const voices = await listInworldVoices("aw==", { fetchImpl });
    assert.deepEqual(voices, [
      { id: "v1", name: "Ada" },
      { id: "v2", name: "v2" },
    ]);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.includes("pageToken=t2"), calls[1].url);
  });

  it("caps paging at 5 pages", async () => {
    const calls: Call[] = [];
    const fetchImpl: ElevenFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, signal: init.signal });
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({ voices: [{ voiceId: `v${calls.length}`, displayName: `V${calls.length}` }], nextPageToken: "more" }),
      };
    };
    const voices = await listInworldVoices("aw==", { fetchImpl });
    assert.equal(calls.length, 5);
    assert.equal(voices.length, 5);
  });

  it("falls back to the legacy endpoint on primary 404", async () => {
    const calls: Call[] = [];
    const fetchImpl: ElevenFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, signal: init.signal });
      if (url.startsWith(INWORLD_VOICES_URL)) return { ok: false, status: 404, json: async () => ({}) };
      assert.equal(url, INWORLD_LEGACY_VOICES_URL);
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => ({ voices: [{ voiceId: "lv1", displayName: "Legacy", languages: ["en"] }] }),
      };
    };
    const voices = await listInworldVoices("aw==", { fetchImpl });
    assert.deepEqual(voices, [{ id: "lv1", name: "Legacy" }]);
  });

  it("parses tolerantly and skips entries without a string voiceId", async () => {
    const calls: Call[] = [];
    const fetchImpl = stub(calls, [
      {
        ok: true,
        status: 200,
        body: {
          voices: [
            { voiceId: "v1", displayName: "Ada", description: "warm", languageCode: "en-US", tags: ["a"] },
            { voiceId: "v2", langCode: "en" },
            { displayName: "NoId" },
            { voiceId: 42, displayName: "Num" },
            null,
            "nope",
          ],
        },
      },
    ]);
    const voices = await listInworldVoices("aw==", { fetchImpl });
    assert.deepEqual(voices, [
      { id: "v1", name: "Ada" },
      { id: "v2", name: "v2" },
    ]);
  });

  it("caches successful results until cleared", async () => {
    const calls: Call[] = [];
    const fetchImpl = stub(calls, [{ ok: true, status: 200, body: { voices: [{ voiceId: "v1", displayName: "Ada" }] } }]);
    const first = await listInworldVoices("aw==", { fetchImpl });
    const second = await listInworldVoices("aw==", { fetchImpl });
    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
    __clearInworldDiscoveryCache();
    await listInworldVoices("aw==", { fetchImpl });
    assert.equal(calls.length, 2);
  });

  it("throws without the key in the message on non-OK", async () => {
    const calls: Call[] = [];
    const fetchImpl = stub(calls, [{ ok: false, status: 500, body: {} }]);
    const secret = "c3VwZXItc2VjcmV0";
    await assert.rejects(() => listInworldVoices(secret, { fetchImpl }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "Voice list failed: HTTP 500");
      assert.ok(!err.message.includes(secret));
      return true;
    });
  });

  it("propagates caller abort to the fetch signal", async () => {
    const calls: Call[] = [];
    let seen: AbortSignal | null = null;
    const fetchImpl: ElevenFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, signal: init.signal });
      seen = init.signal;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const ctrl = new AbortController();
    const pending = listInworldVoices("aw==", { fetchImpl, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(() => pending);
    assert.ok(seen !== null);
  });

  it("aborts the fetch signal after the timeout", async () => {
    const { INWORLD_DISCOVERY_TIMEOUT_MS } = await import("../src/inworld-api.ts");
    assert.equal(INWORLD_DISCOVERY_TIMEOUT_MS, 8000);
    let seen: AbortSignal | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = ((cb: (...args: unknown[]) => void, _ms?: number, ...args: unknown[]) => {
      timer = realSetTimeout(cb, 1, ...args);
      return timer;
    }) as typeof setTimeout;
    try {
      const fetchImpl: ElevenFetch = (url, init) =>
        new Promise((_resolve, reject) => {
          seen = init.signal;
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      await assert.rejects(() => listInworldVoices("aw==", { fetchImpl }));
      assert.ok(seen !== null && (seen as AbortSignal).aborted);
    } finally {
      (globalThis as unknown as { setTimeout: unknown }).setTimeout = realSetTimeout;
    }
  });
});
