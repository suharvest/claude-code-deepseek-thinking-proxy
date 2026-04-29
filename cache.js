// FNV-1a 64-bit-ish hash for fingerprinting message prefixes.
function fingerprint(value) {
  const s = typeof value === "string" ? value : stableStringify(value);
  let h1 = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0;
    h2 ^= c;
    h2 = (h2 + ((h2 << 1) + (h2 << 4) + (h2 << 7) + (h2 << 8) + (h2 << 24))) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_ENTRIES = 500;

export class ThinkingCache {
  #store = new Map();
  #ttlMs;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  set(key, blocks) {
    if (!blocks.length) return;
    if (this.#store.size >= MAX_ENTRIES) {
      const oldest = [...this.#store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.#store.delete(oldest[0]);
    }
    this.#store.set(key, { blocks, at: Date.now() });
  }

  get(key) {
    const e = this.#store.get(key);
    if (!e) return;
    if (Date.now() - e.at > this.#ttlMs) {
      this.#store.delete(key);
      return;
    }
    return e.blocks;
  }

  get size() {
    return this.#store.size;
  }
}

export { fingerprint };
