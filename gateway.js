// Minimal key-checking gateway in front of Ollama. No dependencies.
// Run: node gateway.js   (listens on 127.0.0.1:8788 by default, forwards to Ollama on 127.0.0.1:11434)
// Keys live in keys.json: { "friend-name": { "key": "...", "rpm": 20 } }  -- never logged.
// An optional "scope": "ask" key can only call /ask (see README.md).
// Logs only metadata (time, key name, path, status, ms, caller), never prompt text,
// unless CONVERSATION_LOG is set (off by default).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.GATEWAY_PORT) || 8788;
const OLLAMA = { host: process.env.OLLAMA_HOST || '127.0.0.1', port: Number(process.env.OLLAMA_PORT) || 11434 };
const ALLOWED_PATHS = new Set(['/v1/chat/completions', '/v1/models']);
const ALLOWED_MODELS = new Set((process.env.ALLOWED_MODELS || 'gemma4:e4b,qwen3.5:9b').split(',').map((m) => m.trim()).filter(Boolean));
const MAX_BODY = 64 * 1024, MAX_TOKENS_CAP = Number(process.env.MAX_TOKENS_CAP) || 1024, MAX_QUEUE = Number(process.env.MAX_QUEUE) || 4, UPSTREAM_TIMEOUT = 120000;
// /ask is off unless ASK_ENABLED=1 and ASK_DIR points at a directory holding system_prompt.txt and factsheet.md.
const ASK_DIR = process.env.ASK_DIR || '';
const ASK_ENABLED = process.env.ASK_ENABLED === '1' && !!ASK_DIR, ASK_IP_RPM = Number(process.env.ASK_IP_RPM) || 8;
const ASK_MODEL = process.env.ASK_MODEL || 'gemma4:e4b';
const ASK_PROMPT = path.join(ASK_DIR, 'system_prompt.txt'), ASK_FACTS = path.join(ASK_DIR, 'factsheet.md');   // re-read per request
const crypto = require('crypto');
const ASK_CTX = 8192, MAX_TURNS = 4, SESSION_TTL = 30 * 60000, MAX_SESSIONS = 200;
const sessions = new Map();   // id -> { turns:[{q,a}], last, ip, n }  (memory only)
const keysFile = process.env.KEYS_FILE || path.join(__dirname, 'keys.json');
const logFile = process.env.LOG_FILE || path.join(__dirname, 'gateway.log');
const convFile = process.env.CONVERSATION_LOG || '';   // full prompt + reply text; private; empty = disabled

const loadKeys = () => { try { return JSON.parse(fs.readFileSync(keysFile, 'utf8').replace(/^﻿/, '')); } catch { return {}; } };
const log = (o) => fs.appendFile(logFile, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n', () => {});
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const hits = new Map();           // name -> timestamps within last 60s
const rateOk = (name, rpm) => {
  const now = Date.now(), arr = (hits.get(name) || []).filter((t) => now - t < 60000);
  if (arr.length >= rpm) { hits.set(name, arr); return false; }
  arr.push(now); hits.set(name, arr); return true;
};

let running = 0; const waiting = [];   // one GPU job at a time
const acquire = () => new Promise((resolve, reject) => {
  if (running === 0) { running++; return resolve(); }
  if (waiting.length >= MAX_QUEUE) return reject(new Error('queue full'));
  waiting.push(resolve);
});
const release = () => { const n = waiting.shift(); if (n) n(); else running--; };

http.createServer(async (req, res) => {
  const t0 = Date.now(); let who = '-', rec = null;
  const h = req.headers;   // cf-* headers are set by Cloudflare; the gateway only listens on localhost, so they come via the tunnel
  const caller = { ip: h['cf-connecting-ip'] || req.socket.remoteAddress, country: h['cf-ipcountry'], ua: h['user-agent'], ray: h['cf-ray'] };
  const done = (status, extra = {}) => {
    log({ who, method: req.method, path: req.url, status, ms: Date.now() - t0, ...caller, ...extra });
    if (rec && convFile) fs.appendFile(convFile, JSON.stringify({ t: new Date().toISOString(), who, status, ...caller, session: rec.session, turn: rec.turn, request: rec.messages, reply: rec.reply }) + '\n', () => {});
  };
  try {
    const url = req.url.split('?')[0];
    if (url === '/ask') {   // fixed-prompt "about me" route; off unless ASK_ENABLED=1; needs a key with scope "ask"
      if (!ASK_ENABLED || req.method !== 'POST') { done(404); return send(res, 404, { error: 'not found' }); }
      const am = /^Bearer (.+)$/.exec(h.authorization || '');
      const ae = am && Object.entries(loadKeys()).find(([, v]) => v.key === am[1] && v.scope === 'ask');
      if (!ae) { done(401); return send(res, 401, { error: 'invalid or missing key' }); }
      who = ae[0];
      if (h['x-visitor-ip']) caller.ip = String(h['x-visitor-ip']).slice(0, 64);   // set by our Worker; trusted only because the ask key is required
      if (!rateOk(who, ae[1].rpm || 5) || !rateOk('ip:' + caller.ip, ASK_IP_RPM)) { done(429); return send(res, 429, { error: 'rate limit' }); }
      const ch = []; let sz = 0;
      for await (const c of req) { sz += c.length; if (sz > 4096) { done(413); return send(res, 413, { error: 'body too large' }); } ch.push(c); }
      let q, sid; try {
        const j = JSON.parse(Buffer.concat(ch).toString('utf8'));
        const ks = Object.keys(j);
        const okKeys = ks.every((k) => k === 'question' || k === 'session_id') && (j.session_id === undefined || (typeof j.session_id === 'string' && j.session_id.length <= 64));
        q = (okKeys && typeof j.question === 'string') ? j.question.trim() : null; sid = j.session_id;
      } catch { q = null; }
      if (!q || q.length > 500) { done(400); return send(res, 400, { error: 'send {"question": "..."} with 1-500 characters, optional session_id' }); }
      // server-side follow-up history: never accepted from the client
      const nowT = Date.now();
      for (const [k, v] of sessions) if (nowT - v.last > SESSION_TTL) sessions.delete(k);
      let sess = sid && sessions.get(sid);
      if (!sess || sess.ip !== caller.ip) {
        while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);   // Map keeps insertion order: oldest first
        sid = crypto.randomBytes(16).toString('hex'); sess = { turns: [], last: nowT, ip: caller.ip, n: 0 }; sessions.set(sid, sess);
      }
      let sys; try { sys = fs.readFileSync(ASK_PROMPT, 'utf8').replace('<<FACTSHEET>>', () => fs.readFileSync(ASK_FACTS, 'utf8')); } catch { done(500); return send(res, 500, { error: 'internal error' }); }
      try { await acquire(); } catch { done(503); return send(res, 503, { error: 'busy, try again' }); }
      const hist = sess.turns.slice(-MAX_TURNS);
      const estTok = () => (sys.length + q.length + hist.reduce((n, t) => n + t.q.length + t.a.length, 0)) / 4;   // chars->tokens; measured ratio for this prompt is ~4.5, so 4 is slightly conservative
      let dropped = 0;
      while (hist.length && estTok() + 200 > ASK_CTX * 0.92) { hist.shift(); dropped++; }
      const msgs = [{ role: 'system', content: sys }];
      for (const t of hist) msgs.push({ role: 'user', content: t.q }, { role: 'assistant', content: t.a });
      msgs.push({ role: 'user', content: q });
      const payload = Buffer.from(JSON.stringify({ model: ASK_MODEL, stream: false, think: false, keep_alive: '5m',
        options: { num_ctx: ASK_CTX, temperature: 0.1, num_predict: 200 }, messages: msgs }));
      const up = http.request({ ...OLLAMA, path: '/api/chat', method: 'POST', timeout: UPSTREAM_TIMEOUT,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, (ur) => {
        const out = []; ur.on('data', (c) => out.push(c));
        ur.on('end', () => {
          release(); let a = null, extra = {};
          try { const j = JSON.parse(Buffer.concat(out).toString('utf8')); a = j.message && j.message.content && j.message.content.trim(); extra = { model: j.model, in: j.prompt_eval_count, out: j.eval_count, hist: hist.length, dropped }; } catch {}
          if (ur.statusCode !== 200 || !a) { done(502, extra); return send(res, 502, { error: 'model server unavailable' }); }
          sess.turns.push({ q, a }); sess.turns = sess.turns.slice(-MAX_TURNS); sess.last = Date.now(); sess.n++;
          rec = { messages: [{ role: 'user', content: q }], reply: a, session: sid, turn: sess.n };
          done(200, extra); send(res, 200, { answer: a, session_id: sid });
        });
      });
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', () => { release(); if (!res.headersSent) send(res, 502, { error: 'model server unavailable' }); done(502); });
      up.end(payload); return;
    }
    if (!ALLOWED_PATHS.has(url)) { done(404); return send(res, 404, { error: 'not found' }); }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const keys = loadKeys();
    const entry = m && Object.entries(keys).find(([, v]) => v.key === m[1] && v.scope !== 'ask');
    if (!entry) { done(401); return send(res, 401, { error: 'invalid or missing key' }); }
    who = entry[0];
    if (!rateOk(who, entry[1].rpm || 20)) { done(429); return send(res, 429, { error: 'rate limit' }); }

    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { done(413); return send(res, 413, { error: 'body too large' }); } chunks.push(c); }
    let body = Buffer.concat(chunks);
    if (req.method === 'POST') {
      let j; try { j = JSON.parse(body.toString('utf8')); } catch { done(400); return send(res, 400, { error: 'bad json' }); }
      if (!ALLOWED_MODELS.has(j.model)) { done(400); return send(res, 400, { error: 'model not allowed', allowed: [...ALLOWED_MODELS] }); }
      rec = { messages: j.messages };
      j.stream = false;
      j.max_tokens = Math.min(Number(j.max_tokens) || MAX_TOKENS_CAP, MAX_TOKENS_CAP);
      j.keep_alive = '5m';
      body = Buffer.from(JSON.stringify(j));
    }
    try { await acquire(); } catch { done(503); return send(res, 503, { error: 'busy, try again' }); }
    const up = http.request({ ...OLLAMA, path: url, method: req.method, timeout: UPSTREAM_TIMEOUT,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (ur) => {
      const out = []; ur.on('data', (c) => out.push(c));
      ur.on('end', () => {
        const buf = Buffer.concat(out); let extra = {};
        try { const j = JSON.parse(buf.toString('utf8')); if (rec && j.choices) rec.reply = j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (j.usage) extra ={ model: j.model, in: j.usage.prompt_tokens, out: j.usage.completion_tokens }; } catch {}
        res.writeHead(ur.statusCode, { 'Content-Type': ur.headers['content-type'] || 'application/json' });
        res.end(buf); release(); done(ur.statusCode, extra);
      });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', () => { release(); if (!res.headersSent) send(res, 502, { error: 'model server unavailable' }); done(502); });
    up.end(body);
  } catch (e) { done(500); if (!res.headersSent) send(res, 500, { error: 'internal error' }); }
}).listen(PORT, '127.0.0.1', () => console.log(`gateway on 127.0.0.1:${PORT}`));
