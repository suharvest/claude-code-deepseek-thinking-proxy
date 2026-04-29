# claude-code-deepseek-thinking-proxy

[![npm version](https://img.shields.io/npm/v/claude-code-deepseek-thinking-proxy)](https://www.npmjs.com/package/claude-code-deepseek-thinking-proxy)
[![license](https://img.shields.io/npm/l/claude-code-deepseek-thinking-proxy)](https://github.com/suharvest/claude-code-deepseek-thinking-proxy/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/claude-code-deepseek-thinking-proxy)](https://nodejs.org/)

One command to fix **"`content[].thinking` in the thinking mode must be passed back to the API"** when using DeepSeek V4 with Claude Code.

## What problem does this solve?

DeepSeek V4 models (`deepseek-v4-pro` / `deepseek-v4-flash`) always run in **thinking mode**. When the model makes tool calls, it requires the `thinking` blocks from previous turns to be preserved in the conversation history. If you switch models mid-session (e.g. to Anthropic Sonnet and back), Claude Code strips these blocks. Switching back to DeepSeek then fails with a 400 error.

This proxy sits between Claude Code and DeepSeek, caching thinking blocks and re-injecting them when missing — transparent to Claude Code.

## Quickstart

```bash
npm install -g claude-code-deepseek-thinking-proxy
deepseek-thinking-proxy
```

Then set your Claude Code base URL to point to the proxy:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "<your-deepseek-api-key>"
  }
}
```

That's it. Switch models freely — the proxy handles the rest.

## How it works

```
Claude Code ──→ localhost:8787 ──→ api.deepseek.com/anthropic
                   │
                   ├─ Inbound: scan assistant messages
                   │   ├─ Cache hit → re-inject real thinking blocks
                   │   └─ Cache miss → inject placeholder
                   │
                   └─ Outbound: extract thinking blocks → cache by fingerprint
```

- **Cache**: FNV-1a hash of conversation prefix, in-memory, TTL 30 min, max 500 entries
- **Placeholder**: Falls back to `"(thinking omitted)"` with empty signature when cache is cold. DeepSeek's Anthropic endpoint does not validate signatures.

## Auto-start with launchd (macOS)

```bash
cat > ~/Library/LaunchAgents/com.deepseek-thinking-proxy.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deepseek-thinking-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/node</string>
        <string>/path/to/deepseek-thinking-proxy</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key>
    <string>/tmp/thinking-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/thinking-proxy.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.deepseek-thinking-proxy.plist
```

## Configuration

All via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8787` | Listen port |
| `PROXY_UPSTREAM` | `https://api.deepseek.com/anthropic` | Upstream DeepSeek endpoint |
| `PROXY_PLACEHOLDER` | `fallback` | `off` / `fallback` / `always` |
| `PROXY_PLACEHOLDER_TEXT` | `(thinking omitted)` | Placeholder content |
| `PROXY_DEBUG` | `0` | Set to `1` for verbose logging |

## Health check

```bash
curl http://127.0.0.1:8787/health
# {"status":"ok","cacheSize":3,"upstream":"https://api.deepseek.com/anthropic"}
```

## Use with cc-switch

If you use [cc-switch](https://github.com/farion1231/cc-switch) to manage providers, set your DeepSeek provider's base URL to `http://127.0.0.1:8787`. The proxy runs independently via launchd — cc-switch only needs to point at it.

## License

MIT
