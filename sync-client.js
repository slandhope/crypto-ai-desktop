// ═══════════════════════════════════════════════════════════════════
// ☁️ SYNC CLIENT (desktop) — her brain travels PC ↔ phone via /state.
// Maps local files → asuka_state in Postgres. Pulls on login, pushes after changes.
// Full memory (chat, learnings, journal, notes) lives in memory.__sync.
// ═══════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');
const { buildSyncBundle, latestSyncTs, applySyncMerge, mergeSyncBundles } = require('./memory-sync');

let cfg = null;
function init(c) { cfg = c; }

function stripSync(mem) {
  if (!mem || typeof mem !== 'object') return mem || {};
  const { __sync, ...rest } = mem;
  return rest;
}

// map local files → the /state shape
function localToState() {
  const mem = stripSync(cfg.loadMemory() || {});
  const care = cfg.loadCare() || {};
  const sync = buildSyncBundle(cfg);
  return {
    memory: { ...mem, __sync: sync },
    bond: care.bondXP || 0,
    coins: care.coins || 0,
    personality: mem.personality || 'chill',
    level: 1,
    streaks: {},
    lessons: mem.lessons || {},
    cosmetics: { owned: care.owned || [], care: { hunger: care.hunger, happiness: care.happiness, cleanliness: care.cleanliness, affection: care.affection } },
    allocations: mem.allocations || {},
    updatedAt: Math.max(mem.lastSeen || 0, care.lastTick || 0, latestSyncTs(sync)),
  };
}

// map a /state response → back into the local files (merge, never blind overwrite)
function stateToLocal(state, opts = {}) {
  if (!state) return;
  const mem = cfg.loadMemory() || {};
  const care = cfg.loadCare() || {};
  const cloudMem = state.memory || {};
  const cloudSync = cloudMem.__sync || null;
  const localSync = buildSyncBundle(cfg);

  if (cloudSync) {
    const merged = opts.mergeSync ? mergeSyncBundles(localSync, cloudSync) : cloudSync;
    applySyncMerge(localSync, merged, cfg);
    cfg.onSyncApplied?.(merged);
  }

  const newMem = { ...stripSync(mem), ...stripSync(cloudMem) };
  if (state.personality) newMem.personality = state.personality;
  if (state.lessons) newMem.lessons = state.lessons;
  if (state.allocations) newMem.allocations = state.allocations;
  cfg.saveMemory(newMem, { skipPush: true });

  const newCare = { ...care };
  if (typeof state.bond === 'number') newCare.bondXP = state.bond;
  if (typeof state.coins === 'number') newCare.coins = state.coins;
  if (state.cosmetics) {
    if (state.cosmetics.owned) newCare.owned = state.cosmetics.owned;
    if (state.cosmetics.care) Object.assign(newCare, state.cosmetics.care);
  }
  cfg.saveCare(newCare, { skipPush: true });
}

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
    req.setTimeout(8000, () => { req.destroy(new Error('sync request timed out')); });
    if (data) req.write(data);
    req.end();
  });
}

async function pullOnLogin() {
  console.log('☁️ sync: checking cloud for Asuka state...');
  try {
    const res = await request('GET', '/state');
    if (res.status === 200 && res.body) {
      const cloud = res.body;
      const local = localToState();
      if ((cloud.updatedAt || 0) >= (local.updatedAt || 0)) {
        stateToLocal(cloud, { mergeSync: true });
        console.log('☁️ pulled Asuka state from cloud (memory merged)');
      } else {
        await pushNow();
        console.log('☁️ local newer — pushed to cloud');
      }
    } else {
      console.warn('☁️ sync: unexpected response', res.status, JSON.stringify(res.body || '').slice(0, 120));
    }
  } catch (e) { console.warn('☁️ sync pull skipped:', e.message); }
}

async function pullNow() {
  try {
    const res = await request('GET', '/state');
    if (res.status === 200 && res.body) {
      stateToLocal(res.body, { mergeSync: true });
      return true;
    }
  } catch (e) { console.warn('sync pull skipped:', e.message); }
  return false;
}

async function pushNow() {
  try {
    const state = localToState();
    const res = await request('PUT', '/state', state);
    if (res.status === 409 && res.body && res.body.server) {
      stateToLocal(res.body.server, { mergeSync: true });
      await request('PUT', '/state', localToState());
      console.log('☁️ merged with server — re-pushed');
    }
  } catch (e) { console.warn('sync push skipped:', e.message); }
}

let _t = null;
function pushSoon(ms = 4000) {
  clearTimeout(_t);
  _t = setTimeout(() => { pushNow(); }, ms);
}

module.exports = { init, pullOnLogin, pullNow, pushNow, pushSoon };
