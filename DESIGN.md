# Design notes

## Purpose and constraints

One consumer GPU, one Ollama instance, a handful of trusted callers, and one public-facing chat box. The gateway exists so the model server is never exposed directly and so a bad caller, or a stranger on the internet, can use only a small, bounded slice of it. The code is one file with no dependencies so it can be read in one sitting and audited without a lockfile.

## Threat model

Assumed attackers:

1. An anonymous visitor who finds the public chat endpoint and tries to burn GPU time, extract the system prompt, or steer the model.
2. A keyholder who misbehaves: a leaked or over-eager key hammering the API.
3. Someone who learns the tunnel hostname and talks to the gateway directly, bypassing the Worker and its captcha.

Not defended against: code execution on the host, theft of the keys file, or a compromised Cloudflare account. Prompt injection is limited by what `/ask` lets in (below) but not eliminated. The Worker treats model output as untrusted text and truncates it.

Assets, in order: GPU availability, the keys, the private fact sheet, and the logs (which hold visitor IPs).

## Layers

Public chat path: browser, Cloudflare Worker (origin allowlist, Turnstile, input validation, 45 s timeout, answer truncation), Cloudflare Tunnel, gateway on localhost, Ollama.

- The gateway listens on 127.0.0.1 only. The only way in from outside is the tunnel.
- Direct callers need a bearer key. The Worker holds a key with scope `ask`, which the generic routes reject. Leaking it exposes `/ask` and nothing else. Leaking a normal key does not expose `/ask`.
- Unknown paths and a disabled `/ask` both return 404, so the surface is not advertised.
- The model allowlist is checked before queueing, so a caller cannot make the host load an arbitrary model.
- The body is read with a running size check and rejected as soon as the cap is crossed, rather than buffered in full first.

## Why client-supplied history is never accepted on `/ask`

The obvious chat design lets the browser send the whole message list each turn. A visitor could then forge assistant turns, insert a system message, or paste a long fake transcript to push the real system prompt out of the context window or override it. They would also control token usage per request.

Instead, `/ask` accepts exactly two fields: `question` (at most 500 characters) and an optional `session_id`. Any other key in the JSON makes the request invalid. Follow-up context is kept on the server under a random 128-bit session id the server generates. The server builds the message list itself: its own system prompt, the last few stored question and answer pairs, then the new question. The caller controls one short user message per request.

Sessions are also bound to the caller's IP. A session id presented from a different IP is ignored and a fresh session is created, so a leaked or guessed id does not let someone read or extend another visitor's conversation. History is limited to four turns, and trimmed further if an estimated token count would pass 92 percent of the 8192-token context. The estimate is 4 characters per token; the source comment says the measured ratio for this prompt is about 4.5, so 4 errs on the safe side.

The generic `/v1/chat/completions` route does accept client-supplied messages. That is deliberate: it is for named, trusted keyholders using the gateway as an API, and the Worker's key cannot reach it.

## Per-IP limiting and the trusted visitor header

Behind a Cloudflare Worker, every request reaches the gateway from the Worker's side of the tunnel, so the socket address cannot tell visitors apart. The Worker forwards the visitor address in an `X-Visitor-IP` header, taken from `CF-Connecting-IP`.

The gateway reads `X-Visitor-IP` only inside the `/ask` handler, and only after the request has presented a valid key with scope `ask`. A request without that key never reaches the line that reads the header. Someone hitting the gateway directly cannot spoof an IP to dodge limits, because they have no scoped key. Someone who does have the scoped key is already inside the trust boundary. On the generic routes the header is ignored; the caller address used for logging comes from `CF-Connecting-IP` or the socket.

`/ask` applies two limits per request: the key's own rpm, and a per-visitor-IP limit (default 8 per minute). The per-IP bucket is namespaced with an `ip:` prefix so it cannot collide with a key name. The header value is truncated to 64 characters.

This is a trust arrangement, not cryptographic proof. If the scoped key leaks, its holder can claim any IP, which is why that key's own rpm is kept low.

## Queueing choice

The GPU serves one generation at a time well. Concurrent requests slow each other down and can cause out-of-memory failures when models swap. The gateway therefore keeps a running counter and a FIFO of waiting resolvers. The first request runs. Up to `MAX_QUEUE` (4) more wait. A request that arrives when the queue is full gets 503 immediately.

Alternatives considered were an unbounded queue and no queue. An unbounded queue turns a burst into minutes of latency with connections held open, and hides overload from callers. No queue lets the GPU thrash. A short bounded queue gives a predictable worst case: about five generations of wait, then a fast "busy". The Worker's 45 second timeout fits that: a visitor behind a full queue gets an error rather than a hung page. The value 4 is a judgment call, not a measured optimum.

Rate limits are checked before the queue, so a rate-limited caller never holds a slot. A request that is counted against the rate limit and then gets a 503 still spends that key's budget for the minute.

## Logging

The default log is metadata only. Prompt and reply text are written only if `CONVERSATION_LOG` names a file. In the original deployment that logging was on, to review what visitors asked; in this cleaned copy it is off by default. The metadata log still contains caller IP, country, user agent and ray id, because abuse investigation needs them. The gateway does no rotation or retention.

## Known limits

- Sessions and rate-limit counters live in process memory. A restart drops every conversation and resets all limits. That is fine for a chat box and wrong for billing-grade metering.
- The rate-limit map is never pruned of idle names. It is keyed by key name and by visitor IP, so it grows with distinct IPs until restart. At this traffic it is small, but it is unbounded in principle. Sessions are capped at 200 with oldest-first eviction.
- No auto-start. Nothing supervises the process. If it exits or the machine reboots, the gateway and the tunnel stay down until someone starts them, and the chat box shows its offline error.
- The queue has no wait timeout and does not notice client disconnects. A caller that gives up still has its job run when its turn comes.
- Key comparison is a plain string match, not constant-time, and the keys file is read and parsed on every request. Fine for a few keys behind a rate limit; not a design for many.
- The model allowlist applies to POST bodies. `GET /v1/models` is passed through and lists whatever the Ollama host has installed.
- Streaming is disabled, so a caller sees nothing until the full completion is ready.
- One process, one GPU, one host. No failover, health endpoint, or metrics beyond the log.
- Testing is manual. The run described in the README covers only the auth and validation paths.
