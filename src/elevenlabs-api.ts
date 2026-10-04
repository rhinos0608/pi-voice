/** ElevenLabs REST discovery for lane E: voice and TTS-model listing. */

export type VoiceEntry = {
  id: string;
  name: string;
};

export type ElevenFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export const VOICE_LIST_CAP_PAGES = 5;
export const VOICE_PAGE_SIZE = 100;
export const DISCOVERY_TIMEOUT_MS = 8000;
export const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

export const OFFLINE_TTS_MODELS = ["eleven_flash_v2_5"];

type CacheEntry<T> = { at: number; value: T };

let voicesCache: CacheEntry<VoiceEntry[]> | null = null;
let modelsCache: CacheEntry<string[]> | null = null;

export function __clearDiscoveryCache(): void {
  voicesCache = null;
  modelsCache = null;
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
  const timer = setTimeout(() => ctrl.abort(), DISCOVERY_TIMEOUT_MS);
  if (signal !== undefined) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

/**
 * List voices via GET /v2/voices, following next_page_token up to a page
 * cap. Results are cached in memory for a few minutes.
 */
export async function listVoices(
  key: string,
  opts?: { fetchImpl?: ElevenFetch; signal?: AbortSignal },
): Promise<VoiceEntry[]> {
  if (voicesCache !== null && Date.now() - voicesCache.at < DISCOVERY_CACHE_MS) return voicesCache.value;
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const out: VoiceEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < VOICE_LIST_CAP_PAGES; page++) {
    const url =
      `https://api.elevenlabs.io/v2/voices?page_size=${VOICE_PAGE_SIZE}` +
      (pageToken !== undefined ? `&page_token=${encodeURIComponent(pageToken)}` : "");
    const t = withTimeout(opts?.signal);
    try {
      const res = await fetchImpl(url, { headers: { "xi-api-key": key }, signal: t.signal });
      if (!res.ok) throw new Error(`Voice list failed: HTTP ${res.status}`);
      const body = (await res.json()) as {
        voices?: { voice_id?: unknown; name?: unknown }[];
        next_page_token?: unknown;
      };
      for (const v of body.voices ?? []) {
        if (typeof v.voice_id === "string" && typeof v.name === "string") out.push({ id: v.voice_id, name: v.name });
      }
      pageToken = typeof body.next_page_token === "string" && body.next_page_token !== "" ? body.next_page_token : undefined;
      if (pageToken === undefined) break;
    } finally {
      t.done();
    }
  }
  voicesCache = { at: Date.now(), value: out };
  return out;
}

/**
 * List speech-capable model IDs via GET /v1/models filtered to
 * can_do_text_to_speech. Falls back to a built-in offline list on error.
 */
export async function listTtsModels(
  key: string,
  opts?: { fetchImpl?: ElevenFetch; signal?: AbortSignal },
): Promise<string[]> {
  if (modelsCache !== null && Date.now() - modelsCache.at < DISCOVERY_CACHE_MS) return modelsCache.value;
  const fetchImpl = opts?.fetchImpl ?? defaultFetch;
  const t = withTimeout(opts?.signal);
  try {
    const res = await fetchImpl("https://api.elevenlabs.io/v1/models", {
      headers: { "xi-api-key": key },
      signal: t.signal,
    });
    if (!res.ok) throw new Error(`Model list failed: HTTP ${res.status}`);
    const body = (await res.json()) as { model_id?: unknown; can_do_text_to_speech?: unknown }[] | Record<string, unknown>;
    const arr = Array.isArray(body) ? body : [];
    const ids = arr
      .filter((m) => typeof m === "object" && m !== null && (m as { can_do_text_to_speech?: unknown }).can_do_text_to_speech === true)
      .map((m) => (m as { model_id?: unknown }).model_id)
      .filter((id): id is string => typeof id === "string");
    const value = ids.length > 0 ? ids : [...OFFLINE_TTS_MODELS];
    modelsCache = { at: Date.now(), value };
    return value;
  } catch {
    return [...OFFLINE_TTS_MODELS];
  } finally {
    t.done();
  }
}
