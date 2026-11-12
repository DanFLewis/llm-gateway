# llm-gateway

A single-file Node gateway that sits in front of a local Ollama server. It adds bearer-key auth, per-key rate limits, a model allowlist, request caps, and a one-job-at-a-time queue so a single GPU can be shared safely. No npm dependencies. It was developed on Node 24 and uses only built-in modules.

It also has an optional `/ask` route that answers questions from a fixed system prompt and fact sheet, with server-side conversation history. That route backs a public chat box on a personal site, fronted by a Cloudflare Worker that checks Turnstile. See [DESIGN.md](DESIGN.md) for the reasoning and the threat model.

## What it does

- `POST /v1/chat/completions` and `GET /v1/models`, forwarded to Ollama's OpenAI-compatible API. Every other path returns 404.
- Keys come from a JSON file that is re-read on each request, so a key can be added or revoked without a restart.
- Each key has its own requests-per-minute limit (sliding 60 second window, in memory).
- Only models on the allowlist are accepted. Request bodies over 64 KB are rejected. `max_tokens` is clamped, and `stream` is forced off.
- One request runs on the model at a time. Up to `MAX_QUEUE` more wait; beyond that the gateway answers 503 immediately.
- The log records metadata only: time, key name, method, path, status, duration, token counts, and caller info. Prompt text is not logged unless `CONVERSATION_LOG` is set.

## Setup

```sh
cp keys.example.json keys.json
# edit keys.json: replace the example keys with long random strings, e.g.
node -e "console.log('gw_' + require('crypto').randomBytes(24).toString('hex'))"
```

`keys.json` format:

```json
{
  "alice-laptop": { "key": "gw_...", "rpm": 20 },
  "web-ask": { "key": "gw_...", "rpm": 5, "scope": "ask" }
}
```

`rpm` defaults to 20 (5 for `/ask`). A key with `"scope": "ask"` can call only `/ask`; a key without a scope cannot call `/ask`.

Ollama must be running with the allowed models pulled.

## Run

```sh
node gateway.js
# gateway on 127.0.0.1:8788
```

The gateway binds to 127.0.0.1 only. To expose it, put a tunnel or reverse proxy in front of it rather than changing the bind address.

## Examples

```sh
KEY=gw_example_0000000000000000000000000001

curl -s http://127.0.0.1:8788/v1/models -H "Authorization: Bearer $KEY"

curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"gemma4:e4b","messages":[{"role":"user","content":"Say hi."}],"max_tokens":64}'
```

Error responses are JSON with an `error` field:

| Status | Meaning |
|--------|---------|
| 400 | Invalid JSON, or model not on the allowlist (the response lists allowed models) |
| 401 | Missing or unknown key, or a key with the wrong scope |
| 404 | Unknown path, or `/ask` while disabled |
| 413 | Body too large |
| 429 | Per-key (or, for `/ask`, per-IP) rate limit |
| 502 | Ollama unreachable, timed out, or returned an error |
| 503 | Queue full |

### The `/ask` route

Enable it with `ASK_ENABLED=1` and `ASK_DIR=/path/to/dir`, where the directory holds `system_prompt.txt` (containing the literal placeholder `<<FACTSHEET>>`) and `factsheet.md`. Both files are re-read on every request.

```sh
curl -s http://127.0.0.1:8788/ask \
  -H "Authorization: Bearer $ASK_KEY" -H "Content-Type: application/json" \
  -d '{"question":"What do you work on?"}'
# {"answer":"...","session_id":"..."}

# follow-up: send only the session_id, never the earlier messages
curl -s http://127.0.0.1:8788/ask \
  -H "Authorization: Bearer $ASK_KEY" -H "Content-Type: application/json" \
  -d '{"question":"And before that?","session_id":"..."}'
```

The body may contain only `question` (1 to 500 characters) and optionally `session_id`. Any other field is rejected with 400.

## Configuration

All configuration is through environment variables.

| Variable | Default | Purpose |
|----------|---------|---------|
| `GATEWAY_PORT` | `8788` | Listen port (always on 127.0.0.1) |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama host |
| `OLLAMA_PORT` | `11434` | Ollama port |
| `ALLOWED_MODELS` | `gemma4:e4b,qwen3.5:9b` | Comma-separated model allowlist |
| `MAX_TOKENS_CAP` | `1024` | Upper bound applied to `max_tokens` |
| `MAX_QUEUE` | `4` | Requests allowed to wait behind the running one |
| `KEYS_FILE` | `./keys.json` | Path to the keys file |
| `LOG_FILE` | `./gateway.log` | Metadata log (JSON lines) |
| `CONVERSATION_LOG` | unset (disabled) | If set, full prompts and replies are appended to this file |
| `ASK_ENABLED` | unset | Set to `1` to enable `/ask` (also requires `ASK_DIR`) |
| `ASK_DIR` | unset | Directory with `system_prompt.txt` and `factsheet.md` |
| `ASK_MODEL` | `gemma4:e4b` | Model used by `/ask` |
| `ASK_IP_RPM` | `8` | Per-visitor-IP limit for `/ask` |

Fixed in the source rather than configurable: body cap 64 KB (4 KB for `/ask`), upstream timeout 120 s, `/ask` context 8192 tokens, 4 remembered turns per session, 30 minute session TTL, 200 sessions maximum.

## Front door (optional)

The public deployment puts a Cloudflare Tunnel between the internet and the localhost listener, and a Cloudflare Worker in front of that. The Worker checks the browser origin, verifies a Turnstile token, validates the question and session id, then calls the gateway with the `ask`-scoped key and an `X-Visitor-IP` header. It is configured with `ASK_KEY` and `TURNSTILE_SECRET` as secrets and `ASK_URL` as a variable. The Worker is not part of this directory.

## Logs and privacy

`gateway.log` contains caller IP, country, user agent, and Cloudflare ray id for each request, plus key name and status. Treat it as personal data. Keys are never written to it. Do not commit `keys.json`, `gateway.log`, or any conversation log; the included `.gitignore` excludes them.

## Verification status

Checks run on this copy: `node --check`, then start on a spare port with a fake key and confirm 401 (no key, wrong key), 404 (unknown path, `/ask` disabled), and 400 (valid key, disallowed model). Forwarding to a live Ollama, the `/ask` flow, rate limiting, and the queue were not exercised in that run.
