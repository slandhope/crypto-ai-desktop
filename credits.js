// ═══════════════════════════════════════════════════════════════════
// 🎟️  CREDITS ENGINE — per-user daily credits + buyable top-ups.
// Economy config (prices, costs, allowances) lives in credits-config.json
// (editable LIVE from the dev panel — you control pricing anytime).
// Per-user BALANCES now live in Postgres (user_credits table) via db.js.
//   All balance functions are now ASYNC (await them).
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const db = require('./db');

const CONFIG_FILE = path.join(__dirname, 'credits-config.json');
function loadJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function saveJSON(f, o) { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch (e) {} }

function getConfig() { return loadJSON(CONFIG_FILE, {}); }
function saveConfig(cfg) { saveJSON(CONFIG_FILE, cfg); return getConfig(); }

function todayKey() { return new Date().toISOString().slice(0, 10); }
function tierCfg(cfg, tier) { return (cfg.tiers && cfg.tiers[tier]) || { label: tier, dailyCredits: 0, priceMonthly: 0 }; }
function dailyAllowance(cfg, tier) {
  const mult = (cfg.promo && cfg.promo.dailyMultiplier) || 1;
  return Math.round(tierCfg(cfg, tier).dailyCredits * mult);
}
function actionCost(cfg, action, units = 1) {
  const per = cfg.actionCosts && cfg.actionCosts[action];
  if (per == null) return null;
  return Math.ceil(per * units);
}

/** Clamp client-supplied model + max_tokens (prevents flat-price abuse). */
function clampAiRequest(body = {}) {
  const cfg = getConfig();
  const allow = Array.isArray(cfg.allowedModels) && cfg.allowedModels.length
    ? cfg.allowedModels
    : ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-3-5-haiku-20241022'];
  const defaultModel = cfg.defaultChatModel || 'claude-haiku-4-5-20251001';
  const maxCap = Math.min(8192, Math.max(256, Number(cfg.maxTokensCap) || 2048));
  let model = String(body.model || defaultModel);
  if (!allow.includes(model)) model = defaultModel;
  let max_tokens = Number(body.max_tokens);
  if (!Number.isFinite(max_tokens) || max_tokens < 1) max_tokens = 1024;
  max_tokens = Math.min(max_tokens, maxCap);
  return { model, max_tokens };
}

async function getUser(userId) {
  const row = await db.getCreditRow(userId);
  const u = { tier: row.tier || 'premium', dailyUsed: row.daily_used || 0, topup: row.topup || 0,
    day: row.day || todayKey(), spentToday: row.spent_today || 0 };
  if (u.day !== todayKey()) { u.day = todayKey(); u.dailyUsed = 0; u.spentToday = 0; }
  return u;
}
async function putUser(userId, u) {
  await db.saveCreditRow(userId, { tier: u.tier, daily_used: u.dailyUsed, day: u.day, topup: u.topup, spent_today: u.spentToday });
}

async function balance(userId) {
  const u = await getUser(userId);
  const cfg = getConfig();
  const allow = dailyAllowance(cfg, u.tier);
  const dailyRemaining = Math.max(0, allow - u.dailyUsed);
  return { tier: u.tier, tierLabel: tierCfg(cfg, u.tier).label, dailyAllowance: allow,
    dailyUsed: u.dailyUsed, dailyRemaining, topup: u.topup, total: dailyRemaining + u.topup,
    spentToday: u.spentToday, resetsIn: 'daily at ' + (cfg.resetTimezone || 'UTC') + ' midnight' };
}

async function check(userId, action, units = 1) {
  const u = await getUser(userId);
  const cfg = getConfig();
  const cost = actionCost(cfg, action, units);
  if (cost == null) return { ok: false, reason: 'unknown_action', action };
  const bal = await balance(userId);
  const ceiling = (cfg.fairUseHardCeiling && cfg.fairUseHardCeiling[u.tier]) || Infinity;
  if ((u.spentToday || 0) + cost > ceiling) return { ok: false, reason: 'fair_use_ceiling', cost, ceiling };
  if (bal.total < cost) return { ok: false, reason: 'insufficient_credits', cost, have: bal.total,
    message: `That needs ${cost} credits — you have ${bal.total}. Your daily credits refresh at midnight, or top up for more.` };
  return { ok: true, cost, willLeave: bal.total - cost, balance: bal };
}

function applySpend(u, cost, allow) {
  const dailyRemaining = Math.max(0, allow - u.dailyUsed);
  const fromDaily = Math.min(dailyRemaining, cost);
  const fromTopup = cost - fromDaily;
  u.dailyUsed += fromDaily;
  u.topup = Math.max(0, u.topup - fromTopup);
  u.spentToday = (u.spentToday || 0) + cost;
  return { fromDaily, fromTopup };
}

/** Atomic spend: locks the user_credits row, checks, deducts, commits. */
async function spend(userId, action, units = 1) {
  const cfg = getConfig();
  const cost = actionCost(cfg, action, units);
  if (cost == null) return { ok: false, reason: 'unknown_action', action };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let r = await client.query('SELECT * FROM user_credits WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!r.rows.length) {
      await client.query(
        `INSERT INTO user_credits (user_id, tier, daily_used, day, topup, spent_today, updated_at)
         VALUES ($1,'premium',0,$2,0,0,NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, todayKey()]
      );
      r = await client.query('SELECT * FROM user_credits WHERE user_id=$1 FOR UPDATE', [userId]);
    }
    const row = r.rows[0];
    const u = {
      tier: row.tier || 'premium',
      dailyUsed: row.daily_used || 0,
      topup: row.topup || 0,
      day: row.day || todayKey(),
      spentToday: row.spent_today || 0,
    };
    if (u.day !== todayKey()) { u.day = todayKey(); u.dailyUsed = 0; u.spentToday = 0; }

    const allow = dailyAllowance(cfg, u.tier);
    const dailyRemaining = Math.max(0, allow - u.dailyUsed);
    const total = dailyRemaining + (u.topup || 0);
    const ceiling = (cfg.fairUseHardCeiling && cfg.fairUseHardCeiling[u.tier]) || Infinity;
    if ((u.spentToday || 0) + cost > ceiling) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'fair_use_ceiling', cost, ceiling };
    }
    if (total < cost) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient_credits', cost, have: total,
        message: `That needs ${cost} credits — you have ${total}. Your daily credits refresh at midnight, or top up for more.` };
    }

    const { fromDaily, fromTopup } = applySpend(u, cost, allow);
    await client.query(
      `UPDATE user_credits SET tier=$2, daily_used=$3, day=$4, topup=$5, spent_today=$6, updated_at=NOW()
       WHERE user_id=$1`,
      [userId, u.tier, u.dailyUsed, u.day, u.topup, u.spentToday]
    );
    await client.query('COMMIT');
    return { ok: true, charged: cost, fromDaily, fromTopup, balance: await balance(userId) };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

/** Refund after a failed AI call (best-effort, also locked). */
async function refund(userId, amount) {
  const n = Math.max(0, Math.round(amount || 0));
  if (!n) return balance(userId);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    let r = await client.query('SELECT * FROM user_credits WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!r.rows.length) { await client.query('ROLLBACK'); return balance(userId); }
    const row = r.rows[0];
    const u = {
      tier: row.tier || 'premium',
      dailyUsed: Math.max(0, (row.daily_used || 0) - n),
      topup: row.topup || 0,
      day: row.day || todayKey(),
      spentToday: Math.max(0, (row.spent_today || 0) - n),
    };
    // Prefer restoring dailyUsed; leftover goes to topup
    const restoredDaily = Math.min(n, row.daily_used || 0);
    const rest = n - restoredDaily;
    u.dailyUsed = Math.max(0, (row.daily_used || 0) - restoredDaily);
    u.topup = (row.topup || 0) + rest;
    u.spentToday = Math.max(0, (row.spent_today || 0) - n);
    await client.query(
      `UPDATE user_credits SET daily_used=$2, topup=$3, spent_today=$4, updated_at=NOW() WHERE user_id=$1`,
      [userId, u.dailyUsed, u.topup, u.spentToday]
    );
    await client.query('COMMIT');
    return balance(userId);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return balance(userId);
  } finally {
    client.release();
  }
}

async function charge(userId, action, units = 1) {
  // Back-compat: charge is now atomic spend
  return spend(userId, action, units);
}

async function addTopup(userId, credits) {
  const u = await getUser(userId);
  u.topup = (u.topup || 0) + Math.max(0, Math.round(credits));
  await putUser(userId, u);
  return balance(userId);
}

async function setTier(userId, tier) {
  const cfg = getConfig();
  if (!cfg.tiers || !cfg.tiers[tier]) return { ok: false, reason: 'unknown_tier' };
  const u = await getUser(userId);
  u.tier = tier;
  await putUser(userId, u);
  return { ok: true, balance: await balance(userId) };
}

async function statsAll() {
  const rows = await db.allCreditRows();
  const byTier = {};
  for (const r of rows) { const t = r.tier || 'premium'; byTier[t] = (byTier[t] || 0) + 1; }
  return { totalUsers: rows.length, byTier };
}

module.exports = { check, charge, spend, refund, balance, addTopup, setTier, getConfig, saveConfig, statsAll,
  clampAiRequest, actionCost: (a, u = 1) => actionCost(getConfig(), a, u) };
