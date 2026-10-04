/** Inworld voice discovery: list voices from the Voices API with legacy fallback. */

import type { ElevenFetch, VoiceEntry } from "./elevenlabs-api.ts";

export const INWORLD_VOICES_URL = "https://api.inworld.ai/voices/v1/voices";
export const INWORLD_LEGACY_VOICES_URL = "https://api.inworld.ai/tts/v1/voices";
export const INWORLD_VOICE_LIST_CAP_PAGES = 5;
export const INWORLD_PAGE_SIZE = 500;
export const INWORLD_DISCOVERY_TIMEOUT_MS = 8000;
export const INWORLD_DISCOVERY_CACHE_MS = 5 * 60 * 1000;

type CacheEntry = { at: number; value: VoiceEntry[] };

let cache: CacheEntry | null = null;

export function __clearInworldDiscoveryCache(): void {
  cache = null;
}

function defaultFetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): ReturnType<ElevenFetch> {
  return (async () => {
    const res = await fetch(url, { headers: init.headers, signal: init.signal });
    return {
      ok: res.ok,
      status: res.status,
      json: (): Promise<unknown> => res.json() as Promise<unknown>,
    };
  })();
}

function withTimeout(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), INWORLD_DISCOVERY_TIMEOUT_MS);
  if (signal !== undefined) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function mapVoice(raw: unknown): VoiceEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as { voiceId?: unknown; displayName?: unknown };
  if (typeof rec.voiceId !== "string" || rec.voiceId === "") return null;
  const name = typeof rec.displayName === "string" && rec.displayName !== "" ? rec.displayName : rec.voiceId;
  return { id: rec.voiceId, name };
}

/**
 * List Inworld voices via the Voices API, following nextPageToken up to a
 * page cap. Falls back to the deprecated TTS voices endpoint on 404.
 * Results are cached in memory for a few minutes.
 */
export async function listInworldVoices(
  key: string,
  opts?: { fetchImpl?: ElevenFetch; signal?: AbortSignal },
): Promise<VoiceEntry[]> {
  if (cache !== null && Date.now() - cache.at < INWORLD_DISCOVERY_CACHE_MS) return cache.value;
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const headers = { Authorization: `Basic ${key}` };
  let pageToken: string | undefined;
  const out: VoiceEntry[] = [];
  let fellBack = false;
  for (let page = 0; page < INWORLD_VOICE_LIST_CAP_PAGES; page++) {
    const url =
      `${INWORLD_VOICES_URL}?pageSize=${INWORLD_PAGE_SIZE}` +
      (pageToken !== undefined ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const t = withTimeout(opts?.signal);
    try {
      const res = await fetchImpl(url, { headers, signal: t.signal });
      if (!res.ok) {
        if (res.status === 404 && !fellBack && page === 0 && pageToken === undefined) {
          fellBack = true;
          const legacy = await fetchLegacy(fetchImpl, headers, opts?.signal);
          cache = { at: Date.now(), value: legacy };
          return legacy;
        }
        throw new Error(`Voice list failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { voices?: unknown; nextPageToken?: unknown };
      const voices = Array.isArray(body.voices) ? body.voices : [];
      for (const raw of voices) {
        const entry = mapVoice(raw);
        if (entry !== null) out.push(entry);
      }
      pageToken =
        typeof body.nextPageToken === "string" && body.nextPageToken !== "" ? body.nextPageToken : undefined;
      if (pageToken === undefined) break;
    } finally {
      t.done();
    }
  }
  cache = { at: Date.now(), value: out };
  return out;
}

async function fetchLegacy(
  fetchImpl: ElevenFetch,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<VoiceEntry[]> {
  const t = withTimeout(signal);
  try {
    const res = await fetchImpl(INWORLD_LEGACY_VOICES_URL, { headers, signal: t.signal });
    if (!res.ok) throw new Error(`Voice list failed: HTTP ${res.status}`);
    const body = (await res.json()) as { voices?: unknown };
    const voices = Array.isArray(body.voices) ? body.voices : [];
    const out: VoiceEntry[] = [];
    for (const raw of voices) {
      const entry = mapVoice(raw);
      if (entry !== null) out.push(entry);
    }
    return out;
  } finally {
    t.done();
  }
}
