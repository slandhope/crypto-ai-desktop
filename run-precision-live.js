/**
 * One-shot live precision scan — Binance public data, paper only, no live orders.
 * Optional Claude veto if ANTHROPIC_API_KEY is set.
 *
 *   node run-precision-live.js
 *   COINS=BTC,ETH,SOL SIZE=100 node run-precision-live.js
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runPrecisionScan, runPrecisionScalpForCoin } = require('./scanner-precision-run');
const scannerPrecision = require('./scanner-precision');

const COINS = (process.env.COINS || 'BTC,ETH,SOL').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const SIZE = Number(process.env.SIZE || 100);
const LEVERAGE = Number(process.env.LEVERAGE || 5);
const OUT_FILE = path.join(__dirname, 'asuka-data', 'precision-live-run.json');

function fetchT(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(t));
}

async function getCandles(coin, interval = '1h', limit = 100) {
  const res = await fetchT(`https://fapi.binance.com/fapi/v1/klines?symbol=${coin}USDT&interval=${interval}&limit=${limit}`);
  const data = await res.json();
  if (!Array.isArray(data)) return null;
  return data.map(k => ({
    open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
  }));
}

function rsi(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) g += d; else l -= d;
  }
  const rs = l === 0 ? 100 : g / l;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

function sma(candles, n) {
  if (!candles || candles.length < n) return null;
  return candles.slice(-n).reduce((a, c) => a + c.close, 0) / n;
}

function taText(c1h) {
  if (!c1h || c1h.length < 30) return '';
  const last = c1h[c1h.length - 1].close;
  const r = rsi(c1h, 14);
  const s20 = sma(c1h, 20);
  const s50 = sma(c1h, 50);
  const parts = [];
  let bull = 0, bear = 0;
  if (r != null) {
    let sig = 'Neutral zone';
    if (r < 30) { sig = '📈 Oversold — long bias'; bull++; }
    else if (r < 40) { sig = '📈 Oversold — long bias'; bull++; }
    else if (r > 70) { sig = '📉 Overbought — short bias'; bear++; }
    else if (r > 60) { sig = '📉 Overbought — short bias'; bear++; }
    parts.push(`RSI(14) 1h: ${r} ${sig}`);
  }
  if (s20 && s50) {
    if (s20 > s50 && last > s20) { parts.push('MA: Golden Cross ✅ — strong bullish trend'); bull += 2; }
    else if (s20 < s50 && last < s20) { parts.push('MA: Death Cross ❌ — strong bearish trend'); bear += 2; }
    else if (last > (s50 || s20)) { parts.push('MA: Above 200MA (bullish)'); bull++; }
    else { parts.push('MA: Below 200MA (bearish)'); bear++; }
  }
  const slice = c1h.slice(-20);
  const mid = slice.reduce((a, c) => a + c.close, 0) / 20;
  const std = Math.sqrt(slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / 20) || 0;
  const upper = mid + 2 * std, lower = mid - 2 * std;
  if (last <= lower * 1.002) { parts.push('BB: Price at LOWER band — oversold bounce likely'); bull++; }
  else if (last >= upper * 0.998) { parts.push('BB: Price at UPPER band — overbought pullback likely'); bear++; }
  const lows = c1h.slice(-40).map(c => c.low);
  const highs = c1h.slice(-40).map(c => c.high);
  const sup = Math.min(...lows), res = Math.max(...highs);
  const distS = ((last - sup) / last) * 100, distR = ((res - last) / last) * 100;
  if (distS < 0.5) { parts.push('S/R: Price at SUPPORT — good long entry'); bull++; }
  else if (distR < 0.5) { parts.push('S/R: Price at RESISTANCE — good short entry'); bear++; }
  if (bull > bear + 1) parts.push('Overall: ✅ TA BULLISH (1h)');
  else if (bear > bull + 1) parts.push('Overall: ❌ TA BEARISH (1h)');
  else parts.push('Overall: ⚖️ TA MIXED — no clear direction');
  return parts.join('\n');
}

async function detectMarketRegime() {
  const c = await getCandles('BTC', '1d', 40);
  if (!c || c.length < 30) return { regime: 'unknown', bias: 'neutral', summary: 'Regime unknown' };
  const close = c[c.length - 1].close;
  const sma20 = c.slice(-20).reduce((a, x) => a + x.close, 0) / 20;
  const sma7 = c.slice(-7).reduce((a, x) => a + x.close, 0) / 7;
  const chg = ((close - c[c.length - 30].close) / c[c.length - 30].close) * 100;
  let regime = 'sideways', bias = 'neutral';
  if (close > sma20 && sma7 > sma20 && chg > 5) { regime = 'bull'; bias = 'long'; }
  else if (close < sma20 && sma7 < sma20 && chg < -5) { regime = 'bear'; bias = 'short'; }
  return { regime, bias, strength: 'moderate', summary: `Market Regime: ${regime.toUpperCase()} | Bias: ${bias}` };
}

function getTimeSignal() {
  const hour = new Date().getUTCHours();
  const day = new Date().getUTCDay();
  if (day === 0 || day === 6) return '📅 Weekend — lower volume';
  if (hour >= 13 && hour <= 17) return '🔥 NY session — highest volume, best time to trade';
  if (hour >= 8 && hour <= 12) return '📈 London session — good volume';
  return `Market session: UTC ${hour}:00`;
}

async function jsonFetch(url) {
  const res = await fetchT(url);
  return res.json();
}

function makeState() {
  return {
    settings: {
      precisionScanner: true,
      independentScanner: true,
      autoPaperTrade: true,
      scalpTrading: true,
      mtfMode: 'hard',
      regimeMode: 'hard',
      confluenceMinTier: 'STRONG',
      scalpConfluenceMinTier: 'WATCH',
      paperTradeThreshold: 20,
      autoThreshold: false,
      mirofishMode: 'off',
      paperTradeSize: SIZE,
      paperLeverage: LEVERAGE,
      scalpSize: SIZE,
      scalpLeverage: LEVERAGE,
      scalpThreshold: 45,
      maxScalpTrades: 3,
      scalpDuration: 30,
      tradingCoins: COINS
    },
    paper: { balance: 10000, trades: [], stats: { wins: 0, losses: 0, totalPnl: 0 } },
    shadows: [],
    opened: []
  };
}

function deps(state, anthropic, CLAUDE_MODEL) {
  return {
    loadSettings: () => state.settings,
    loadDailySignals: () => ({ signals: {} }),
    loadExpectancy: () => ({}),
    saveExpectancy: () => {},
    detectMarketRegime,
    getNewsSentiment: async () => null,
    detectRSIDivergence: async () => null,
    getTelegramGroupSentiment: async () => null,
    getWhaleSignalForTrade: () => null,
    getCryptoPrice: async (q) => {
      const coin = String(q || '').toUpperCase().replace(/[^A-Z]/g, '') || 'BTC';
      const d = await jsonFetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${coin}USDT`);
      return `${coin} is at $${parseFloat(d.price).toLocaleString()}`;
    },
    getFundingRate: async (coin) => {
      const d = await jsonFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}USDT`);
      const rate = (parseFloat(d.lastFundingRate) * 100).toFixed(4);
      return `${coin} funding rate: ${rate}%`;
    },
    getFearGreed: async () => {
      try {
        const d = await jsonFetch('https://api.alternative.me/fng/?limit=1');
        return `Fear & Greed index: ${d.data[0].value} — ${d.data[0].value_classification}`;
      } catch (e) { return 'Fear & Greed: 50'; }
    },
    getBTCDominanceTrend: async () => null,
    getCryptoNews: async () => null,
    getOpenInterest: async (coin) => {
      try {
        const d = await jsonFetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${coin}USDT`);
        return `OI ${d.openInterest}`;
      } catch (e) { return null; }
    },
    getLongShortRatio: async (coin) => {
      try {
        const d = await jsonFetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin}USDT&period=1h&limit=1`);
        const row = Array.isArray(d) ? d[0] : d;
        return `L/S ${row?.longShortRatio || '?'}`;
      } catch (e) { return null; }
    },
    getLiquidationZones: async () => null,
    getVolumeAnalysis: async (coin) => {
      const c = await getCandles(coin, '1h', 30);
      if (!c) return null;
      const last = c[c.length - 1].volume;
      const avg = c.slice(-20).reduce((a, x) => a + x.volume, 0) / 20;
      if (last > avg * 1.8) return 'Volume SPIKE — above average';
      if (last > avg * 1.1) return 'High volume — above average';
      if (last < avg * 0.6) return 'Low volume thin tape';
      return 'Average volume';
    },
    getTechnicalAnalysis: async (coin) => {
      const c = await getCandles(coin, '1h', 100);
      return taText(c);
    },
    getOrderBook: async (coin) => {
      try {
        const d = await jsonFetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${coin}USDT&limit=20`);
        const bid = d.bids.reduce((s, b) => s + parseFloat(b[1]), 0);
        const ask = d.asks.reduce((s, a) => s + parseFloat(a[1]), 0);
        const ratio = (bid / ask).toFixed(2);
        let signal = '⚖️ Balanced order book';
        if (+ratio > 1.5) signal = 'Strong buy pressure';
        else if (+ratio < 0.7) signal = 'Strong sell pressure';
        return `${coin} Order Book: Bid/Ask ratio ${ratio} — ${signal}`;
      } catch (e) { return null; }
    },
    getCorrelation: async () => null,
    getTimeSignal,
    getAdvancedFlow: async () => null,
    getBTCLeadSignal: async () => ({ block: null, summary: 'BTC lead ok' }),
    getFundingRateExtreme: async (coin) => {
      try {
        const d = await jsonFetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}USDT`);
        const rate = parseFloat(d.lastFundingRate) * 100;
        return { rate, extreme: Math.abs(rate) > 0.08 };
      } catch (e) { return { rate: 0, extreme: false }; }
    },
    getMultiTimeframeSignal: async (coin, dir) => {
      const [c1, c4, cd] = await Promise.all([
        getCandles(coin, '1h', 60), getCandles(coin, '4h', 60), getCandles(coin, '1d', 60)
      ]);
      return scannerPrecision.analyzeMultiTimeframe(c1, c4, cd, dir);
    },
    getCandles,
    getSpreadPct: async () => 0.02,
    calculateSmartTrade: async (coin, direction, confidence, fg, funding, entry) => ({
      target: direction === 'long' ? entry * 1.02 : entry * 0.98,
      stopLoss: direction === 'long' ? entry * 0.99 : entry * 1.01
    }),
    checkUserRules: async () => ({ violated: false }),
    getReentryPenalty: () => 0,
    loadPaperTrades: () => state.paper,
    closePaperTrade: async () => {},
    openPaperTrade: async (sig) => {
      const trade = {
        ...sig,
        id: `live_${Date.now()}`,
        status: 'open',
        size: sig.size || SIZE,
        leverage: sig.leverage || LEVERAGE,
        openTime: Date.now(),
        paperOnly: true,
        isScalp: !!sig.isScalp,
        scalpExpiry: sig.scalpExpiry || null
      };
      state.paper.trades.push(trade);
      state.opened.push(trade);
      console.log(`📝 PAPER ${trade.direction?.toUpperCase()} ${trade.coin} $${trade.entry} size=$${trade.size} ${trade.leverage}x ${trade.isScalp ? 'SCALP' : 'MAIN'}`);
      return trade;
    },
    runScalpScan: async () => {},
    logShadowTrade: (coin, direction, entry, target, stopLoss, reason, confidence, meta) => {
      state.shadows.push({ coin, direction, entry, reason, confidence, blockedBy: meta?.blockedBy });
      console.log(`👻 ${coin} ${direction || '—'} blocked: ${reason}`);
    },
    saveTradeReplay: () => {},
    sendIntelEvent: () => {},
    asukaReact: () => {},
    anthropic,
    CLAUDE_MODEL,
    setCachedFearGreed: (n) => { global._cachedFearGreed = n; }
  };
}

async function markToMarket(trade) {
  const d = await jsonFetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${trade.coin}USDT`);
  const px = parseFloat(d.price);
  const lev = trade.leverage || 1;
  const size = trade.size || SIZE;
  const diff = trade.direction === 'long' ? px - trade.entry : trade.entry - px;
  const pnl = size * (diff / trade.entry) * lev;
  return { px, pnl: +pnl.toFixed(2), pnlPct: +(pnl / size * 100).toFixed(2) };
}

async function main() {
  fs.mkdirSync(path.join(__dirname, 'asuka-data'), { recursive: true });
  let anthropic = null;
  const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  if (process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('🧠 AI veto: ON (Sonnet confirm/veto)');
  } else {
    console.log('🧠 AI veto: OFF (no ANTHROPIC_API_KEY — math + gates only)');
  }

  console.log(`\n▶ Precision LIVE paper scan  coins=${COINS.join(',')}  size=$${SIZE}  lev=${LEVERAGE}x\n`);
  const state = makeState();
  const d = deps(state, anthropic, CLAUDE_MODEL);

  const results = [];
  for (const coin of COINS) {
    console.log(`\n—— MAIN ${coin} ——`);
    const main = await runPrecisionScan(coin, d);
    results.push({ coin, tier: 'main', result: main || 'void' });
    console.log(`—— SCALP ${coin} ——`);
    const scalp = await runPrecisionScalpForCoin(coin, d, {});
    results.push({ coin, tier: 'scalp', result: scalp || 'void' });
  }

  const mtm = [];
  for (const t of state.opened) {
    try {
      const m = await markToMarket(t);
      mtm.push({ coin: t.coin, direction: t.direction, isScalp: !!t.isScalp, entry: t.entry, ...m, size: t.size, leverage: t.leverage });
    } catch (e) {
      mtm.push({ coin: t.coin, error: e.message });
    }
  }
  const sumPnl = mtm.reduce((a, x) => a + (x.pnl || 0), 0);

  const out = {
    at: new Date().toISOString(),
    coins: COINS, size: SIZE, leverage: LEVERAGE,
    aiVeto: !!anthropic,
    results, opened: state.opened, shadows: state.shadows, markToMarket: mtm,
    unrealizedPnlOnStake: +sumPnl.toFixed(2)
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log('\n========== LIVE PRECISION RESULT ==========');
  for (const r of results) console.log(`  ${r.tier.padEnd(5)} ${r.coin}: ${r.result}`);
  console.log(`  paper opens: ${state.opened.length}  shadows: ${state.shadows.length}`);
  if (mtm.length) {
    for (const m of mtm) {
      console.log(`  MTM ${m.coin} ${m.direction} entry=${m.entry} now=${m.px} pnl=$${m.pnl} (${m.pnlPct}% of $${m.size})`);
    }
    console.log(`  Unrealized P&L on $${SIZE} tickets: $${sumPnl.toFixed(2)}`);
  } else {
    console.log('  No paper trades opened — gates blocked everything this pass.');
  }
  console.log(`  wrote ${OUT_FILE}`);
  console.log('  Paper only. Just-opened P&L is noise until TP/SL.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
