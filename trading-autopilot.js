/**
 * Paper trading autopilot helpers — long/short normalize, dead-setup kill,
 * default exit arms (breakeven + trail), and settings bootstrap.
 * Money mode: paper/testnet only (no mainnet wiring here).
 */
'use strict';

const scannerPrecision = require('./scanner-precision');

/** @returns {'long'|'short'|null} */
function normalizeDirection(dir) {
  if (dir == null) return null;
  const d = String(dir).trim().toLowerCase();
  if (d === 'long' || d === 'buy' || d === 'l' || d === 'bull') return 'long';
  if (d === 'short' || d === 'sell' || d === 's' || d === 'bear') return 'short';
  return null;
}

/**
 * Block (or shrink) setups with proven negative expectancy.
 * Advisors / trusted TG / manual skip the hard block.
 */
function deadSetupGate(expectancyStore, signal) {
  if (!signal?.setupType || signal.manual || signal.isAdvisorTrade || signal.trustedCaller) {
    return { block: false, mult: 1, detail: 'exempt' };
  }
  const expMult = scannerPrecision.expectancyMultiplier(
    expectancyStore,
    signal.setupType,
    signal.coin
  );
  if (expMult.mult === 0) {
    return { block: true, mult: 0, detail: expMult.detail };
  }
  return { block: false, mult: expMult.mult, detail: expMult.detail };
}

/** Default exit arms for full auto paper trades */
function armAutopilotExits(trade, settings = {}) {
  const isScalp = !!(trade.isScalp || trade.tradeMode === 'scalp');
  if (!trade.autoBreakevenPct || trade.autoBreakevenPct <= 0) {
    trade.autoBreakevenPct = Number(settings.autoBreakevenPct) > 0
      ? Number(settings.autoBreakevenPct)
      : (isScalp ? 1.5 : 2.5);
  }
  const hasLevels = Array.isArray(trade.trailingLevels) && trade.trailingLevels.length > 0;
  if (!trade.trailingPct && !hasLevels) {
    trade.trailingPct = Number(settings.trailingPct) > 0
      ? Number(settings.trailingPct)
      : (isScalp ? 1.2 : 2.5);
  }
  trade._high = trade._high || trade.entry;
  trade._low = trade._low || trade.entry;
  return trade;
}

/**
 * Ensure paper autopilot toggles are on when undefined / when forceRefresh.
 * Does not enable live mainnet.
 */
function ensureAutopilotSettings(settings, { force = false } = {}) {
  const s = { ...(settings || {}) };
  const set = (key, val) => {
    if (force || s[key] === undefined || s[key] === null) s[key] = val;
  };
  set('tradingAutopilot', true);
  set('autoPaperTrade', true);
  set('independentScanner', true);
  set('scalpTrading', true);
  set('precisionScanner', true);
  set('dailyTradeEnabled', true);
  set('autoBreakevenPct', 2.5);
  set('trailingPct', 2.5);
  set('paperMonitorSeconds', 60);
  set('maxTgAutoTrades', 5);
  // Paper-only money mode — never flip this to mainnet here
  if (s.liveMainnetTrading === undefined) s.liveMainnetTrading = false;
  return s;
}

/**
 * Persist high-water trailing stop onto stopLoss (price-based %).
 * Mutates trade; caller should save when _dirty.
 */
function applyPctTrailing(trade, currentPrice) {
  if (!trade?.trailingPct || !(currentPrice > 0) || !(trade.entry > 0)) return false;
  const dir = normalizeDirection(trade.direction);
  if (!dir) return false;
  let changed = false;
  if (dir === 'long') {
    trade._high = Math.max(trade._high || trade.entry, currentPrice);
    const trailSL = trade._high * (1 - trade.trailingPct / 100);
    if (!trade.stopLoss || trailSL > trade.stopLoss) {
      trade.stopLoss = +trailSL.toFixed(8);
      changed = true;
    }
  } else {
    trade._low = Math.min(trade._low || trade.entry, currentPrice);
    const trailSL = trade._low * (1 + trade.trailingPct / 100);
    if (!trade.stopLoss || trailSL < trade.stopLoss) {
      trade.stopLoss = +trailSL.toFixed(8);
      changed = true;
    }
  }
  if (changed) trade._dirty = true;
  return changed;
}

module.exports = {
  normalizeDirection,
  deadSetupGate,
  armAutopilotExits,
  ensureAutopilotSettings,
  applyPctTrailing
};
