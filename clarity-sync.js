// ═══════════════════════════════════════════════════════════════════
// 🌱 CLARITY SYNC (desktop) — wellness + coach goals via /api/sync/me
// Pulls habit history and AI goals on login; pushes when local changes.
// ═══════════════════════════════════════════════════════════════════
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

let cfg = null;

function init(c) { cfg = c; }

function request(method, apiPath, body) {
  return new Promise(async (resolve, reject) => {
    let token = null;
    try { token = await cfg.getIdToken(); } catch (e) {}
    if (!token) return reject(new Error('not signed in'));
    const url = new URL(cfg.apiBase + apiPath);
    const lib = url.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({
      method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => out += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }); }
        catch (e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('clarity sync timed out')));
    if (data) req.write(data);
    req.end();
  });
}

function loadLocal() {
  try {
    if (cfg.wellnessFile && fs.existsSync(cfg.wellnessFile)) {
      return JSON.parse(fs.readFileSync(cfg.wellnessFile, 'utf8'));
    }
  } catch (e) {}
  return { history: {}, seenMilestones: [], steps: 0, sleepHours: 0, updatedAt: 0 };
}

function saveLocal(data) {
  if (!cfg.wellnessFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.wellnessFile), { recursive: true });
    fs.writeFileSync(cfg.wellnessFile, JSON.stringify(data, null, 2));
  } catch (e) { console.warn('clarity-sync save:', e.message); }
}

function mergeHistory(local, remote) {
  const out = { ...(local.history || {}) };
  for (const [day, habits] of Object.entries(remote.history || {})) {
    const localDay = out[day] || [];
    const merged = [...new Set([...localDay, ...(habits || [])])];
    if (merged.length) out[day] = merged;
  }
  return out;
}

function mergeWellness(local, remote) {
  const localTs = local.updatedAt || 0;
  const remoteTs = remote.updatedAt || 0;
  const base = remoteTs >= localTs ? { ...remote } : { ...local };
  return {
    history: mergeHistory(local, remote),
    seenMilestones: [...new Set([...(local.seenMilestones || []), ...(remote.seenMilestones || [])])],
    steps: Math.max(local.steps || 0, remote.steps || 0),
    sleepHours: Math.max(local.sleepHours || 0, remote.sleepHours || 0),
    aiGoals: (remoteTs >= localTs && remote.aiGoals?.length) ? remote.aiGoals : (local.aiGoals || remote.aiGoals || []),
    aiGoalsDate: remote.aiGoalsDate || local.aiGoalsDate || null,
    aiNewHabit: remote.aiNewHabit || local.aiNewHabit || null,
    aiInsight: remote.aiInsight || local.aiInsight || null,
    aiIntent: remote.aiIntent || local.aiIntent || null,
    updatedAt: Math.max(localTs, remoteTs, Date.now()),
  };
}

async function pullOnLogin() {
  console.log('🌱 clarity-sync: pulling wellness data...');
  try {
    const res = await request('GET', '/api/sync/me');
    if (res.status !== 200 || !res.body) return;
    const remote = res.body;
    if (!remote.exists && !remote.history) return;
    const local = loadLocal();
    const merged = mergeWellness(local, {
      history: remote.history || {},
      seenMilestones: remote.seenMilestones || [],
      steps: remote.steps || 0,
      sleepHours: remote.sleepHours || 0,
      aiGoals: remote.aiGoals || [],
      aiGoalsDate: remote.aiGoalsDate || null,
      aiNewHabit: remote.aiNewHabit || null,
      aiInsight: remote.aiInsight || null,
      aiIntent: remote.aiIntent || null,
      updatedAt: remote.updatedAt || 0,
    });
    saveLocal(merged);
    cfg.onWellnessApplied?.(merged);
    console.log('🌱 clarity-sync: wellness merged (', Object.keys(merged.history || {}).length, 'days )');
    if ((local.updatedAt || 0) > (remote.updatedAt || 0)) await pushNow();
  } catch (e) { console.warn('🌱 clarity-sync pull skipped:', e.message); }
}

async function pushNow() {
  try {
    const local = loadLocal();
    const res = await request('POST', '/api/sync', {
      history: local.history || {},
      seenMilestones: local.seenMilestones || [],
      steps: local.steps || 0,
      sleepHours: local.sleepHours || 0,
      aiGoals: local.aiGoals || [],
      aiGoalsDate: local.aiGoalsDate || null,
      aiNewHabit: local.aiNewHabit || null,
      aiInsight: local.aiInsight || null,
      aiIntent: local.aiIntent || null,
    });
    if (res.status === 200) console.log('🌱 clarity-sync: pushed wellness to cloud');
  } catch (e) { console.warn('🌱 clarity-sync push skipped:', e.message); }
}

function getWellness() { return loadLocal(); }

module.exports = { init, pullOnLogin, pushNow, getWellness, mergeWellness };
