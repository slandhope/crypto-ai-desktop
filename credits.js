// ═══════════════════════════════════════════════════════════════════
// 🎟️  CREDITS ENGINE — per-user daily credits + buyable top-ups.
// Everything is driven by credits-config.json (editable live from the
// dev panel). Balances persist to asuka-data/user-credits.json keyed by
// userId. Daily allowance refreshes each day; top-ups stack and persist.
//
//   const credits = require('./credits');
//   credits.check(userId, 'chat')          → { ok, balance, cost, remaining } | { ok:false, reason }
//   credits.charge(userId, 'voice_minute') → deducts, returns new state
//   credits.balance(userId)                → { daily, topup, total, tier, ... }
//   credits.addTopup(userId, 5000)         → after a purchase
//   credits.setTier(userId, 'super')       → after a subscription change
//   credits.getConfig() / credits.saveConfig(obj)  → for the dev panel
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'asuka-data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CREDITS_FILE = path.join(DATA_DIR, 'user-credits.json');
const CONFIG_FILE  = path.join(__dirname, 'credits-config.json');

function loadJSON(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function saveJSON(f, o) { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch (e) {} }

function getConfig() { return loadJSON(CONFIG_FILE, {}); }
function saveConfig(cfg) { saveJSON(CONFIG_FILE, cfg); return getConfig(); }

// today's date string in the config's timezone (UTC default)
function todayKey() {
  const cfg = getConfig();
  const tz = cfg.resetTimezone || 'UTC';
  const now = new Date();
  if (tz === 'UTC') return now.toISOString().slice(0, 10);        // YYYY-MM-DD UTC
  // local-ish: shift by offset if a named tz is ever added later; default UTC
  return now.toISOString().slice(0, 10);
}

function allUsers() { return loadJSON(CREDITS_FILE, {}); }
function saveUsers(u) { saveJSON(CREDITS_FILE, u); }

// get a user record, applying daily refresh if it's a new day
function getUser(userId) {
  const users = allUsers();
  const cfg = getConfig();
  let u = users[userId];
  if (!u) {
    u = { tier: 'premium', dailyUsed: 0, topup: 0, day: todayKey(), spentToday: 0 };
  }
  // daily refresh
  if (u.day !== todayKey()) {
    u.day = todayKey();
    u.dailyUsed = 0;
    u.spentToday = 0;
  }
  users[userId] = u;
  saveUsers(users);
  return { u, cfg, users };
}

function tierCfg(cfg, tier) {
  return (cfg.tiers && cfg.tiers[tier]) || { label: tier, dailyCredits: 0, priceMonthly: 0 };
}

function dailyAllowance(cfg, tier) {
  const mult = (cfg.promo && cfg.promo.dailyMultiplier) || 1;
  return Math.round(tierCfg(cfg, tier).dailyCredits * mult);
}

// full balance snapshot for a user
function balance(userId) {
  const { u, cfg } = getUser(userId);
  const allow = dailyAllowance(cfg, u.tier);
  const dailyRemaining = Math.max(0, allow - u.dailyUsed);
  return {
    tier: u.tier,
    tierLabel: tierCfg(cfg, u.tier).label,
    dailyAllowance: allow,
    dailyUsed: u.dailyUsed,
    dailyRemaining,
    topup: u.topup,
    total: dailyRemaining + u.topup,
    spentToday: u.spentToday || 0,
    resetsIn: 'daily at ' + (cfg.resetTimezone || 'UTC') + ' midnight',
  };
}

function actionCost(cfg, action, units = 1) {
  const per = (cfg.actionCosts && cfg.actionCosts[action]);
  if (per == null) return null;   // unknown action
  return Math.ceil(per * units);
}

// check WITHOUT charging — for pre-flight ("can they afford this?")
function check(userId, action, units = 1) {
  const { u, cfg } = getUser(userId);
  const cost = actionCost(cfg, action, units);
  if (cost == null) return { ok: false, reason: 'unknown_action', action };
  const bal = balance(userId);
  // fair-use hard ceiling: total spend today
  const ceiling = (cfg.fairUseHardCeiling && cfg.fairUseHardCeiling[u.tier]) || Infinity;
  if ((u.spentToday || 0) + cost > ceiling) {
    return { ok: false, reason: 'fair_use_ceiling', cost, ceiling };
  }
  if (bal.total < cost) {
    return { ok: false, reason: 'insufficient_credits', cost, have: bal.total,
      message: `That needs ${cost} credits — you have ${bal.total}. Your daily credits refresh at midnight, or top up for more.` };
  }
  return { ok: true, cost, willLeave: bal.total - cost, balance: bal };
}

// charge for an action — deducts daily first, then topup
function charge(userId, action, units = 1) {
  const pre = check(userId, action, units);
  if (!pre.ok) return pre;
  const { u, cfg, users } = getUser(userId);
  const cost = pre.cost;
  const allow = dailyAllowance(cfg, u.tier);
  const dailyRemaining = Math.max(0, allow - u.dailyUsed);

  let fromDaily = Math.min(dailyRemaining, cost);
  let fromTopup = cost - fromDaily;
  u.dailyUsed += fromDaily;
  u.topup = Math.max(0, u.topup - fromTopup);
  u.spentToday = (u.spentToday || 0) + cost;

  users[userId] = u;
  saveUsers(users);
  return { ok: true, charged: cost, fromDaily, fromTopup, balance: balance(userId) };
}

function addTopup(userId, credits) {
  const { u, users } = getUser(userId);
  u.topup = (u.topup || 0) + Math.max(0, Math.round(credits));
  users[userId] = u; saveUsers(users);
  return balance(userId);
}

function setTier(userId, tier) {
  const { u, cfg, users } = getUser(userId);
  if (!cfg.tiers || !cfg.tiers[tier]) return { ok: false, reason: 'unknown_tier' };
  u.tier = tier;
  users[userId] = u; saveUsers(users);
  return { ok: true, balance: balance(userId) };
}

// dev-panel helpers
function statsAll() {
  const users = allUsers();
  const ids = Object.keys(users);
  const byTier = {};
  for (const id of ids) { const t = users[id].tier || 'premium'; byTier[t] = (byTier[t] || 0) + 1; }
  return { totalUsers: ids.length, byTier };
}

module.exports = {
  check, charge, balance, addTopup, setTier,
  getConfig, saveConfig, statsAll,
  actionCost: (a, u = 1) => actionCost(getConfig(), a, u),
};
