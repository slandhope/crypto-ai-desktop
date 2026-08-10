'use strict';
/**
 * Trading state store — Postgres primary, JSON file fallback.
 * Sync get/set for existing scanner/main call sites; async hydrate + flush.
 *
 * Keys: paper | snipes | daily_signals | dev_state
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_PAPER = (balance = 100000) => ({
  balance,
  trades: [],
  stats: { wins: 0, losses: 0, totalPnl: 0 },
});

const caches = Object.create(null);
const dirty = Object.create(null);
const filePaths = Object.create(null);
let pool = null;
let flushTimer = null;
let ready = false;
let source = 'none'; // 'postgres' | 'file' | 'memory'

function readJson(file, fallback) {
  try {
    if (file && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return typeof fallback === 'function' ? fallback() : (fallback || {});
}

function writeJson(file, data) {
  if (!file) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn('trading-store file write:', e.message);
  }
}

async function pgGet(key) {
  if (!pool) return null;
  try {
    const r = await pool.query('SELECT data FROM trading_blobs WHERE key=$1', [key]);
    return r.rows[0]?.data || null;
  } catch (e) {
    console.warn('trading-store pg get:', e.message);
    return null;
  }
}

async function pgSet(key, data) {
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO trading_blobs (key, data, updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (key) DO UPDATE SET data=$2::jsonb, updated_at=NOW()`,
      [key, JSON.stringify(data)]
    );
    return true;
  } catch (e) {
    console.warn('trading-store pg set:', e.message);
    return false;
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDirty().catch(() => {});
  }, 400);
}

async function flushDirty() {
  const keys = Object.keys(dirty).filter((k) => dirty[k]);
  for (const key of keys) {
    const data = caches[key];
    if (data == null) continue;
    const ok = await pgSet(key, data);
    writeJson(filePaths[key], data); // always mirror to disk as backup
    if (ok || filePaths[key]) dirty[key] = false;
  }
}

/**
 * @param {{ pool?: any, paperFile?: string, snipesFile?: string, signalsFile?: string, paperBalance?: number }} opts
 */
async function initTradingStore(opts = {}) {
  pool = opts.pool || null;
  filePaths.paper = opts.paperFile || null;
  filePaths.snipes = opts.snipesFile || null;
  filePaths.daily_signals = opts.signalsFile || null;
  const paperBal = opts.paperBalance || 100000;

  // Prefer Postgres when available
  if (pool) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS trading_blobs (
          key TEXT PRIMARY KEY,
          data JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const paper = await pgGet('paper');
      const snipes = await pgGet('snipes');
      const signals = await pgGet('daily_signals');
      if (paper) {
        caches.paper = paper;
        source = 'postgres';
      }
      if (snipes) caches.snipes = snipes;
      if (signals) caches.daily_signals = signals;
    } catch (e) {
      console.warn('trading-store init pg:', e.message);
      pool = null;
    }
  }

  if (!caches.paper) {
    caches.paper = readJson(filePaths.paper, () => DEFAULT_PAPER(paperBal));
    if (!source || source === 'none') source = filePaths.paper ? 'file' : 'memory';
  }
  if (!caches.snipes) {
    caches.snipes = readJson(filePaths.snipes, () => ({ positions: [] }));
  }
  if (!caches.daily_signals) {
    caches.daily_signals = readJson(filePaths.daily_signals, () => ({ signals: {}, lastUpdated: null, date: null }));
  }

  // Seed PG from file if PG empty but file had data
  if (pool) {
    const existing = await pgGet('paper');
    if (!existing && caches.paper) await pgSet('paper', caches.paper);
    if (!(await pgGet('snipes')) && caches.snipes) await pgSet('snipes', caches.snipes);
    if (!(await pgGet('daily_signals')) && caches.daily_signals) await pgSet('daily_signals', caches.daily_signals);
    if (source !== 'postgres') source = 'postgres+file';
  }

  ready = true;
  console.log(`📊 Trading store ready (source=${source})`);
  return { ok: true, source };
}

function getBlob(key, fallback) {
  if (caches[key] == null) caches[key] = typeof fallback === 'function' ? fallback() : (fallback || {});
  return caches[key];
}

function setBlob(key, data) {
  caches[key] = data;
  dirty[key] = true;
  scheduleFlush();
  return data;
}

function loadPaperTrades(paperBalance = 100000) {
  return getBlob('paper', () => DEFAULT_PAPER(paperBalance));
}

function savePaperTrades(d) {
  return setBlob('paper', d);
}

function loadSnipes() {
  return getBlob('snipes', () => ({ positions: [] }));
}

function saveSnipes(d) {
  return setBlob('snipes', d);
}

function loadDailySignalsBlob() {
  return getBlob('daily_signals', () => ({ signals: {}, lastUpdated: null, date: null }));
}

function saveDailySignalsBlob(d) {
  return setBlob('daily_signals', d);
}

function getStatus() {
  return { ready, source, dirty: { ...dirty }, keys: Object.keys(caches) };
}

async function shutdown() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushDirty();
}

module.exports = {
  initTradingStore,
  loadPaperTrades,
  savePaperTrades,
  loadSnipes,
  saveSnipes,
  loadDailySignalsBlob,
  saveDailySignalsBlob,
  getStatus,
  shutdown,
  DEFAULT_PAPER,
};
