#!/usr/bin/env node

import http from "node:http";
import { ThinkingCache, fingerprint } from "./cache.js";
import {
  reinjectThinkingBlocks,
  fillThinkingPlaceholder,
  extractThinkingFromResponse,
} from "./messages.js";

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const PORT = parseInt(process.env.PROXY_PORT || args[0] || "8787", 10);
const UPSTREAM = (process.env.PROXY_UPSTREAM || args[1] || "https://api.deepseek.com/anthropic").replace(/\/$/, "");
const DEBUG = process.env.PROXY_DEBUG === "1" || flags.includes("--debug");
const PLACEHOLDER_MODE = process.env.PROXY_PLACEHOLDER || "fallback";
const PLACEHOLDER_TEXT = process.env.PROXY_PLACEHOLDER_TEXT || "(thinking omitted)";

const cache = new ThinkingCache();

function log(...args) {
  if (DEBUG) console.error("[deepseek-thinking-proxy]", ...args);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function stripForFingerprint(content) {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type !== "thinking" && c.type !== "redacted_thinking")
    .map((c) => {
      if (c.type === "text") return { type: "text", text: c.text };
      if (c.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input };
      if (c.type === "tool_result") return { type: "tool_result", tool_use_id: c.tool_use_id, content: c.content };
      return { type: c.type };
    });
}

function makeUpstreamUrl(path) {
  return UPSTREAM + path;
}

// ── Stream interception — collect thinking blocks from SSE ─────────────────

function interceptStreamSse(body, onBlocks) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const blocks = new Map(); // index → { block, text }

  const readable = new ReadableStream({
    start(controller) {
      const reader = body.getReader();
      function push() {
        reader.read().then(({ done, value }) => {
          if (done) {
            if (buffer.trim()) controller.enqueue(encoder.encode(buffer));
            const collected = [...blocks.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([, b]) => b.block);
            onBlocks(collected);
            controller.close();
            return;
          }
          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "content_block_start") {
                const cb = data.content_block;
                if (cb?.type === "thinking" || cb?.type === "redacted_thinking") {
                  blocks.set(data.index, {
                    block: { type: cb.type, thinking: cb.thinking || "", signature: cb.signature || "" },
                    text: cb.thinking || "",
                  });
                }
              } else if (data.type === "content_block_delta") {
                const delta = data.delta;
                if (delta?.type === "thinking_delta" || delta?.type === "signature_delta") {
                  const b = blocks.get(data.index);
                  if (b) {
                    if (delta.thinking) b.text += delta.thinking;
                    if (delta.signature) b.block.signature = (b.block.signature || "") + delta.signature;
                    b.block.thinking = b.text;
                  }
                }
              }
            } catch { /* skip non-JSON */ }
          }
          push();
        }).catch((err) => {
          log("stream read error:", err.message);
          controller.error(err);
        });
      }
      push();
    },
  });
  return new Response(readable);
}

// ── Process request body ───────────────────────────────────────────────────

function processBody(body) {
  if (!body || !Array.isArray(body.messages)) return { body, mutated: false };

  const reinjected = reinjectThinkingBlocks(body, (fp) => cache.get(fp));
  if (reinjected) log("re-injected cached thinking blocks");

  const placeholderCount = fillThinkingPlaceholder(body, {
    mode: PLACEHOLDER_MODE,
    text: PLACEHOLDER_TEXT,
    signaturePolicy: "empty",
  });
  if (placeholderCount > 0) log(`filled ${placeholderCount} placeholder(s)`);

  if (body.thinking == null) {
    body.thinking = { type: "enabled", budget_tokens: 8000 };
  }

  return { body, mutated: reinjected || placeholderCount > 0 };
}

// ── Handle Claude Code request ─────────────────────────────────────────────

async function handleRequest(claudeReq, claudeRes) {
  // Health check
  if (claudeReq.method === "GET" && claudeReq.url === "/health") {
    claudeRes.writeHead(200, { "content-type": "application/json" });
    claudeRes.end(JSON.stringify({ status: "ok", cacheSize: cache.size, upstream: UPSTREAM }));
    return;
  }

  // Read body
  const chunks = [];
  for await (const chunk of claudeReq) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();
  let parsedBody = null;
  let finalBody = rawBody;

  try {
    parsedBody = JSON.parse(rawBody);
    if (parsedBody && Array.isArray(parsedBody.messages)) {
      const result = processBody(parsedBody);
      parsedBody = result.body;
      finalBody = JSON.stringify(parsedBody);
    }
  } catch {
    // Non-JSON — proxy as-is
  }

  // Build upstream request
  const upstreamUrl = makeUpstreamUrl(claudeReq.url);
  const headers = { ...claudeReq.headers };
  delete headers.host;
  delete headers.connection;
  delete headers["transfer-encoding"];
  headers["content-length"] = Buffer.byteLength(finalBody).toString();

  log(`${claudeReq.method} ${claudeReq.url} → ${upstreamUrl}`);

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: claudeReq.method,
      headers,
      body: finalBody,
      redirect: "follow",
    });

    const ct = upstreamRes.headers.get("content-type") || "";
    const isStream = ct.includes("text/event-stream");
    const isOk = upstreamRes.ok;

    if (!isStream && parsedBody && isOk) {
      // Non-streaming: read full response, cache thinking, forward
      const resJson = await upstreamRes.json();
      const blocks = extractThinkingFromResponse(resJson);
      if (blocks.length) {
        const fp = fingerprint({
          model: parsedBody.model ?? "",
          prefix: parsedBody.messages.map((m) => ({
            role: m.role,
            content: stripForFingerprint(m.content),
          })),
        });
        cache.set(fp, blocks);
        log(`cached ${blocks.length} thinking blocks (cache: ${cache.size})`);
      }
      claudeRes.writeHead(upstreamRes.status, { "content-type": ct });
      claudeRes.end(JSON.stringify(resJson));
      return;
    }

    if (isStream && parsedBody && isOk) {
      // Streaming: intercept SSE to collect thinking, forward stream
      claudeRes.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
      const intercepted = interceptStreamSse(upstreamRes.body, (blocks) => {
        if (blocks.length) {
          const fp = fingerprint({
            model: parsedBody.model ?? "",
            prefix: parsedBody.messages.map((m) => ({
              role: m.role,
              content: stripForFingerprint(m.content),
            })),
          });
          cache.set(fp, blocks);
          log(`cached ${blocks.length} thinking blocks from stream (cache: ${cache.size})`);
        }
      });
      const reader = intercepted.body.getReader();
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) { claudeRes.end(); return; }
          claudeRes.write(value);
          pump();
        }).catch(() => claudeRes.end());
      }
      pump();
      return;
    }

    // Passthrough: error responses, non-messages endpoints
    claudeRes.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
    const buf = await upstreamRes.arrayBuffer();
    claudeRes.end(Buffer.from(buf));

  } catch (err) {
    log("upstream error:", err.message);
    if (!claudeRes.headersSent) {
      claudeRes.writeHead(502, { "content-type": "application/json" });
    }
    claudeRes.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}` } }));
  }
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, "127.0.0.1", () => {
  console.error(`deepseek-thinking-proxy v1.0.0`);
  console.error(`listening:  http://127.0.0.1:${PORT}`);
  console.error(`upstream:   ${UPSTREAM}`);
  console.error(`placeholder mode: ${PLACEHOLDER_MODE}`);
  if (DEBUG) console.error("debug: enabled");
});

process.on("SIGINT", () => { server.close(); process.exit(0); });
