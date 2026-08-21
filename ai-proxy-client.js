// ═══════════════════════════════════════════════════════════════════
// 🔐 AI CLIENT SHIM — drop-in replacements for the Anthropic + Groq
// clients that route EVERY call through the backend proxy instead of
// calling the AI provider directly. No API key ships in the app; every
// call is metered (credits) and the real keys stay server-side.
//
// Usage in main.js (replace the real client construction):
//   const { makeAnthropicShim, makeGroqShim } = require('./ai-proxy-client');
//   const anthropic = makeAnthropicShim({ getIdToken: () => asukaAuth.getIdToken() });
//   const groq      = makeGroqShim({ getIdToken: () => asukaAuth.getIdToken() });
//
// The shims expose the same surface the code already uses:
//   anthropic.messages.create({ model, max_tokens, system, messages })
//   groq.chat.completions.create({ model, messages, ... })
// ═══════════════════════════════════════════════════════════════════
const http = require('http');
const https = require('https');

const { getApiBase } = require('./api-base');
function apiBase() { return getApiBase(); }

// low-level POST to the backend with the user's auth token
function backendPost(path, body, getIdToken, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  return new Promise(async (resolve, reject) => {
    let token = null;
    try { token = await getIdToken(); } catch (e) {}
    if (!token) return reject(new Error('not signed in'));
    const url = new URL(apiBase() + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body || {});
    const req = lib.request({
      method: 'POST', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try {
          const j = out ? JSON.parse(out) : {};
          if (res.statusCode === 402) return reject(Object.assign(new Error(j.message || 'Out of credits'), { code: 'INSUFFICIENT_CREDITS', balance: j.balance }));
          if (res.statusCode >= 400) return reject(new Error(j.detail || j.error || ('HTTP ' + res.statusCode)));
          resolve(j);
        } catch (e) { reject(new Error('bad proxy response: ' + out.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ai proxy timeout')); });
    req.write(data); req.end();
  });
}

// ── Anthropic shim: anthropic.messages.create(...) → backend /ai/chat ──
function makeAnthropicShim({ getIdToken }) {
  return {
    messages: {
      create: async (params = {}) => {
        const resp = await backendPost('/ai/chat', {
          model: params.model,
          system: params.system,
          messages: params.messages || [],
          max_tokens: params.max_tokens,
          action: 'chat',
        }, getIdToken);
        // return in the SAME shape the SDK returns, so existing code (res.content[0].text) works
        return { content: resp.content || [], balance: resp.balance };
      },
    },
  };
}

// ── Groq shim: groq.chat.completions.create(...) → backend /ai/chat ──
// (backend serves it via Claude; the app doesn't need Groq's key.)
function makeGroqShim({ getIdToken }) {
  return {
    chat: {
      completions: {
        create: async (params = {}) => {
          // convert Groq/OpenAI-style messages → our proxy, then back to Groq shape
          const sys = (params.messages || []).find(m => m.role === 'system');
          const msgs = (params.messages || []).filter(m => m.role !== 'system');
          const resp = await backendPost('/ai/chat', {
            model: params.model, system: sys ? sys.content : undefined,
            messages: msgs, max_tokens: params.max_tokens, action: 'chat',
          }, getIdToken);
          const text = (resp.content || []).map(b => b.text || '').join('');
          // shape like an OpenAI/Groq completion
          return { choices: [{ message: { role: 'assistant', content: text } }], balance: resp.balance };
        },
      },
    },
  };
}

// ── Grok agent: POST /ai/grok-agent → live web/X/code research ──
function runGrokAgent({ getIdToken, query, task, context }) {
  return backendPost('/ai/grok-agent', { query, task, context }, getIdToken, { timeoutMs: 130000 });
}

module.exports = { makeAnthropicShim, makeGroqShim, backendPost, runGrokAgent };
