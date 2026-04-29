// Strip thinking blocks from content for fingerprinting (they'd
// create circular dependency — we want to identify the turn without them).
function normalizeContentForFingerprint(content) {
  if (typeof content === "string") return content;
  return content.map((c) => {
    if (c.type === "text") return { type: "text", text: c.text };
    if (c.type === "tool_use") return { type: "tool_use", id: c.id, name: c.name, input: c.input };
    if (c.type === "tool_result") return { type: "tool_result", tool_use_id: c.tool_use_id, content: c.content };
    if (c.type === "thinking" || c.type === "redacted_thinking") return { type: c.type };
    return { type: c.type };
  });
}

import { fingerprint } from "./cache.js";

// Check if an assistant message already has thinking blocks.
export function hasThinkingBlock(msg) {
  if (typeof msg.content === "string") return false;
  return msg.content.some((c) => c.type === "thinking" || c.type === "redacted_thinking");
}

// Compute fingerprint for the assistant turn at `assistantIndex` based on
// all messages that precede it (roles + non-thinking content).
export function assistantTurnFingerprint(messages, assistantIndex, model) {
  const prefix = messages.slice(0, assistantIndex).map((m) => ({
    role: m.role,
    content: normalizeContentForFingerprint(m.content),
  }));
  return fingerprint({ model: model ?? "", prefix });
}

// For each assistant message missing thinking blocks, look them up in cache
// and prepend to content[]. Returns true if any message was mutated.
export function reinjectThinkingBlocks(body, lookup) {
  if (!body?.messages?.length) return false;
  let mutated = false;
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      m.content = m.content ? [{ type: "text", text: m.content }] : [];
    }
    if (hasThinkingBlock(m)) continue;
    const fp = assistantTurnFingerprint(body.messages, i, body.model);
    const blocks = lookup(fp);
    if (!blocks?.length) continue;
    m.content = [...blocks, ...m.content];
    mutated = true;
  }
  return mutated;
}

// Inject placeholder thinking blocks for assistant messages that still
// lack them after cache lookup. Uses empty signature (DeepSeek doesn't
// validate Anthropic's cryptographic signature).
export function fillThinkingPlaceholder(body, opts = {}) {
  if (opts.mode === "off") return 0;
  if (!body?.messages?.length) return 0;
  const text = opts.text || "(thinking omitted)";
  const policy = opts.signaturePolicy ?? "empty";
  let mutated = 0;
  for (const m of body.messages) {
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") {
      m.content = m.content ? [{ type: "text", text: m.content }] : [];
    }
    if (!Array.isArray(m.content)) continue;
    if (opts.mode === "fallback" && hasThinkingBlock(m)) continue;
    const block =
      policy === "empty"
        ? { type: "thinking", thinking: text, signature: "" }
        : { type: "thinking", thinking: text };
    m.content.unshift(block);
    mutated++;
  }
  return mutated;
}

// Extract thinking blocks from a non-streamed Anthropic response.
export function extractThinkingFromResponse(json) {
  if (!json || typeof json !== "object") return [];
  const content = json.content;
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c && (c.type === "thinking" || c.type === "redacted_thinking"));
}
