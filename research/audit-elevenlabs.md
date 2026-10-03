I've finished the audit, and the brief needs four changes before implementation. Most of it holds up: the endpoints, model IDs and the main message shapes match the official ElevenLabs docs and the undici docs. All checks used web search results from the official docs; I had no fetch tool and ran nothing locally.

### Claims checked

| # | Claim | Status | Source / evidence |
|---|---|---|---|
| 1 | STT URL `wss://api.elevenlabs.io/v1/speech-to-text/realtime` | CONFIRMED | elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime: "URL \| wss://api.elevenlabs.io/v1/speech-to-text/realtime" |
| 2 | STT auth is the `xi-api-key` header, or `?token=` | CONFIRMED | Same page: "providing a valid API key in the `xi-api-key` header or by providing a valid token in the `token` query parameter" |
| 3 | `model_id=scribe_v2_realtime` | CONFIRMED | The `session_started` example has `"model_id": "scribe_v2_realtime"`; the commit-strategies guide uses `modelId: "scribe_v2_realtime"`. I did not check the claim that `scribe_v1` was removed. |
| 4 | Query params `commit_strategy` (`manual`/`vad`), `vad_threshold`, `vad_silence_threshold_secs`, `min_speech_duration_ms`, `min_silence_duration_ms`, `include_timestamps`, `audio_format`, `language_code` | CONFIRMED (names and the enum) | The AsyncAPI query bindings list them all; `commit_strategy` enum is `manual, vad`. Manual is the default: "This is the strategy that is used by default." |
| 5 | VAD defaults 1.5 / 0.4 / 100 / 100 and their ranges | UNVERIFIABLE (partly) | These values appear only as example arguments in the guide, not as stated defaults. I didn't find the 0.1–0.9 and 0.3–3.0 ranges. |
| 6 | Message names `input_audio_chunk`, `audio_base_64`, `commit`, `sample_rate`, `session_started`, `partial_transcript`, `committed_transcript`, `committed_transcript_with_timestamps` | CONFIRMED | `InputAudioChunk` schema: `message_type` enum `input_audio_chunk`, `audio_base_64`, `commit`, `sample_rate`. "a delayed committed_transcript_with_timestamps message… an additional message… after each commit" |
| 7 | Error types `scribe_error`, `scribe_auth_error`, … | **WRONG** | Event reference (…/speech-to-text/realtime/event-reference) lists `auth_error, quota_exceeded, transcriber_error, input_error, invalid_request, error, commit_throttled, unaccepted_terms, rate_limited, queue_overflow, resource_exhausted, session_time_limit_exceeded, chunk_size_exceeded, insufficient_audio_activity`. Example message: `{"error":"…","message_type":"rate_limited"}` |
| 8 | `keyterms` allows up to 1000 terms | **WRONG** | "Maximum 50 keyterms. Adds a 20% premium" |
| 9 | `entity_detection` costs +30% | UNCLEAR | The docs attach the 30% premium to the edit-instruction feature (`edited_transcript`), not to `entity_detection`. |
| 10 | Manual mode auto-commits at about 36 s; transcription starts after 2 s | CONFIRMED | "automatically commits after approximately 36 seconds"; "Transcript processing starts after the first 2 seconds of audio are sent." |
| 11 | Single-use token endpoint `POST /v1/single-use-token/{realtime_scribe\|tts_websocket}`, 15-minute expiry, consumed on use | CONFIRMED | tokens/create: "Allowed values: `realtime_scribe`, `batch_scribe`, `tts_websocket`… expires after 15 minutes. Will be consumed on use." |
| 12 | TTS URL `/v1/text-to-speech/{voice_id}/stream-input` | CONFIRMED | API reference "GET /v1/text-to-speech/{voice_id}/stream-input" |
| 13 | First message is `text:" "` with `voice_settings` and `generation_config` | CONFIRMED | `InitializeConnection`: "The initial text that must be sent is a blank space." |
| 14 | API key can go in the first message as `xi_api_key` | CONFIRMED, with a schema discrepancy | The realtime-tts guide sends `"xi_api_key": ELEVENLABS_API_KEY`. The AsyncAPI schema names the field `xi-api-key` (hyphen): "This can only be included in the first message". |
| 15 | TTS query auth with `?single_use_token=` | CONFIRMED | Query bindings: `authorization`, `single_use_token`, `model_id`, `output_format`, `inactivity_timeout`, `auto_mode`, … There is **no `xi_api_key` query param**. |
| 16 | `try_trigger_generation` and `flush` semantics | CONFIRMED | "Flush forces the generation of audio… keep the websocket connection open"; try_trigger "will only generate audio if our buffer contains more than a minimum threshold" |
| 17 | `{"text":""}` closes the stream | CONFIRMED | `CloseConnection`: `text` enum `''` "End the stream with an empty string" |
| 18 | Response has `audio`, `isFinal`, `alignment`, `normalizedAlignment` | CONFIRMED, with nuance | `AudioOutput{audio, normalizedAlignment, alignment}` and a **separate** `FinalOutput{isFinal:true}` where "`audio` will be null". Multi-context uses `is_final` (snake case). |
| 19 | `chunk_length_schedule` defaults to [120,160,250,290] | CONFIRMED | "Each item should be in the range 50-500." |
| 20 | `eleven_flash_v2_5` works over the WebSocket; `eleven_v3` does not | CONFIRMED | realtime-tts guide: "we recommend using the 'eleven_flash_v2_5' model"; "That endpoint does not support the `eleven_v3` model." Eleven v3 goes through `/v1/text-to-dialogue/stream-input`, which needs a `voices` array in the first message. |
| 21 | `inactivity_timeout` defaults to 20 s, max 180 | CONFIRMED | ElevenLabs blog: "new maximum of 180 seconds. The default remains at 20 seconds" |
| 22 | `output_format` PCM list, and `pcm_44100` needs Pro | UNVERIFIABLE | The param exists, but I didn't retrieve the enum. |
| 23 | `GET /v2/voices` returns `voices[].voice_id`, `name`, `category`, `labels`, `preview_url` | CONFIRMED | voices/search page. Also: `page_size` "defaults to 10… Can not exceed 100"; `has_more` and `next_page_token` handle paging. |
| 24 | `GET /v1/user` returns `user_id`, `subscription.tier/status/character_count/character_limit`, `is_onboarding_completed` | CONFIRMED | user/get page. The example `status: "active"` is valid (enum: trialing, active, incomplete, past_due, free, free_disabled). |
| 25 | Invalid key returns 401 with `{detail:{status:"invalid_api_key"}}` | UNVERIFIABLE | Not on the page I retrieved. |
| 26 | undici WebSocket accepts `new WebSocket(url, {headers})` | CONFIRMED | github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md: "`headers` {HeadersInit\|null} Additional headers to send with the handshake request… The object form is an undici extension and is not available in browsers" |
| 27 | Node 25's **global** WebSocket honours `{headers}` | INFERENCE, not tested | Node's global WebSocket is undici's, so it should work. I did not check which undici version Node 25 bundles or run a test. |
| 28 | "WHATWG compatibility flags… can strip or reject options in strict environments" | UNSUPPORTED | No source supports this. The only limit documented is that browsers don't have it. |

### Corrections that matter for implementation
1. **STT error handling:** switch on the real `message_type` values (`auth_error`, `quota_exceeded`, `rate_limited`, `input_error`, `invalid_request`, `commit_throttled`, `transcriber_error`, `error`, `unaccepted_terms`, `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`, `chunk_size_exceeded`, `insufficient_audio_activity`), and read the text from the `error` field. Code built on the `scribe_*` names would never match an error.
2. **Timestamps message:** `committed_transcript_with_timestamps` is an *extra* message that arrives after `committed_transcript`, not a replacement. Don't emit the turn twice.
3. **TTS end of stream:** expect a separate message `{isFinal:true}` where `audio` is null, and don't base64-decode a null `audio`. On the multi-context endpoint the field is `is_final`.
4. **TTS auth:**
   - The header (with `ws`, or undici's `{headers}`) is documented and the simplest option.
   - In the first message body, the guide uses `xi_api_key` but the schema says `xi-api-key`. Prefer the header to avoid the question; if you use the body, use `xi_api_key` as the guide does and test it live.
   - There is no `xi_api_key` query param; use `single_use_token` (type `tts_websocket`) or `authorization`.
5. **`keyterms`:** the limit is 50, not 1000.
6. **Voices:** `/v2/voices` returns 10 per page by default (max 100). Set `page_size` or follow `next_page_token`.
7. **Key validation:** `GET /v1/user` is valid, but the 401 body shape is unverified. Check the HTTP status, not the body. A restricted API key without user-read permission may fail this call even though the key is valid; I didn't verify that either.