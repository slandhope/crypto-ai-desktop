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

function applyStudyFromCloud(lessons) {
  if (!lessons || !cfg.saveLessonLibrary) return;
  const cloudLib = lessons.studyLibrary;
  if (cloudLib?.lessons?.length) {
    const local = cfg.loadLessonLibrary ? cfg.loadLessonLibrary() : { lessons: [] };
    const byId = new Map();
    for (const l of [...(local.lessons || []), ...(cloudLib.lessons || [])]) {
      const id = l.id || `les_${l.ts || Date.now()}`;
      const prev = byId.get(id);
      const ts = l.ts || (l.date ? new Date(l.date).getTime() : 0);
      const prevTs = prev?.ts || (prev?.date ? new Date(prev.date).getTime() : 0);
      if (!prev || ts >= prevTs) {
        byId.set(id, {
          id,
          topic: l.topic,
          source: l.source || [],
          beats: l.beats || l.steps || [],
          beatCount: l.beatCount ?? (l.beats || l.steps || []).length,
          ts: ts || Date.now(),
        });
      }
    }
    const merged = {
      streak: Math.max(local.streak || 0, cloudLib.streak || 0),
      lastStudyDay: cloudLib.lastStudyDay || local.lastStudyDay || null,
      lessons: [...byId.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 100),
    };
    cfg.saveLessonLibrary(merged, { skipPush: true });
  }
  const cloudCards = lessons.flashcards;
  if (cloudCards?.cards?.length && cfg.saveSrsFlashcards) {
    const local = cfg.loadSrsFlashcards ? cfg.loadSrsFlashcards() : { cards: [] };
    const byKey = new Map();
    for (const c of [...(local.cards || []), ...(cloudCards.cards || [])]) {
      const key = c.id || `${c.q}|${c.a}`;
      const prev = byKey.get(key);
      const due = c.nextReview ?? c.due ?? 0;
      const prevDue = prev?.nextReview ?? prev?.due ?? 0;
      if (!prev || due >= prevDue) {
        byKey.set(key, {
          id: c.id || key,
          q: c.q,
          a: c.a,
          book: c.topic || c.book || '',
          page: c.page || 0,
          interval: c.interval || 0,
          due: c.nextReview ?? c.due ?? Date.now(),
          reps: c.reps || 0,
        });
      }
    }
    cfg.saveSrsFlashcards({ cards: [...byKey.values()].slice(-300) }, { skipPush: true });
  }
}

// map local files → the /state shape
function localToState() {
  const mem = stripSync(cfg.loadMemory() || {});
  const care = cfg.loadCare() || {};
  const sync = buildSyncBundle(cfg);
  const studyLib = cfg.loadLessonLibrary ? cfg.loadLessonLibrary() : null;
  const flashcards = cfg.loadSrsFlashcards ? cfg.loadSrsFlashcards() : null;
  const lessons = {
    ...(mem.lessons || {}),
    ...(studyLib ? {
      studyLibrary: {
        streak: studyLib.streak || 0,
        lastStudyDay: studyLib.lastStudyDay || null,
        lessons: (studyLib.lessons || []).map((l) => ({
          id: l.id,
          topic: l.topic,
          source: l.source || [],
          steps: l.steps || l.beats || [],
          beats: l.beats || l.steps || [],
          beatCount: l.beatCount ?? (l.beats || l.steps || []).length,
          ts: l.ts || Date.now(),
          date: l.date || (l.ts ? new Date(l.ts).toISOString() : new Date().toISOString()),
        })),
        updatedAt: Date.now(),
      },
    } : {}),
    ...(flashcards ? {
      flashcards: {
        cards: (flashcards.cards || []).map((c) => ({
          id: c.id || `${c.q}|${c.a}`,
          q: c.q,
          a: c.a,
          topic: c.topic || c.book || '',
          interval: c.interval || 0,
          nextReview: c.nextReview ?? c.due ?? Date.now(),
          ease: c.ease || 2.5,
        })),
        updatedAt: Date.now(),
      },
    } : {}),
  };
  return {
    memory: { ...mem, __sync: sync },
    bond: care.bondXP || 0,
    coins: care.coins || 0,
    personality: mem.personality || 'chill',
    level: 1,
    streaks: {},
    lessons,
    cosmetics: { owned: care.owned || [], care: { hunger: care.hunger, happiness: care.happiness, cleanliness: care.cleanliness, affection: care.affection } },
    allocations: mem.allocations || {},
    updatedAt: Math.max(mem.lastSeen || 0, care.lastTick || 0, latestSyncTs(sync), lessons.studyLibrary?.updatedAt || 0),
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
  if (state.lessons) {
    newMem.lessons = state.lessons;
    applyStudyFromCloud(state.lessons);
  }
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
