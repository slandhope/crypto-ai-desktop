// ═══════════════════════════════════════════════════════════════════
// 🔑 DESKTOP AUTH CLIENT — Google sign-in via Cognito Hosted UI.
// Flow: open Cognito login in a window → user picks Google → Cognito
// redirects to a tiny loopback server we spin up → we exchange the
// code for tokens → store them → refresh when they expire.
//
// Wire in main.js:
//   const asukaAuth = require('./auth-client');
//   asukaAuth.init({ app, BrowserWindow, shell });
//   ipcMain.handle('auth-google-login', () => asukaAuth.login());
//   asukaAuth.getIdToken()   → current valid id token (auto-refreshes)
//   asukaAuth.getUser()      → { sub, email, name } | null
//   asukaAuth.logout()
//
// CONFIG — fill these with your Cognito values (public, safe):
// ═══════════════════════════════════════════════════════════════════
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const COGNITO_DOMAIN = 'eu-north-1wpzxcs0wy.auth.eu-north-1.amazoncognito.com';
const CLIENT_ID      = '2qfspmdalv01gd3gjvmj0c5gfl';
const LOOPBACK_PORT  = 53682;                          // must be in Cognito callback URLs
const REDIRECT_URI   = `http://localhost:${LOOPBACK_PORT}/callback`;
const SCOPES         = 'openid email profile';

const TOKEN_FILE = path.join(os.homedir(), '.asuka-auth.json');
let _secretStore = null;
try { _secretStore = require('./secret-store'); } catch (_) {}

let _ctx = null;   // { app, BrowserWindow, shell }
let _tokens = null; // { id_token, access_token, refresh_token, expires_at, user }

function init(ctx) { _ctx = ctx; _load(); }

function _load() {
  try {
    if (_secretStore) {
      const sealed = _secretStore.loadAuthTokens();
      if (sealed) { _tokens = sealed; return; }
    }
  } catch (_) {}
  try {
    _tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    // migrate plaintext → safeStorage
    if (_tokens && _secretStore) {
      _secretStore.saveAuthTokens(_tokens);
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
    }
  } catch (e) { _tokens = null; }
}
function _save() {
  try {
    if (_secretStore && _secretStore.encryptionAvailable()) {
      _secretStore.saveAuthTokens(_tokens);
      try { fs.unlinkSync(TOKEN_FILE); } catch (_) {}
      return;
    }
  } catch (_) {}
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(_tokens), { mode: 0o600 }); } catch (e) {}
}
function _clear() {
  try { if (_secretStore) _secretStore.clearAuthTokens(); } catch (_) {}
  try { fs.unlinkSync(TOKEN_FILE); } catch (e) {}
  _tokens = null;
}

// PKCE — protects the code exchange on public clients
function _pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function _decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')); }
  catch (e) { return {}; }
}

// POST to Cognito /oauth2/token
function _tokenRequest(params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request({
      method: 'POST',
      hostname: COGNITO_DOMAIN,
      path: '/oauth2/token',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { const j = JSON.parse(data); if (j.error) { console.error('🔑 Token exchange rejected:', j); reject(new Error(j.error + ': ' + (j.error_description||''))); } else resolve(j); }
        catch (e) { console.error('🔑 Token endpoint raw:', data.slice(0,200)); reject(new Error('token endpoint: ' + data.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function _storeTokens(t) {
  const user = _decodeJwt(t.id_token);
  _tokens = {
    id_token: t.id_token,
    access_token: t.access_token,
    refresh_token: t.refresh_token || (_tokens && _tokens.refresh_token),
    expires_at: Date.now() + (t.expires_in || 3600) * 1000 - 60000, // refresh 1 min early
    user: { sub: user.sub, email: user.email || null, name: user.name || user['cognito:username'] || null },
  };
  _save();
  return _tokens.user;
}

// the main login flow
function login() {
  return new Promise((resolve, reject) => {
    if (!_ctx) return reject(new Error('auth not initialized'));
    const { BrowserWindow } = _ctx;
    const { verifier, challenge } = _pkce();
    const state = crypto.randomBytes(16).toString('hex');

    // 1. spin up the loopback server to catch the redirect
    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/callback')) { res.writeHead(404); res.end(); return; }
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const err = url.searchParams.get('error');

      const done = (html) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); };

      const errDesc = url.searchParams.get('error_description') || '';
      if (err) { console.error('🔑 Cognito callback error:', err, errDesc); done(`<h2>Sign-in failed</h2><p><b>${err}</b></p><p>${errDesc}</p><p>You can close this window.</p>`); cleanup(); reject(new Error(err + ': ' + errDesc)); return; }
      if (returnedState !== state) { done('<h2>Security check failed</h2>'); cleanup(); reject(new Error('state mismatch')); return; }
      if (!code) { done('<h2>No code returned</h2>'); cleanup(); reject(new Error('no code')); return; }

      try {
        const tokens = await _tokenRequest({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
        });
        const user = _storeTokens(tokens);
        done(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#0a0710;color:#f3eefc;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><div style="font-size:40px">✓</div><h2>Signed in${user.name ? ', ' + user.name : ''}</h2><p style="color:#a99fc4">You can close this window and return to Asuka.</p></div></body></html>`);
        cleanup();
        try { const { app } = _ctx; if (app && app.focus) app.focus({ steal: true }); } catch (e) {}
        resolve({ ok: true, name: user.name, email: user.email, sub: user.sub });
      } catch (e) { done(`<h2>Sign-in error</h2><p>${e.message}</p>`); cleanup(); reject(e); }
    });

    function cleanup() {
      try { server.close(); } catch (e) {}
    }

    server.listen(LOOPBACK_PORT, '127.0.0.1', () => {
      // 2. open the Cognito hosted UI (which offers Google)
      const authParams = {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        identity_provider: 'Google',   // jump straight to Google
      };
      const authUrl = `https://${COGNITO_DOMAIN}/oauth2/authorize?` + new URLSearchParams(authParams).toString();
      console.log('🔑 Opening auth URL in system browser:', authUrl);

      // open in the user's REAL browser — passkeys / Face ID / saved logins all work there
      const { shell } = _ctx;
      shell.openExternal(authUrl);
    });

    server.on('error', (e) => reject(new Error('loopback failed: ' + e.message)));
  });
}

// get a valid id token, refreshing if needed
async function getIdToken() {
  if (!_tokens) return null;
  if (Date.now() < _tokens.expires_at) return _tokens.id_token;
  if (!_tokens.refresh_token) return null;
  try {
    const t = await _tokenRequest({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: _tokens.refresh_token,
    });
    _storeTokens(t);
    return _tokens.id_token;
  } catch (e) { _clear(); return null; }
}

function getUser() { return _tokens ? _tokens.user : null; }
function isLoggedIn() { return !!_tokens; }
function logout() { _clear(); }

module.exports = { init, login, getIdToken, getUser, isLoggedIn, logout };
