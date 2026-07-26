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

async function charge(userId, action, units = 1) {
  const pre = await check(userId, action, units);
  if (!pre.ok) return pre;
  const u = await getUser(userId);
  const cfg = getConfig();
  const cost = pre.cost;
  const allow = dailyAllowance(cfg, u.tier);
  const dailyRemaining = Math.max(0, allow - u.dailyUsed);
  const fromDaily = Math.min(dailyRemaining, cost);
  const fromTopup = cost - fromDaily;
  u.dailyUsed += fromDaily;
  u.topup = Math.max(0, u.topup - fromTopup);
  u.spentToday = (u.spentToday || 0) + cost;
  await putUser(userId, u);
  return { ok: true, charged: cost, fromDaily, fromTopup, balance: await balance(userId) };
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

module.exports = { check, charge, balance, addTopup, setTier, getConfig, saveConfig, statsAll,
  actionCost: (a, u = 1) => actionCost(getConfig(), a, u) };
