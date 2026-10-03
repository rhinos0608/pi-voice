import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { startUtterance, type SttEndInfo } from "../src/stt.ts";
import type { VoiceFailure } from "../src/contracts.ts";

const KEY = "socket-test-key";

/** Run fn against a local ws server; resolves the server port. */
async function withServer(
  handler: (ws: import("ws").WebSocket, req: import("node:http").IncomingMessage) => void,
  fn: (port: number) => Promise<void> | void,
  verifyClient?: (req: import("node:http").IncomingMessage) => void,
): Promise<void> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const address = wss.address();
  assert.ok(typeof address === "object" && address !== null);
  const port = (address as { port: number }).port;
  wss.on("connection", (ws: import("ws").WebSocket, req: import("node:http").IncomingMessage) => {
    try {
      verifyClient?.(req);
    } catch (err) {
      ws.close();
      throw err;
    }
    handler(ws, req);
  });
  try {
    await fn(port);
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("timed out waiting for condition"));
      }
    }, 10);
  });
}

describe("stt real socket", () => {
  it("sends header auth, manual-commit query, audio + commit JSON, and resolves onFinal", async () => {
    let seenKey: string | string[] | undefined;
    let seenUrl = "";
    const received: Record<string, unknown>[] = [];
    let serverWs: import("ws").WebSocket | null = null;

    await withServer(
      (ws) => {
        serverWs = ws;
        ws.on("message", (raw: import("ws").RawData) => {
          received.push(JSON.parse(String(raw)) as Record<string, unknown>);
        });
      },
      async (port) => {
        const partials: string[] = [];
        const finals: string[] = [];
        const failures: VoiceFailure[] = [];
        let end: SttEndInfo | null = null;
        const u = startUtterance(
          KEY,
          {
            onPartial: (t) => partials.push(t),
            onFinal: (t) => finals.push(t),
            onFailure: (f) => failures.push(f),
            onEnd: (info) => {
              end = info;
            },
          },
          { url: `ws://127.0.0.1:${port}/realtime`, capMs: 60000, commitGraceMs: 5000 },
        );
        // Wait for the server to accept the socket, then open the session.
        await waitFor(() => serverWs !== null);
        (serverWs as unknown as import("ws").WebSocket).send(
          JSON.stringify({ message_type: "session_started" }),
        );
        await new Promise((r) => setTimeout(r, 100));
        u.push(Buffer.alloc(8192, 3));
        u.push(Buffer.alloc(1000, 3));
        await new Promise((r) => setTimeout(r, 100));
        u.commit();
        await waitFor(() => received.some((m) => m["commit"] === true));
        // Commit message must come after every audio chunk.
        const commitIdx = received.findIndex((m) => m["commit"] === true);
        assert.ok(commitIdx > 0);
        for (const m of received.slice(0, commitIdx)) {
          assert.equal(m["message_type"], "input_audio_chunk");
          assert.equal(m["commit"], false);
          assert.equal(m["sample_rate"], 16000);
          assert.ok(typeof m["audio_base_64"] === "string" && (m["audio_base_64"] as string) !== "");
        }
        const commit = received[commitIdx] as Record<string, unknown>;
        assert.equal(commit["message_type"], "input_audio_chunk");
        assert.equal(commit["audio_base_64"], "");
        assert.equal(commit["sample_rate"], 16000);
        (serverWs as unknown as import("ws").WebSocket).send(
          JSON.stringify({ message_type: "committed_transcript", text: "hello pi" }),
        );
        await waitFor(() => end !== null);
        assert.deepEqual(finals, ["hello pi"]);
        assert.equal((end as unknown as SttEndInfo).reason, "final");
        assert.deepEqual(partials, []);
        assert.deepEqual(failures, []);
        await u.close();
        void seenKey;
        void seenUrl;
      },
      (req) => {
        seenKey = req.headers["xi-api-key"];
        seenUrl = req.url ?? "";
        assert.equal(seenKey, KEY);
        const url = new URL(seenUrl, "ws://127.0.0.1");
        assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
        assert.equal(url.searchParams.get("commit_strategy"), "manual");
        assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
        assert.ok(!seenUrl.includes(KEY));
      },
    );
  });

  it("maps a 401 upgrade rejection to auth/non-retryable", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const port = (address as { port: number }).port;
    try {
      const failures: VoiceFailure[] = [];
      const endBox: { info: SttEndInfo | null } = { info: null };
      const u = startUtterance(
        "bad-key",
        {
          onPartial: () => {},
          onFinal: () => {},
          onFailure: (f) => failures.push(f),
          onEnd: (info) => {
            endBox.info = info;
          },
        },
        { url: `ws://127.0.0.1:${port}/realtime`, capMs: 60000 },
      );
      await waitFor(() => failures.length > 0);
      assert.equal(failures[0]?.code, "auth");
      assert.equal(failures[0]?.retryable, false);
      assert.ok(failures[0]?.message.includes("401"));
      assert.equal(endBox.info?.reason, "error");
      await u.close();
    } finally {
      server.close();
    }
  });
});
