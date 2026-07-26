// ═══════════════════════════════════════════════════════════════════
// ☁️ SYNC CLIENT (desktop) — her brain travels PC ↔ phone via /state.
// Maps the local files (memory.json, care-state.json) to the unified
// asuka_state row in Postgres. Pulls on login, pushes after changes.
//
//   const sync = require('./sync-client');
//   sync.init({ getIdToken, loadMemory, saveMemory, loadCare, saveCare, apiBase });
//   await sync.pullOnLogin();     // after sign-in: fetch cloud → local
//   sync.pushSoon();              // after any change: debounced push local → cloud
// ═══════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');

let cfg = null;
function init(c) { cfg = c; }

// map local files → the /state shape
function localToState() {
  const mem = cfg.loadMemory() || {};
  const care = cfg.loadCare() || {};
  return {
    memory: mem,
    bond: care.bondXP || 0,
    coins: care.coins || 0,
    personality: mem.personality || 'chill',
    level: 1,
    streaks: {},
    lessons: mem.lessons || {},
    cosmetics: { owned: care.owned || [], care: { hunger: care.hunger, happiness: care.happiness, cleanliness: care.cleanliness, affection: care.affection } },
    allocations: mem.allocations || {},
    updatedAt: Math.max(mem.lastSeen || 0, care.lastTick || 0),
  };
}

// map a /state response → back into the local files
function stateToLocal(state) {
  if (!state) return;
  const mem = cfg.loadMemory() || {};
  const care = cfg.loadCare() || {};
  // merge cloud memory over local (cloud is source of truth on pull)
  const newMem = { ...mem, ...(state.memory || {}) };
  if (state.personality) newMem.personality = state.personality;
  if (state.lessons) newMem.lessons = state.lessons;
  if (state.allocations) newMem.allocations = state.allocations;
  cfg.saveMemory(newMem);

  const newCare = { ...care };
  if (typeof state.bond === 'number') newCare.bondXP = state.bond;
  if (typeof state.coins === 'number') newCare.coins = state.coins;
  if (state.cosmetics) {
    if (state.cosmetics.owned) newCare.owned = state.cosmetics.owned;
    if (state.cosmetics.care) Object.assign(newCare, state.cosmetics.care);
  }
  cfg.saveCare(newCare);
}

// low-level request to the backend with the auth token
function request(method, path, body) {
  return new Promise(async (resolve, reject) => {
    let token = null;
    try { token = await cfg.getIdToken(); } catch (e) {}
    if (!token) return reject(new Error('not signed in'));
    const url = new URL(cfg.apiBase + path);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({
      method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }); } catch (e) { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// pull cloud state into local files (called right after login)
async function pullOnLogin() {
  try {
    const res = await request('GET', '/state');
    if (res.status === 200 && res.body) {
      const cloud = res.body;
      const local = localToState();
      // if cloud is newer or local is empty, take cloud; else push local up
      if ((cloud.updatedAt || 0) >= (local.updatedAt || 0)) {
        stateToLocal(cloud);
        console.log('☁️ pulled Asuka state from cloud');
      } else {
        await pushNow();
        console.log('☁️ local newer — pushed to cloud');
      }
    }
  } catch (e) { console.warn('sync pull skipped:', e.message); }
}

// push local → cloud immediately
async function pushNow() {
  try {
    const state = localToState();
    const res = await request('PUT', '/state', state);
    if (res.status === 409 && res.body && res.body.server) {
      // server had newer — accept it locally
      stateToLocal(res.body.server);
      console.log('☁️ server newer — merged down');
    }
  } catch (e) { console.warn('sync push skipped:', e.message); }
}

// debounced push — call after any local change; batches rapid edits
let _t = null;
function pushSoon(ms = 4000) {
  clearTimeout(_t);
  _t = setTimeout(() => { pushNow(); }, ms);
}

module.exports = { init, pullOnLogin, pushNow, pushSoon };
