// ═══════════════════════════════════════════════════════════════════
// 🧠 ASUKA SCANNER SERVER — standalone, extracted from main.js
// The 3 scanner tiers (Daily RSI · Main 30-min · Scalp 2-min) + paper
// engine, running headless. No Electron. Serves signals over HTTP.
//   run:   node scanner-server.js
//   env:   ANTHROPIC_API_KEY required · GROQ_API_KEY optional
//          TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID optional (alerts)
// ═══════════════════════════════════════════════════════════════════
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const express = require('express');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,   // fallback; real value can come from the vault
  defaultHeaders: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
});
const { getSecret } = require('./secrets');          // 🔐 key vault
const https = require('https');                       // for voice proxy
const credits = require('./credits');                // 🎟️ credit engine
const { authRequired, authOptional, userIdOf } = require('./auth');  // 🔑 real login
// pull the real Claude key from the vault at boot (Secrets Manager → .env fallback)
(async () => { try { const k = await getSecret('ANTHROPIC_API_KEY'); if (k) anthropic.apiKey = k; } catch (e) {} })();

// ── storage: local data dir (server has no Electron userData) ──
const DATA_DIR = path.join(__dirname, 'asuka-data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const MEMORY_FILE        = path.join(DATA_DIR, 'memory.json');
const SETTINGS_FILE      = path.join(DATA_DIR, 'settings.json');
const DAILY_SIGNALS_FILE = path.join(DATA_DIR, 'daily-signals.json');
const PAPER_FILE         = path.join(DATA_DIR, 'paper-trades.json');

// ── desktop-only touchpoints → safe stubs ──
const mainWindow = null;
const asukaReact = () => {};
const recordWork = () => {};
const logDevError = (e) => { try { console.error('[dev]', e?.message || e); } catch (_) {} };
const addToDiary = () => {};
const saveTradeReplay = (r) => { try {
  const f = path.join(DATA_DIR, 'trade-replays.json');
  const d = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { replays: [] };
  d.replays.push({ ...r, at: Date.now() }); if (d.replays.length > 200) d.replays = d.replays.slice(-200);
  fs.writeFileSync(f, JSON.stringify(d));
} catch (e) {} };

// ── scanner state (was module-level in main.js) ──
let independentScanInterval = null;
let scalpScanInterval = null;
let _globalPauseMain = false;
let _globalPauseScalp = false;
// ── dev overrides: reads the SAME files your dev-server.js panel writes ──
// dev-state.json → pauseMain, pauseScalp, intervalOverride, pauseAll
// master-coins.json → disabled coins per tier
const DEV_STATE_FILE   = path.join(DATA_DIR, 'dev-state.json');
const MASTER_COINS_FILE = path.join(DATA_DIR, 'master-coins.json');
function getDevOverrides() {
  let state = {}, master = {};
  try { state = JSON.parse(fs.readFileSync(DEV_STATE_FILE, 'utf8')); } catch (e) {}
  try { master = JSON.parse(fs.readFileSync(MASTER_COINS_FILE, 'utf8')); } catch (e) {}
  const disabled = master.disabled || { main: [], scalp: [], day: [] };
  return {
    pauseMain: !!(state.pauseMain || state.pauseAll),
    pauseScalp: !!(state.pauseScalp || state.pauseAll),
    intervalOverride: state.intervalOverride || null,
    coinOverride: state.coinOverride || 'all',
    disabledMain: disabled.main || [],
    disabledScalp: disabled.scalp || [],
    disabledDay: disabled.day || [],
  };
}
function setDevOverrides() {}  // panel owns writes; scanner only reads

// Telegram: real if env set, silent otherwise
async function sendTelegramNotification(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch (e) {}
}

// ── loadJSON ──
function loadJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  return def;
}

// ── saveJSON ──
function saveJSON(file, data) {
  // Atomic write: temp file + rename — a crash mid-save can NEVER corrupt her brain
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch(e) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e2) {}
  }
}

// ── loadSettings ──
function loadSettings() {
  return loadJSON(SETTINGS_FILE, {
    wallets: [], trackedWallets: [], influencerWallets: [],
    watchlist: [], personality: 'chill', characterName: 'Asuka',
    suppressedAlerts: [], tradeRules: [], aiMode: 'balanced',
    pumpFunChains: ['solana'], pumpFunEnabled: true,
    coingeckoKey: process.env.COINGECKO_API_KEY || null,
    moralisKey: process.env.MORALIS_API_KEY || null,
    youtubeKey: process.env.YOUTUBE_API_KEY || null,
    etherscanKey: process.env.ETHERSCAN_API_KEY || null,
    elevenLabsKey: null, elevenLabsVoiceId: null,
    ttsProvider: 'openai',
  });
}

// ── saveSettings ──
function saveSettings(s) { saveJSON(SETTINGS_FILE, s); }

// ── tradingEnabled ── (carried over from main.js; was undefined after extraction)
// Trading/scanning runs unless the app is explicitly in companion-only mode.
function tradingEnabled() {
  try {
    const s = loadSettings();
    if (s.companionMode === true) return false;      // explicit companion-only
    if (s.tradingEnabled === false) return false;    // explicit off
    return true;                                     // default: trading on
  } catch (e) { return true; }
}

// ── loadMemory ──
function loadMemory() {
  return loadJSON(MEMORY_FILE, {
    name: null, riskLevel: null, favoriteCoins: [], tradingStyle: null,
    userRules: [], personality: 'chill', wakeName: 'asuka',
    alarmTime: null, alarmFired: false, voiceSpeed: 1.0,
    tradeCount: 0, chartStartTime: null, lastTradeTime: null,
    sleepMode: false, focusMode: false, focusModeUntil: null,
    learningLevel: 'intermediate', sleepHour: null,
    waterReminderMinutes: null, lastWaterReminder: null,
    inTrade: false, dcaSchedule: [], lastSeen: Date.now(),
  });
}

// ── saveMemory ──
function saveMemory(m) { saveJSON(MEMORY_FILE, { ...m, lastSeen: Date.now() }); }

// ── COIN_MAP ──
const COIN_MAP = {
  'btc':'bitcoin','bitcoin':'bitcoin','eth':'ethereum','ethereum':'ethereum',
  'sol':'solana','solana':'solana','bnb':'binancecoin','xrp':'ripple',
  'doge':'dogecoin','pepe':'pepe','wif':'dogwifhat','bonk':'bonk',
  'avax':'avalanche-2','link':'chainlink','matic':'matic-network',
  'ada':'cardano','dot':'polkadot','shib':'shiba-inu','ltc':'litecoin',
  'uni':'uniswap','atom':'cosmos','near':'near','arb':'arbitrum',
  'op':'optimism','sui':'sui','apt':'aptos','inj':'injective-protocol',
};

// ── getCryptoPrice ──
async function getCryptoPrice(query) {
  const lower = query.toLowerCase();
  let coinId = null;
  for (const [k, v] of Object.entries(COIN_MAP)) {
    if (lower.includes(k)) { coinId = v; break; }
  }
  if (!coinId) return null;

  // Known price ranges for sanity checks
  const PRICE_RANGES = {
    'bitcoin': [10000, 200000],
    'ethereum': [500, 20000],
    'solana': [10, 1000],
    'binancecoin': [100, 5000],
    'avalanche-2': [5, 500],
    'ripple': [0.1, 50],
    'dogecoin': [0.05, 5],
    'pepe': [0.000001, 0.001],
    'chainlink': [5, 200],
  };

  async function validatePrice(price, coinId) {
    if (!price || price <= 0) return false;
    const range = PRICE_RANGES[coinId];
    if (range && (price < range[0] || price > range[1])) {
      console.log(`⚠️ Price validation failed for ${coinId}: $${price} outside range [$${range[0]}, $${range[1]}]`);
      return false;
    }
    return true;
  }

  // Try CoinGecko first
  try {
    const settings = loadSettings();
    const key = settings.coingeckoKey || process.env.COINGECKO_API_KEY || '';
    const headers = key ? { 'x-cg-demo-api-key': key } : {};
    const res = await fetchT(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`,
      { headers }
    );
    const data = await res.json();
    const coin = data[coinId];
    if (coin?.usd && await validatePrice(coin.usd, coinId)) {
      const price = coin.usd >= 1 ? coin.usd.toLocaleString() : coin.usd.toFixed(8);
      const change = coin.usd_24h_change?.toFixed(2);
      const dir = change > 0 ? 'up' : 'down';
      return `${coinId} is at $${price}, ${dir} ${Math.abs(change)}% in 24h ${change > 0 ? '📈' : '📉'}`;
    }
  } catch(e) {}

  // Fallback to Binance
  try {
    const binanceMap = {
      bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT',
      binancecoin: 'BNBUSDT', 'avalanche-2': 'AVAXUSDT', ripple: 'XRPUSDT',
      dogecoin: 'DOGEUSDT', chainlink: 'LINKUSDT', 'matic-network': 'MATICUSDT',
      cardano: 'ADAUSDT', arbitrum: 'ARBUSDT', pepe: 'PEPEUSDT',
      'shiba-inu': 'SHIBUSDT', litecoin: 'LTCUSDT', tron: 'TRXUSDT'
    };
    const symbol = binanceMap[coinId];
    if (symbol) {
      const res = await fetchT(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
      const data = await res.json();
      const price = parseFloat(data.lastPrice);
      if (await validatePrice(price, coinId)) {
        const change = parseFloat(data.priceChangePercent).toFixed(2);
        const formatted = price >= 1 ? price.toLocaleString() : price.toFixed(8);
        return `${coinId} is at $${formatted}, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% in 24h ${change > 0 ? '📈' : '📉'}`;
      }
    }
  } catch(e) {}

  return null;
}

// ── getCandles ──
async function getCandles(coin, interval = '1h', limit = 100) {
  const symbol = `${coin}USDT`;
  const res = await fetchT(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const data = await res.json();
  if (!Array.isArray(data)) return null;
  return data.map(k => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5])
  }));
}

// ── getTechnicalAnalysis ──
async function getTechnicalAnalysis(coin = 'BTC') {
  try {
    const settings = loadSettings();
    const taMode = settings.taMode || 'auto';
    const enabledIndicators = settings.enabledIndicators || {
      rsi: true, ma: true, macd: true, bb: true, sr: true
    };

    // Fetch candles on multiple timeframes
    const [candles1h, candles4h, candles15m, candles1hIchi] = await Promise.all([
      getCandles(coin, '1h', 100).catch(() => null),
      getCandles(coin, '4h', 50).catch(() => null),
      getCandles(coin, '15m', 50).catch(() => null),
      getCandles(coin, '1h', 120).catch(() => null)
    ]);

    if (!candles1h) return null;

    const currentPrice = candles1h[candles1h.length - 1].close;
    const results = [];
    const signals = { bullish: 0, bearish: 0, neutral: 0 };

    // RSI period from settings
    const rsiPeriod = settings.rsiPeriod || 14;

    // Get additional indicators in parallel
    const [vwapResult, pivotResult, fundingExtreme] = await Promise.all([
      getVWAP(coin).catch(() => null),
      getPivotPoints(coin).catch(() => null),
      getFundingRateExtreme(coin).catch(() => null)
    ]);

    // RSI (user-configurable period on 1h + 4h)
    if (enabledIndicators.rsi !== false) {
      const rsi1h = calcRSI(candles1h, rsiPeriod);
      const rsi4h = candles4h ? calcRSI(candles4h, rsiPeriod) : null;
      if (rsi1h !== null) {
        let rsiSignal = '';
        if (rsi1h < 25) { rsiSignal = '🔥 EXTREMELY OVERSOLD — strong long signal'; signals.bullish += 2; }
        else if (rsi1h < 35) { rsiSignal = '📈 Oversold — long bias'; signals.bullish++; }
        else if (rsi1h > 75) { rsiSignal = '🔥 EXTREMELY OVERBOUGHT — strong short signal'; signals.bearish += 2; }
        else if (rsi1h > 65) { rsiSignal = '📉 Overbought — short bias'; signals.bearish++; }
        else { rsiSignal = 'Neutral zone'; signals.neutral++; }
        results.push(`RSI(14) 1h: ${rsi1h} ${rsiSignal}${rsi4h ? ` | 4h: ${rsi4h}` : ''}`);
      }
    }

    // Moving Averages
    if (enabledIndicators.ma !== false) {
      const ma20 = calcSMA(candles1h, 20);
      const ma50 = calcSMA(candles1h, 50);
      const ma200 = candles1h.length >= 200 ? calcSMA(candles1h, 200) : calcEMA(candles1h, 50);
      const ema9 = calcEMA(candles1h, 9);

      const aboveMa20 = currentPrice > ma20;
      const aboveMa50 = currentPrice > ma50;
      const aboveMa200 = currentPrice > ma200;

      // Golden/Death cross
      const goldenCross = ma50 > ma200 && ma20 > ma50;
      const deathCross = ma50 < ma200 && ma20 < ma50;

      if (goldenCross) { results.push(`MA: Golden Cross ✅ — strong bullish trend`); signals.bullish += 2; }
      else if (deathCross) { results.push(`MA: Death Cross ❌ — strong bearish trend`); signals.bearish += 2; }
      else {
        const maTrend = aboveMa200 ? '📈 Above 200MA (bullish)' : '📉 Below 200MA (bearish)';
        results.push(`MA: EMA9=$${ema9.toFixed(2)} | SMA20=$${ma20.toFixed(2)} | SMA200=$${ma200.toFixed(2)} — ${maTrend}`);
        if (aboveMa200) signals.bullish++; else signals.bearish++;
      }
    }

    // MACD
    if (enabledIndicators.macd !== false) {
      const macd = calcMACD(candles1h);
      if (macd) {
        const macdSignal = macd.macdLine > 0 ? '📈 Bullish momentum' : '📉 Bearish momentum';
        results.push(`MACD: ${macd.macdLine.toFixed(4)} — ${macdSignal}`);
        if (macd.macdLine > 0) signals.bullish++; else signals.bearish++;
      }
    }

    // Bollinger Bands
    if (enabledIndicators.bb !== false) {
      const bb = calcBollingerBands(candles1h, 20, 2);
      if (bb) {
        const bbWidth = ((bb.upper - bb.lower) / bb.middle * 100).toFixed(2);
        let bbSignal = '';
        if (currentPrice <= bb.lower) { bbSignal = '🔥 Price at LOWER band — oversold bounce likely'; signals.bullish++; }
        else if (currentPrice >= bb.upper) { bbSignal = '🔥 Price at UPPER band — overbought pullback likely'; signals.bearish++; }
        else if (parseFloat(bbWidth) < 2) { bbSignal = '⚡ Band SQUEEZE — big move incoming!'; signals.neutral++; }
        else { bbSignal = `In middle band (width: ${bbWidth}%)`; }
        results.push(`BB: Upper=$${bb.upper.toFixed(2)} Lower=$${bb.lower.toFixed(2)} — ${bbSignal}`);
      }
    }

    // Support/Resistance
    if (enabledIndicators.sr !== false) {
      const sr = calcSupportResistance(candles1h);
      if (sr.nearestSupport && sr.nearestResistance) {
        let srSignal = '';
        if (parseFloat(sr.distToSupport) < 0.5) { srSignal = '🛡️ Price at SUPPORT — good long entry'; signals.bullish++; }
        else if (parseFloat(sr.distToResistance) < 0.5) { srSignal = '🚧 Price at RESISTANCE — good short entry'; signals.bearish++; }
        else { srSignal = `Support: ${sr.distToSupport}% below | Resistance: ${sr.distToResistance}% above`; }
        results.push(`S/R: Support=$${sr.nearestSupport.toFixed(2)} | Resistance=$${sr.nearestResistance.toFixed(2)} — ${srSignal}`);
      }
    }

    // ATR-based TP/SL suggestion
    if (enabledIndicators.atr !== false) {
      const atr = calcATR(candles1h, rsiPeriod);
      if (atr) {
        const atrPct = (atr / currentPrice * 100).toFixed(2);
        const atrTargets = calcATRTargets(candles1h, 'long', currentPrice, settings);
        let atrSignal = '';
        if (parseFloat(atrPct) > 3) atrSignal = '🌋 High volatility — use wider stops';
        else if (parseFloat(atrPct) < 0.5) atrSignal = '😴 Low volatility — squeeze incoming?';
        else atrSignal = 'Normal volatility';
        results.push(`ATR(${rsiPeriod}): $${atr.toFixed(2)} (${atrPct}% of price) — ${atrSignal} | Smart TP: +${atrTargets?.tpPct}% SL: -${atrTargets?.slPct}%`);
        if (parseFloat(atrPct) > 3) signals.neutral++; // high vol = neutral
        else signals.neutral++;
      }
    }

    // VWAP
    if (enabledIndicators.vwap !== false && vwapResult) {
      results.push(vwapResult);
      if (vwapResult.includes('above')) signals.bullish++;
      else signals.bearish++;
    }

    // Stochastic RSI
    if (enabledIndicators.stochRsi !== false) {
      const stoch = calcStochRSI(candles1h, rsiPeriod);
      if (stoch) {
        results.push(stoch.summary);
        if (stoch.k < 20) signals.bullish += 2;
        else if (stoch.k > 80) signals.bearish += 2;
        else if (stoch.k > stoch.d) signals.bullish++;
        else signals.bearish++;
      }
    }

    // EMA Cross
    if (enabledIndicators.emaCross !== false) {
      const fastP = settings.emaFastPeriod || 9;
      const slowP = settings.emaSlowPeriod || 21;
      const emaCross = detectEMACross(candles1h, fastP, slowP);
      if (emaCross) {
        results.push(emaCross.summary);
        if (emaCross.crossedUp) signals.bullish += 2;
        else if (emaCross.crossedDown) signals.bearish += 2;
        else if (emaCross.fastAbove) signals.bullish++;
        else signals.bearish++;
      }
    }

    // Funding Rate Extremes
    if (enabledIndicators.fundingExtreme !== false && fundingExtreme) {
      if (fundingExtreme.extreme) {
        results.push(fundingExtreme.summary);
        if (fundingExtreme.rate > 0.1) signals.bearish += 2; // longs squeezed
        else if (fundingExtreme.rate < -0.1) signals.bullish += 2; // shorts squeezed
      }
    }

    // Pivot Points
    if (enabledIndicators.pivots !== false && pivotResult) {
      results.push(pivotResult.summary);
      if (pivotResult.abovePivot) signals.bullish++;
      else signals.bearish++;
    }

    // Ichimoku Cloud
    if (enabledIndicators.ichimoku !== false && candles1hIchi) {
      const ichimokuSettings = {
        tenkan: settings.ichimokuTenkan || 9,
        kijun: settings.ichimokuKijun || 26,
        senkouB: settings.ichimokuSenkouB || 52,
        displacement: 26
      };
      const ichi = calcIchimoku(candles1hIchi, ichimokuSettings);
      if (ichi) {
        results.push(ichi.summary);
        // Add to signal count (weighted heavily - Ichimoku is very reliable)
        if (ichi.aboveCloud) { signals.bullish += 2; }
        else if (ichi.belowCloud) { signals.bearish += 2; }
        else { signals.neutral++; }
        if (ichi.tenkanAboveKijun) signals.bullish++;
        else signals.bearish++;
        if (ichi.futureCloudBullish) signals.bullish++;
        else signals.bearish++;
      }
    }

    // Overall TA signal
    const total = signals.bullish + signals.bearish + signals.neutral;
    const bullPct = total > 0 ? Math.round(signals.bullish / total * 100) : 50;
    const bearPct = total > 0 ? Math.round(signals.bearish / total * 100) : 50;

    let overall = '';
    if (signals.bullish > signals.bearish + 1) overall = `✅ TA BULLISH (${bullPct}% signals bullish)`;
    else if (signals.bearish > signals.bullish + 1) overall = `❌ TA BEARISH (${bearPct}% signals bearish)`;
    else overall = '⚖️ TA MIXED — no clear direction';

    return `${coin} Technical Analysis:\n${results.join('\n')}\nOverall: ${overall}`;
  } catch(e) {
    console.error('TA error:', e.message?.slice(0, 60));
    return null;
  }
}

// ── getFearGreed ──
async function getFearGreed() {
  try {
    const res  = await fetchT('https://api.alternative.me/fng/?limit=1');
    const data = await res.json();
    const val  = data.data[0].value;
    const label= data.data[0].value_classification;
    return `Fear & Greed index: ${val} — ${label}`;
  } catch(e) { return 'Could not fetch Fear & Greed right now.'; }
}

// ── getFundingRate ──
async function getFundingRate(coin = 'BTC') {
  try {
    const res  = await fetchT(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}USDT`);
    const data = await res.json();
    const rate = (parseFloat(data.lastFundingRate) * 100).toFixed(4);
    const extreme = Math.abs(parseFloat(rate)) > 0.05;
    return `${coin} funding rate: ${rate}%${extreme ? ' — EXTREME, be careful' : ''}`;
  } catch(e) { return `Could not fetch ${coin} funding rate.`; }
}

// ── getOpenInterest ──
async function getOpenInterest(coin = 'BTC') {
  try {
    const symbol = `${coin}USDT`;
    const [current, history] = await Promise.all([
      fetchT(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
      fetchT(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=2`)
    ]);
    const currentData = await current.json();
    const histData = await history.json();

    const currentOI = parseFloat(currentData.openInterest);
    const prevOI = histData?.length >= 2 ? parseFloat(histData[0].sumOpenInterest) : currentOI;
    const oiChange = ((currentOI - prevOI) / prevOI * 100).toFixed(2);
    const oiUsd = (currentOI * parseFloat(currentData.time ? 1 : 1)).toFixed(0);

    const trend = parseFloat(oiChange) > 1 ? 'RISING ⬆️ (new money entering)' 
      : parseFloat(oiChange) < -1 ? 'FALLING ⬇️ (positions closing)'
      : 'STABLE ➡️';

    return `${coin} Open Interest: ${parseFloat(currentOI).toLocaleString()} (${oiChange}% 1h) — ${trend}`;
  } catch(e) { return null; }
}

// ── getLongShortRatio ──
async function getLongShortRatio(coin = 'BTC') {
  try {
    const symbol = `${coin}USDT`;
    const res = await fetchT(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=1h&limit=1`);
    const data = await res.json();
    if (!data?.length) return null;

    const longPct = (parseFloat(data[0].longAccount) * 100).toFixed(1);
    const shortPct = (parseFloat(data[0].shortAccount) * 100).toFixed(1);
    const ratio = parseFloat(data[0].longShortRatio).toFixed(2);

    let signal = '';
    if (parseFloat(longPct) > 65) {
      signal = '⚠️ TOO MANY LONGS — squeeze risk, consider short';
    } else if (parseFloat(shortPct) > 60) {
      signal = '⚠️ TOO MANY SHORTS — squeeze risk, consider long';
    } else {
      signal = '✅ Balanced';
    }

    return `${coin} L/S Ratio: ${longPct}% Long / ${shortPct}% Short (${ratio}) — ${signal}`;
  } catch(e) { return null; }
}

// ── getLiquidationZones ──
async function getLiquidationZones(coin = 'BTC') {
  try {
    const symbol = `${coin}USDT`;
    // Get recent liquidations from Binance
    const res = await fetchT(`https://fapi.binance.com/fapi/v1/forceOrders?symbol=${symbol}&limit=10`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;

    const longs = data.filter(l => l.side === 'SELL'); // long liquidations
    const shorts = data.filter(l => l.side === 'BUY'); // short liquidations

    const longLiqTotal = longs.reduce((s, l) => s + parseFloat(l.origQty) * parseFloat(l.price), 0);
    const shortLiqTotal = shorts.reduce((s, l) => s + parseFloat(l.origQty) * parseFloat(l.price), 0);

    const avgLongLiqPrice = longs.length 
      ? (longs.reduce((s, l) => s + parseFloat(l.price), 0) / longs.length).toFixed(2)
      : null;
    const avgShortLiqPrice = shorts.length
      ? (shorts.reduce((s, l) => s + parseFloat(l.price), 0) / shorts.length).toFixed(2)
      : null;

    let result = `${coin} Recent Liquidations:`;
    if (avgLongLiqPrice) result += ` Long liq zone ~$${avgLongLiqPrice} ($${(longLiqTotal/1000).toFixed(0)}K)`;
    if (avgShortLiqPrice) result += ` | Short liq zone ~$${avgShortLiqPrice} ($${(shortLiqTotal/1000).toFixed(0)}K)`;

    return result;
  } catch(e) { return null; }
}

// ── getVolumeAnalysis ──
async function getVolumeAnalysis(coin = 'BTC') {
  try {
    const symbol = `${coin}USDT`;
    const res = await fetchT(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=6`);
    const data = await res.json();
    if (!data?.length) return null;

    const volumes = data.map(k => parseFloat(k[5]));
    const currentVol = volumes[volumes.length - 1];
    const avgVol = volumes.slice(0, -1).reduce((s, v) => s + v, 0) / (volumes.length - 1);
    const volRatio = (currentVol / avgVol).toFixed(1);

    let signal = '';
    if (parseFloat(volRatio) > 2) {
      signal = `🔥 VOLUME SPIKE ${volRatio}x avg — strong momentum`;
    } else if (parseFloat(volRatio) > 1.5) {
      signal = `📈 Volume elevated ${volRatio}x avg`;
    } else if (parseFloat(volRatio) < 0.5) {
      signal = `😴 Low volume ${volRatio}x avg — reduce position size 50%, use tight stops`;
    } else {
      signal = `Normal volume ${volRatio}x avg`;
    }

    return `${coin} Volume: ${signal}`;
  } catch(e) { return null; }
}

// ── getVWAP ──
async function getVWAP(coin) {
  try {
    // Use today's 1h candles for intraday VWAP
    const candles = await getCandles(coin, '1h', 24);
    if (!candles) return null;
    const vwap = calcVWAP(candles);
    const currentPrice = candles[candles.length-1].close;
    if (!vwap) return null;

    const pctFromVwap = ((currentPrice - vwap) / vwap * 100).toFixed(2);
    const aboveBelow = currentPrice > vwap ? 'ABOVE' : 'BELOW';
    const signal = currentPrice > vwap
      ? '📈 Price above VWAP — bullish intraday bias'
      : '📉 Price below VWAP — bearish intraday bias';

    return `VWAP: $${vwap.toFixed(2)} | Price ${aboveBelow} by ${Math.abs(pctFromVwap)}% — ${signal}`;
  } catch(e) { return null; }
}

// ── getPivotPoints ──
async function getPivotPoints(coin = 'BTC') {
  try {
    // Use previous day's daily candle for pivot points
    const candles = await getCandles(coin, '1d', 3);
    if (!candles || candles.length < 2) return null;

    const prev = candles[candles.length - 2]; // Yesterday's candle
    const H = prev.high;
    const L = prev.low;
    const C = prev.close;

    // Standard pivot points
    const PP = (H + L + C) / 3;
    const R1 = 2 * PP - L;
    const R2 = PP + (H - L);
    const R3 = H + 2 * (PP - L);
    const S1 = 2 * PP - H;
    const S2 = PP - (H - L);
    const S3 = L - 2 * (H - PP);

    const currentPrice = candles[candles.length - 1].close;

    // Find nearest levels
    const levels = [
      { name: 'R3', price: R3, type: 'resistance' },
      { name: 'R2', price: R2, type: 'resistance' },
      { name: 'R1', price: R1, type: 'resistance' },
      { name: 'PP', price: PP, type: 'pivot' },
      { name: 'S1', price: S1, type: 'support' },
      { name: 'S2', price: S2, type: 'support' },
      { name: 'S3', price: S3, type: 'support' },
    ].sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));

    const nearest = levels[0];
    const nearestPct = ((nearest.price - currentPrice) / currentPrice * 100).toFixed(2);

    // Are we above or below pivot?
    const abovePivot = currentPrice > PP;
    const signal = abovePivot
      ? `📈 Price above PP ($${PP.toFixed(2)}) — bullish bias | Nearest resistance: ${levels.find(l => l.price > currentPrice)?.name || 'R1'} $${levels.find(l => l.price > currentPrice)?.price?.toFixed(2)}`
      : `📉 Price below PP ($${PP.toFixed(2)}) — bearish bias | Nearest support: ${levels.find(l => l.price < currentPrice)?.name || 'S1'} $${levels.find(l => l.price < currentPrice)?.price?.toFixed(2)}`;

    return {
      PP: parseFloat(PP.toFixed(2)),
      R1: parseFloat(R1.toFixed(2)), R2: parseFloat(R2.toFixed(2)), R3: parseFloat(R3.toFixed(2)),
      S1: parseFloat(S1.toFixed(2)), S2: parseFloat(S2.toFixed(2)), S3: parseFloat(S3.toFixed(2)),
      abovePivot,
      nearestLevel: nearest.name,
      signal,
      summary: `Pivot Points: PP=$${PP.toFixed(2)} | ${signal}`
    };
  } catch(e) { return null; }
}

// ── getOrderBook ──
async function getOrderBook(coin = 'BTC') {
  try {
    const symbol = `${coin}USDT`;
    const res = await fetchT(`https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=20`);
    const data = await res.json();
    if (!data?.bids || !data?.asks) return null;

    const currentPrice = parseFloat(data.asks[0][0]);

    // Calculate buy/sell wall strength
    const bidVolume = data.bids.reduce((s, b) => s + parseFloat(b[1]), 0);
    const askVolume = data.asks.reduce((s, a) => s + parseFloat(a[1]), 0);
    const ratio = (bidVolume / askVolume).toFixed(2);

    // Find biggest walls
    const biggestBid = data.bids.reduce((m, b) => parseFloat(b[1]) > parseFloat(m[1]) ? b : m);
    const biggestAsk = data.asks.reduce((m, a) => parseFloat(a[1]) > parseFloat(m[1]) ? a : m);

    let signal = '';
    if (parseFloat(ratio) > 1.5) signal = '🟢 Strong buy pressure — bulls in control';
    else if (parseFloat(ratio) < 0.7) signal = '🔴 Strong sell pressure — bears in control';
    else signal = '⚖️ Balanced order book';

    const bigBuyWall = parseFloat(biggestBid[1]) > bidVolume * 0.2
      ? `Big buy wall at $${parseFloat(biggestBid[0]).toFixed(2)}` : null;
    const bigSellWall = parseFloat(biggestAsk[1]) > askVolume * 0.2
      ? `Big sell wall at $${parseFloat(biggestAsk[0]).toFixed(2)}` : null;

    let result = `${coin} Order Book: Bid/Ask ratio ${ratio} — ${signal}`;
    if (bigBuyWall) result += ` | ${bigBuyWall} ← price magnet`;
    if (bigSellWall) result += ` | ${bigSellWall} ← price resistance`;

    return result;
  } catch(e) { return null; }
}

// ── getCorrelation ──
async function getCorrelation(coin = 'ETH') {
  if (coin === 'BTC') return null; // BTC is the base
  try {
    const [btcCandles, coinCandles] = await Promise.all([
      getCandles('BTC', '1h', 24).catch(() => null),
      getCandles(coin, '1h', 24).catch(() => null)
    ]);
    if (!btcCandles || !coinCandles) return null;

    const btcChange = (btcCandles[btcCandles.length-1].close - btcCandles[0].close) / btcCandles[0].close * 100;
    const coinChange = (coinCandles[coinCandles.length-1].close - coinCandles[0].close) / coinCandles[0].close * 100;
    const lag = btcChange - coinChange;

    let signal = '';
    if (btcChange > 1 && coinChange < 0) signal = `⚡ BTC up ${btcChange.toFixed(1)}% but ${coin} lagging — catch-up pump likely`;
    else if (btcChange < -1 && coinChange > 0) signal = `⚠️ BTC down but ${coin} holding — ${coin} may dump soon`;
    else signal = `BTC 24h: ${btcChange.toFixed(1)}% | ${coin} 24h: ${coinChange.toFixed(1)}% | Lag: ${lag.toFixed(1)}%`;

    return `Correlation: ${signal}`;
  } catch(e) { return null; }
}

// ── getFundingRateExtreme ──
async function getFundingRateExtreme(coin = 'BTC') {
  try {
    const symbol = `${coin}USDT`;
    const res = await fetchT(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=8`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;

    const rates = data.map(d => parseFloat(d.fundingRate) * 100);
    const latest = rates[rates.length - 1];
    const avg = rates.reduce((s, v) => s + v, 0) / rates.length;

    let signal = '';
    let extreme = false;
    if (latest > 0.1) {
      signal = `🚨 EXTREME POSITIVE funding ${latest.toFixed(4)}% — longs paying heavily, dump risk HIGH`;
      extreme = true;
    } else if (latest < -0.1) {
      signal = `🚨 EXTREME NEGATIVE funding ${latest.toFixed(4)}% — shorts paying heavily, squeeze risk HIGH`;
      extreme = true;
    } else if (latest > 0.05) {
      signal = `⚠️ High positive funding ${latest.toFixed(4)}% — avoid new longs`;
    } else if (latest < -0.05) {
      signal = `⚠️ High negative funding ${latest.toFixed(4)}% — avoid new shorts`;
    } else {
      signal = `✅ Normal funding ${latest.toFixed(4)}%`;
    }

    return { rate: latest, avg, extreme, signal, summary: `Funding Extreme: ${signal}` };
  } catch(e) { return null; }
}

// ── getTimeSignal ──
function getTimeSignal() {
  const hour = new Date().getUTCHours();
  const day = new Date().getUTCDay(); // 0=Sun, 6=Sat

  // Weekend = lower volume
  if (day === 0 || day === 6) return '📅 Weekend — lower volume, wider spreads. Reduce size 50%, lower leverage, tighter TP/SL. Still trade cautiously.';

  // Best trading hours (UTC)
  if (hour >= 13 && hour <= 17) return '🔥 NY session — highest volume, best time to trade';
  if (hour >= 8 && hour <= 12) return '📈 London session — good volume';
  if (hour >= 0 && hour <= 4) return '🌏 Asia session — moderate volume';
  if (hour >= 22 || hour <= 1) return '😴 Asian low volume hours — reduce position size 30%, still trade';

  return `Market session: UTC ${hour}:00`;
}

// ── getFullMarketIntel ──
async function getFullMarketIntel(coin = 'BTC') {
  const [fg, funding, oi, ls, liq, vol, dom, ta, ob] = await Promise.all([
    getFearGreed().catch(() => null),
    getFundingRate(coin).catch(() => null),
    getOpenInterest(coin).catch(() => null),
    getLongShortRatio(coin).catch(() => null),
    getLiquidationZones(coin).catch(() => null),
    getVolumeAnalysis(coin).catch(() => null),
    getBTCDominanceTrend().catch(() => null),
    getTechnicalAnalysis(coin).catch(() => null),
    getOrderBook(coin).catch(() => null)
  ]);

  const signals = [fg, funding, oi, ls, liq, vol, dom, ta, ob].filter(Boolean);
  return signals.join('\n');
}

// ── calculateSmartTrade ──
async function calculateSmartTrade(coin, direction, confidence, fearGreed, funding, entry) {
  const fg = parseInt(fearGreed?.match(/\d+/)?.[0] || 50);
  const fundingNum = parseFloat(funding?.match(/[\d.-]+/)?.[0] || 0);
  const settings = loadSettings();

  // Coin volatility tiers
  const highVol = ['PEPE','DOGE','SHIB','FLOKI','BONK','WIF','MEME'].includes(coin);
  const medVol = ['SOL','BNB','XRP','LINK','AVAX','ARB','MATIC'].includes(coin);

  // Market regime
  const isChoppy = fg >= 35 && fg <= 65;
  const isTrending = fg < 25 || fg > 75;
  const extremeFunding = Math.abs(fundingNum) > 0.05;

  // Position size by confidence
  const sizeMultiplier = confidence >= 90 ? 0.08
    : confidence >= 80 ? 0.05
    : confidence >= 70 ? 0.03
    : confidence >= 60 ? 0.02
    : 0.015;

  let tpPct, slPct, mode, partialTp;

  // ── User TP/SL settings ──────────────────────────────────────────────────
  const tpSlMode = settings.tpSlMode || 'auto'; // 'auto' or 'manual'
  const userRatio = settings.tpSlRatio || 2; // TP:SL ratio (e.g. 2 = TP is 2x SL)
  const userTpPct = settings.customTpPct ? settings.customTpPct / 100 : null;
  const userSlPct = settings.customSlPct ? settings.customSlPct / 100 : null;

  if (tpSlMode === 'manual' && userTpPct && userSlPct) {
    // User set custom TP/SL
    tpPct = userTpPct;
    slPct = userSlPct;
    mode = 'custom';
    partialTp = 0.7;
  } else if (tpSlMode === 'ratio' && userRatio) {
    // Auto calculate based on market, but enforce user ratio
    if (isChoppy) {
      slPct = highVol ? 0.015 : medVol ? 0.01 : 0.007;
      mode = 'scalp';
      partialTp = 1.0;
    } else if (isTrending) {
      slPct = highVol ? 0.04 : medVol ? 0.025 : 0.015;
      mode = 'swing';
      partialTp = 0.5;
    } else {
      slPct = highVol ? 0.025 : medVol ? 0.018 : 0.012;
      mode = 'normal';
      partialTp = 0.7;
    }
    // TP = SL × userRatio (enforce ratio)
    tpPct = slPct * userRatio;
  } else {
    // Full auto mode
    if (isChoppy) {
      mode = 'scalp';
      tpPct = highVol ? 0.025 : medVol ? 0.015 : 0.01;
      slPct = highVol ? 0.015 : medVol ? 0.01 : 0.007;
      partialTp = 1.0;
    } else if (isTrending) {
      mode = 'swing';
      tpPct = highVol ? 0.12 : medVol ? 0.08 : 0.05;
      slPct = highVol ? 0.04 : medVol ? 0.025 : 0.015;
      partialTp = 0.5;
    } else {
      mode = 'normal';
      tpPct = highVol ? 0.06 : medVol ? 0.04 : 0.025;
      slPct = highVol ? 0.025 : medVol ? 0.018 : 0.012;
      partialTp = 0.7;
    }
  }

  // ALWAYS enforce minimum 1:1 ratio — TP must be >= SL
  if (tpPct < slPct) tpPct = slPct;

  // Funding rate adjustment
  if (extremeFunding && direction === 'long' && fundingNum < -0.05) {
    tpPct *= 1.5;
  }

  // Try ATR-based TP/SL if ATR mode enabled
  let target, stopLoss;
  const useATR = settings.tpSlMode === 'atr';
  if (useATR) {
    try {
      const atrCandles = await getCandles(coin, '1h', 30).catch(() => null);
      if (atrCandles) {
        const atrResult = calcATRTargets(atrCandles, direction, entry, {
          atrPeriod: settings.atrPeriod || 14,
          atrTpMultiplier: settings.atrTpMultiplier || 2,
          atrSlMultiplier: settings.atrSlMultiplier || 1
        });
        if (atrResult) {
          target = atrResult.target;
          stopLoss = atrResult.stopLoss;
          tpPct = parseFloat(atrResult.tpPct) / 100;
          slPct = parseFloat(atrResult.slPct) / 100;
          console.log(`📐 ATR mode: TP ${atrResult.tpPct}% SL ${atrResult.slPct}% (ATR=$${atrResult.atr.toFixed(2)})`);
        }
      }
    } catch(e) {}
  }

  if (!target) {
    target = direction === 'long'
      ? parseFloat((entry * (1 + tpPct)).toFixed(6))
      : parseFloat((entry * (1 - tpPct)).toFixed(6));
  }
  if (!stopLoss) {
    stopLoss = direction === 'long'
      ? parseFloat((entry * (1 - slPct)).toFixed(6))
      : parseFloat((entry * (1 + slPct)).toFixed(6));
  }

  const trailingLevels = [
    { profitPct: 3, moveSLTo: 0 },
    { profitPct: 5, moveSLTo: 2 },
    { profitPct: 8, moveSLTo: 5 },
    { profitPct: 15, moveSLTo: 10 },
  ];

  // Auto-reduce on low volume / weekend
  const timeNow = getTimeSignal();
  const isLowVolume = timeNow?.includes('Weekend') || timeNow?.includes('low volume');
  if (isLowVolume) {
    sizeMultiplier *= 0.5; // 50% size on low volume
    tpPct *= 0.7;  // tighter TP
    slPct *= 0.7;  // tighter SL
    mode = mode + '-lowvol';
    console.log('📉 Low volume mode: size halved, TP/SL tightened');
  }

  const ratioActual = (tpPct / slPct).toFixed(1);
  console.log(`📐 Smart trade: ${mode} mode | TP: ${(tpPct*100).toFixed(1)}% | SL: ${(slPct*100).toFixed(1)}% | Ratio: 1:${ratioActual} | Mode: ${tpSlMode}`);

  // Per-coin calibration override — backtest-proven TP/SL beats generic tiers
  const calib = getCoinParams(coin);
  if (calib?.tpPct && calib?.slPct && Date.now() - (calib.calibrated || 0) < 30 * 24 * 60 * 60 * 1000) {
    tpPct = calib.tpPct;
    slPct = calib.slPct;
    target = direction === 'long' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    stopLoss = direction === 'long' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
    console.log(`🎯 Using calibrated params for ${coin}: TP ${tpPct}% / SL ${slPct}% (${calib.winRate}% historical win)`);
  }

  return { sizeMultiplier, tpPct, slPct, target, stopLoss, mode, partialTp, trailingLevels };
}

// ── applyTrailingStop ──
async function applyTrailingStop(trade, currentPrice) {
  const leverage = trade.leverage || 1;
  const priceDiff = trade.direction === 'long'
    ? currentPrice - trade.entry
    : trade.entry - currentPrice;
  const profitPct = (priceDiff / trade.entry) * leverage * 100;

  if (!trade.trailingLevels || profitPct <= 0) return null;

  let newSL = null;
  for (const level of trade.trailingLevels) {
    if (profitPct >= level.profitPct) {
      const targetSLPct = level.moveSLTo / leverage / 100;
      const newSLPrice = trade.direction === 'long'
        ? trade.entry * (1 + targetSLPct)
        : trade.entry * (1 - targetSLPct);

      // Only move SL in direction of profit (never make it worse)
      if (trade.direction === 'long' && newSLPrice > (trade.stopLoss || 0)) {
        newSL = parseFloat(newSLPrice.toFixed(6));
      } else if (trade.direction === 'short' && newSLPrice < (trade.stopLoss || Infinity)) {
        newSL = parseFloat(newSLPrice.toFixed(6));
      }
    }
  }

  if (newSL && newSL !== trade.stopLoss) {
    const pd = loadPaperTrades();
    const t = pd.trades.find(tr => tr.id === trade.id);
    if (t) {
      const oldSL = t.stopLoss;
      t.stopLoss = newSL;
      savePaperTrades(pd);
      console.log(`📈 Trailing stop moved: ${trade.coin} SL ${oldSL} → ${newSL} (profit: ${profitPct.toFixed(1)}%)`);
      sendTelegramNotification(`📈 Trailing Stop Updated\n${trade.direction?.toUpperCase()} ${trade.coin}\nSL moved: $${oldSL} → $${newSL}\nProfit locked: ${profitPct.toFixed(1)}%`);
      return newSL;
    }
  }
  return null;
}

// ── scanCoinForTrade ──
async function scanCoinForTrade(scanCoin) {
  try {
    const settings = loadSettings();
    if (!settings.independentScanner) return;
    if (!settings.autoPaperTrade) return;
    // Collect market data — full intelligence suite
    // Cache FG for hard blocks
const fgRaw = await getFearGreed().catch(() => '50');
global._cachedFearGreed = parseInt(fgRaw?.match(/\d+/)?.[0] || 50);

// Get today's daily RSI signal for bias context
const dailySignals = loadDailySignals();
const dailySignalForCoin = dailySignals?.signals?.[scanCoin];
const dailyBiasCtx = dailySignalForCoin
  ? `DAILY TRADE SIGNAL: ${dailySignalForCoin.tier} (Daily RSI: ${dailySignalForCoin.rsi}) — ${dailySignalForCoin.direction?.toUpperCase()} bias from daily timeframe`
  : '';

// Get market regime + news sentiment + whale signal + divergence + TG sentiment
const [regime, newsSentiment, divergence, tgSentiment] = await Promise.all([
  detectMarketRegime().catch(() => null),
  getNewsSentiment(scanCoin).catch(() => null),
  detectRSIDivergence(scanCoin).catch(() => null),
  getTelegramGroupSentiment(scanCoin).catch(() => null)
]);
const whaleSignal = getWhaleSignalForTrade(scanCoin);
const corrConflict = null; // checked per trade direction later
const regimeCtx = regime?.summary || '';
const newsCtx = newsSentiment ? `News Sentiment: ${newsSentiment.label} (${newsSentiment.score}/10) — ${newsSentiment.key_event}` : '';
const whaleCtx = whaleSignal || '';
const divergenceCtx = divergence?.signal || '';
const tgSentimentCtx = tgSentiment?.signal || '';
const [coinPrice, funding, fearGreed, dominance, news, openInterest, lsRatio, liquidations, volume, technicalAnalysis, orderBook, correlation, timeSignal, advancedFlow, btcLead] = await Promise.all([
      getCryptoPrice(scanCoin.toLowerCase()).catch(() => null),
      getFundingRate(scanCoin).catch(() => null),
      Promise.resolve(fgRaw),
      getBTCDominanceTrend().catch(() => null),
      getCryptoNews().catch(() => null),
      getOpenInterest(scanCoin).catch(() => null),
      getLongShortRatio(scanCoin).catch(() => null),
      getLiquidationZones(scanCoin).catch(() => null),
      getVolumeAnalysis(scanCoin).catch(() => null),
      getTechnicalAnalysis(scanCoin).catch(() => null),
      getOrderBook(scanCoin).catch(() => null),
      getCorrelation(scanCoin).catch(() => null),
      Promise.resolve(getTimeSignal()),
      getAdvancedFlow(scanCoin).catch(() => null),
      scanCoin !== 'BTC' ? getBTCLeadSignal().catch(() => null) : Promise.resolve(null)
    ]);

    // ₿ BTC LEAD HARD GATE — don't fight the king (alts only)
    if (btcLead?.block) {
      console.log(btcLead.summary);
      // Note: we don't know direction yet — store for post-analysis gate
    }

    const pd = loadPaperTrades();
    const recentTrades = pd.trades.filter(t => t.coin === scanCoin).slice(-5);
    const winRate = pd.stats.wins + pd.stats.losses > 0
      ? Math.round(pd.stats.wins / (pd.stats.wins + pd.stats.losses) * 100)
      : 0;

    const lessonsContext = buildLessonsContext();

    // Step 1 — Claude deep analysis (includes short consideration)
    const prompt = `You are an expert crypto trader. Analyze this market data for ${scanCoin} and decide if there is a trading opportunity — LONG OR SHORT.

MARKET DATA:
- ${scanCoin} Price: ${coinPrice}
- Funding Rate: ${funding} (positive = longs paying = bearish, negative = shorts paying = bullish)
- Fear & Greed: ${fearGreed}
- BTC Dominance: ${dominance}
${openInterest ? `- Open Interest: ${openInterest}` : ''}
${lsRatio ? `- Long/Short Ratio: ${lsRatio}` : ''}
${liquidations ? `- Liquidation Zones: ${liquidations}` : ''}
${volume ? `- Volume: ${volume}` : ''}
${technicalAnalysis ? `\nTECHNICAL ANALYSIS:\n${technicalAnalysis}` : ''}
${advancedFlow ? `\nADVANCED FLOW (order flow, structure, sweeps, traps, patterns — weigh these heavily, they show what's happening NOW):\n${advancedFlow}` : ''}
${btcLead?.summary ? `\n${btcLead.summary}` : ''}
${orderBook ? `- Order Book: ${orderBook}` : ''}
${correlation ? `- Correlation: ${correlation}` : ''}
- Time: ${timeSignal}
${dailyBiasCtx ? `- Daily Bias: ${dailyBiasCtx}` : ''}
${regimeCtx ? `- Market Regime: ${regimeCtx}` : ''}
${newsCtx ? `- News Sentiment: ${newsCtx}` : ''}
${whaleCtx ? `- Whale Activity: ${whaleCtx}` : ''}
${divergenceCtx ? `- RSI Divergence: ${divergenceCtx}` : ''}
${tgSentimentCtx ? `- TG Sentiment: ${tgSentimentCtx}` : ''}
- News: ${news?.slice(0, 150) || 'N/A'}

SIGNAL INTERPRETATION:
${lsRatio?.includes('TOO MANY LONGS') ? '⚠️ Crowded longs = squeeze risk = SHORT bias' : ''}
${lsRatio?.includes('TOO MANY SHORTS') ? '⚠️ Crowded shorts = squeeze risk = LONG bias' : ''}
${openInterest?.includes('RISING') ? '📈 Rising OI = new money entering = trend strengthening' : ''}
${openInterest?.includes('FALLING') ? '📉 Falling OI = positions closing = trend weakening' : ''}
${volume?.includes('SPIKE') ? '🔥 Volume spike = strong momentum = trade with it' : ''}
${volume?.includes('Low volume') ? '😴 Low volume = reduce size 50%, lower leverage max 3x, tighter stops. Still trade if direction is clear from RSI/MA/L-S ratio.' : ''}

RECENT ${scanCoin} TRADES:
${recentTrades.length ? recentTrades.map(t => `${t.direction} at $${t.entry} → ${t.status} P&L: $${t.pnl}`).join('\n') : 'No recent trades'}

${lessonsContext ? 'LEARNED RULES:\n' + lessonsContext : ''}

Current overall win rate: ${winRate}%

${lessonsContext}

SHORTING RULES — consider SHORT when:
- Price dumping more than 2% recently
- Funding rate very high (overleveraged longs)
- Fear & Greed above 75 (extreme greed = top)
- Strong downtrend with no support
- Bad news hitting the coin

LONGING RULES — consider LONG when:
- Price dipped 5%+ quickly = oversold bounce incoming
- Fear & Greed below 20 = extreme capitulation = bottom signal
- Funding rate negative = shorts paying = short squeeze risk
- Strong support level holding
- Even in downtrends — catch the bounces (scalp 1-3%)

IMPORTANT: Even in bearish markets you MUST look for bounce longs.
Pure shorting = predictable = bad strategy long term.
Mix directions: 60% short bias in bear market BUT still 40% long opportunities.
Catching bounces in bear markets is profitable and reduces risk.

Respond ONLY with JSON:
{
  "shouldTrade": true/false,
  "coin": "${scanCoin}",
  "direction": "long" or "short",
  "entry": current price number,
  "target": target price number,
  "stopLoss": stop loss price number,
  "confidence": 0-100,
  "reason": "brief reason under 20 words",
  "marketBias": "bullish" or "bearish" or "neutral"
}

Always consider BOTH directions.
In bearish market: look for short setups AND bounce long opportunities.
Only trade when there is a CLEAR edge — don't force trades.`;

    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = res.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);

    console.log(`🤖 Claude analysis: ${analysis.direction?.toUpperCase()} ${scanCoin} — confidence=${analysis.confidence}%, bias=${analysis.marketBias}, reason="${analysis.reason}"`);


    // Always emit scan result to intel feed
    sendIntelEvent({
        type: 'scan',
        source: 'Market Scan',
        body: `${scanCoin}: ${coinPrice?.match(/\$[\d,]+/)?.[0] || 'N/A'} | FG: ${fearGreed?.match(/\d+/)?.[0] || 'N/A'} | Funding: ${funding?.match(/[\d.-]+%/)?.[0] || 'N/A'}`,
        note: `Decision: ${analysis.shouldTrade ? 'Trading' : 'Waiting'} — ${analysis.reason}`,
        notify: false
      });

    if (analysis.shouldTrade && analysis.confidence >= 20) {
      // RULE ENFORCEMENT — does this trade break one of the user's rules?
      const ruleCheck = await checkUserRules(scanCoin, analysis.direction, analysis.reason).catch(() => ({ violated: false }));
      if (ruleCheck.violated) {
        console.log(`🛑 Trade blocked by user rule #${ruleCheck.ruleNumber}: "${ruleCheck.rule}" — ${ruleCheck.why}`);
        asukaReact('rule_block', { text: `Skipped ${scanCoin} — your rule: ${ruleCheck.rule}` });
        sendIntelEvent({ type: 'scan', source: 'Your Rules', body: `🛑 Skipped ${analysis.direction?.toUpperCase()} ${scanCoin} — your rule: "${ruleCheck.rule}"`, note: ruleCheck.why, notify: true });
        sendTelegramNotification(`🛑 Skipped ${analysis.direction?.toUpperCase()} ${scanCoin}\nYour rule #${ruleCheck.ruleNumber}: "${ruleCheck.rule}"\n${ruleCheck.why}`).catch(()=>{});
        logShadowTrade(scanCoin, analysis.direction, analysis.entry, analysis.target, analysis.stopLoss, `Blocked by rule: ${ruleCheck.rule}`, analysis.confidence);
        return;
      }
      const settings2 = loadSettings();
      let threshold = settings2.paperTradeThreshold || 20;
      if (settings2.autoThreshold) {
        threshold = 50;
      }

      // ── MiroFish Group Chat 2-Round Debate (Claude Haiku agents) ────────
      const _tierForAgents = getUserTier();
      const TOTAL_AGENTS = _tierForAgents.mirofish_agents || 20; // Tier: 10/20/30
      const AGENTS_PER_GROUP = 10;
      const NUM_GROUPS = Math.max(1, Math.round(TOTAL_AGENTS / AGENTS_PER_GROUP));
      const setupHistory = getSimilarSetupHistory(scanCoin, analysis.direction);
      const marketSummary = `${scanCoin} at ${coinPrice}, Funding: ${funding}, FG: ${fearGreed}. Claude suggests: ${analysis.direction?.toUpperCase()} with ${analysis.confidence}% confidence. Reason: ${analysis.reason}${setupHistory ? '. ' + setupHistory : ''}`;

      // #1 SPECIALIST DATA — each role gets the REAL data relevant to its expertise
      const roleData = {
        'technical analyst': technicalAnalysis ? `Technicals: ${String(technicalAnalysis).slice(0,200)}` : '',
        'sentiment trader': `Fear&Greed: ${fearGreed}. News: ${news ? String(news).slice(0,120) : 'none'}`,
        'whale watcher': advancedFlow ? `Flow: ${String(advancedFlow).slice(0,180)}` : (orderBook ? `Order book: ${String(orderBook).slice(0,150)}` : ''),
        'macro analyst': `BTC dominance: ${dominance}. BTC lead: ${btcLead?.summary || 'neutral'}`,
        'momentum trader': openInterest ? `Open Interest: ${openInterest}. Volume: ${volume || '?'}` : '',
        'risk manager': liquidations ? `Liquidation zones: ${String(liquidations).slice(0,180)}` : '',
        'news trader': news ? `News: ${String(news).slice(0,200)}` : 'No major news',
        'funding specialist': `Funding: ${funding}. L/S ratio: ${lsRatio || '?'}`,
        'volume analyst': volume ? `Volume: ${String(volume).slice(0,180)}` : '',
        'on-chain analyst': advancedFlow ? `On-chain flow: ${String(advancedFlow).slice(0,180)}` : '',
        'derivatives specialist': `OI: ${openInterest || '?'}. Funding: ${funding}. L/S: ${lsRatio || '?'}`,
        'options trader': `Funding: ${funding}. Liquidations: ${liquidations ? String(liquidations).slice(0,100) : '?'}`,
        'correlation analyst': correlation ? `Correlation: ${String(correlation).slice(0,180)}` : `BTC lead: ${btcLead?.summary||'?'}`,
        'volatility trader': liquidations ? `Liq zones: ${String(liquidations).slice(0,120)}. ATR via technicals: ${String(technicalAnalysis||'').slice(0,80)}` : '',
        'institutional trader': `OI: ${openInterest || '?'}. Flow: ${advancedFlow ? String(advancedFlow).slice(0,120) : '?'}`,
        'market maker': orderBook ? `Order book: ${String(orderBook).slice(0,180)}` : '',
        'retail sentiment gauge': `Fear&Greed: ${fearGreed}. L/S ratio: ${lsRatio || '?'} (high = retail crowded long)`
      };

      const allRoles = [
        'technical analyst', 'sentiment trader', 'whale watcher', 'macro analyst',
        'contrarian trader', 'momentum trader', 'risk manager', 'news trader',
        'funding specialist', 'pattern trader', 'volume analyst', 'options trader',
        'derivatives specialist', 'on-chain analyst', 'market maker',
        'retail sentiment gauge', 'institutional trader', 'algorithmic trader',
        'volatility trader', 'correlation analyst'
      ];

      // MiroFish agent — Claude Haiku with retry on rate limit
      async function callMiroAgent(role, prompt) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 150,
              messages: [{ role: 'user', content: prompt + '\n\nRespond with valid JSON only.' }]
            });
            const raw = res.content[0].text.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;
            return JSON.parse(jsonMatch[0]);
          } catch(e) {
            if (e.status === 429 || e.message?.includes('rate_limit') || e.message?.includes('429')) {
              const wait = (attempt + 1) * 3000;
              await new Promise(r => setTimeout(r, wait));
              continue;
            }
            return null;
          }
        }
        return null;
      }

      // Run one group debate — staggered calls to avoid rate limits
      async function runGroupDebate(groupId, groupRoles) {
        const delay = ms => new Promise(r => setTimeout(r, ms));
        
        // Round 1 — all agents evaluate Claude's suggested direction
        const round1Results = [];
        for (let i = 0; i < groupRoles.length; i++) {
          if (i > 0) await delay(500);
          const role = groupRoles[i];
          const track = getAgentAccuracy(role);
          const trackLine = track ? ` Your track record: ${track.accuracy}% accurate over ${track.votes} trades${track.accuracy < 45 ? ' — you have been wrong often, be extra careful' : track.accuracy > 65 ? ' — you have been sharp, trust your read' : ''}.` : '';
          const myData = roleData[role] ? `\nYOUR SPECIALTY DATA: ${roleData[role]}` : '';
          const result = await callMiroAgent(role,
            `You are a crypto ${role}.${trackLine} Market: ${marketSummary}${myData}\n\nUsing YOUR specialty's lens and data above, should we ${analysis.direction?.toUpperCase()} ${scanCoin} right now? JSON: {"agree":true/false,"confidence":0-100,"argument":"specific reason in 10 words"}`
          );
          round1Results.push(result ? { ...result, role } : { agree: false, confidence: 50, argument: 'unclear', role });
        }

        // Compile debate
        const agentMessages = round1Results.map(r => `${r.role}: "${r.argument}" (${r.agree ? 'AGREE' : 'DISAGREE'})`).join('\n');
        const bullArgs = round1Results.filter(r => r.agree).map(r => `${r.role}: ${r.argument}`).slice(0,2).join('; ');
        const bearArgs = round1Results.filter(r => !r.agree).map(r => `${r.role}: ${r.argument}`).slice(0,2).join('; ');

        // Round 2 — agents read debate and give final vote
        const round2Results = [];
        for (let i = 0; i < round1Results.length; i++) {
          if (i > 0) await delay(500);
          const agent = round1Results[i];
          const result = await callMiroAgent(groupRoles[i],
            `You are a crypto ${groupRoles[i]}. 
Your initial view: "${agent.argument}" (${agent.agree ? 'AGREE' : 'DISAGREE'} with ${analysis.direction?.toUpperCase()})
Team summary: ${agentMessages.slice(0, 300)}
Best bull argument: ${bullArgs.slice(0, 100)}
Best bear argument: ${bearArgs.slice(0, 100)}
After reading team debate — FINAL answer: should we ${analysis.direction?.toUpperCase()} ${scanCoin}?
Stay with your view unless someone made a VERY strong point.
JSON: {"agree":true/false,"confidence":0-100,"changed":true/false}`
          );
          // If result is null, keep original vote
          round2Results.push(result || { agree: agent.agree, confidence: agent.confidence, changed: false });
        }

        const groupAgree = round2Results.filter(v => v.agree).length;
        const groupChanged = round2Results.filter(v => v.changed).length;
        const groupConf = Math.round(round2Results.reduce((s, v) => s + (v.confidence || 50), 0) / round2Results.length);

        return {
          groupId, agree: groupAgree, total: groupRoles.length,
          changed: groupChanged, confidence: groupConf,
          topBullArg: round1Results.filter(r => r.agree)[0]?.argument || '',
          topBearArg: round1Results.filter(r => !r.agree)[0]?.argument || '',
          pct: Math.round(groupAgree / groupRoles.length * 100),
          roleVotes: round2Results.map((v, i) => ({ role: groupRoles[i], agree: !!v.agree }))
        };
      }

      console.log(`🐟 MiroFish Group Chat — ${NUM_GROUPS} groups of ${AGENTS_PER_GROUP} debating...`);

      // Create MIXED groups — each group has diverse roles to prevent echo chambers
      const groups = Array(NUM_GROUPS).fill(0).map((_, gi) => ({
        id: gi,
        // Each group gets one of each role type — true diversity
        roles: Array(AGENTS_PER_GROUP).fill(0).map((_, ai) => allRoles[ai % allRoles.length]),
        useGroq: false  // Not used anymore — all Haiku
      }));

      // Run all groups in PARALLEL — stagger within each group handles rate limits
      const groupResults = await Promise.all(
        (asukaReact('swarm_thinking'), groups.map(g => runGroupDebate(g.id, g.roles)))
      );

      // Compile group results
      const totalAgree = groupResults.reduce((s, g) => s + g.agree, 0);
      const totalChanged = groupResults.reduce((s, g) => s + g.changed, 0);
      const rawSwarmPct = Math.round(totalAgree / TOTAL_AGENTS * 100);
      // Experience-weighted vote: veteran agents (5+ trades) count by accuracy
      const allVotes = groupResults.flatMap(g => g.roleVotes || []);
      let wSum = 0, wAgree = 0, benched = 0;
      for (const v of allVotes) {
        const track = getAgentAccuracy(v.role);
        // #4 PRUNE: bench chronically-wrong veterans (15+ votes, <38% accurate) — they drag the swarm
        if (track && track.votes >= 15 && track.accuracy < 38) { benched++; continue; }
        // #2 SHARPER SPREAD: square the accuracy so proven agents dominate, weak ones fade
        // 75% → 0.56, 60% → 0.36, 45% → 0.20, rookie → 0.30 flat
        let weight;
        if (!track) weight = 0.30;
        else { const a = track.accuracy / 100; weight = Math.max(0.10, a * a); }
        wSum += weight;
        if (v.agree) wAgree += weight;
      }
      const swarmAgreePct = wSum > 0 ? Math.round(wAgree / wSum * 100) : rawSwarmPct;
      if (benched > 0) console.log(`🪑 Benched ${benched} chronically-wrong agent(s) from this vote`);
      asukaReact(swarmAgreePct >= 65 ? 'swarm_strong' : swarmAgreePct < 50 ? 'swarm_split' : 'swarm_thinking');
      if (swarmAgreePct !== rawSwarmPct) console.log(`🎓 Experience-weighted vote: ${rawSwarmPct}% raw → ${swarmAgreePct}% weighted (veterans count more)`);
      const _swarmVotesForRecord = allVotes;
      const swarmConfidence = Math.round(groupResults.reduce((s, g) => s + g.confidence, 0) / groupResults.length);
      // combinedConfidence calculated below
      const agreeCount = totalAgree;

      // Cross-group insights
      const bestBullArg = groupResults.filter(g => g.pct >= 60).map(g => g.topBullArg)[0] || '';
      const bestBearArg = groupResults.filter(g => g.pct < 40).map(g => g.topBearArg)[0] || '';
      const r1Pct = swarmAgreePct; // for Claude 2 reference
      const r2Pct = swarmAgreePct;
      const changed = totalChanged;

      console.log(`🐟 MiroFish Group Chat Results: ${agreeCount}/${TOTAL_AGENTS} agree (${swarmAgreePct}%) | ${totalChanged} agents changed mind`);
      // Stream the live swarm view — each agent's role + vote + accuracy
      try {
        const swarmAgents = allVotes.map(v => { const t = getAgentAccuracy(v.role); return { role: v.role, agree: !!v.agree, accuracy: t ? Math.round(t.accuracy) : null, trades: t ? t.trades : 0 }; });
        if (dashboardWindow?.webContents && !dashboardWindow.isDestroyed())
          dashboardWindow.webContents.send('swarm-live', { coin: scanCoin, direction: analysis.direction, agreePct: swarmAgreePct, changed: totalChanged, agents: swarmAgents, bullArg: bestBullArg, bearArg: bestBearArg });
      } catch(e) {}
      console.log(`🐟 Group breakdown: ${groupResults.map(g => `G${g.groupId}:${g.pct}%`).join(' ')}`);

      sendIntelEvent({
        type: 'scan',
        source: 'MiroFish Group Chat (8 groups × 10 agents)',
        body: `${analysis.direction?.toUpperCase()} ${scanCoin} — ${agreeCount}/${TOTAL_AGENTS} agree (${swarmAgreePct}%)`,
        note: `${totalChanged} agents changed mind | Best bull: "${bestBullArg}" | Best bear: "${bestBearArg}"`,
        notify: false
      });

      // Skip if swarm disagrees
      // #3 ADAPTIVE THRESHOLD — demand stronger consensus in risky conditions, relax in clean trends
      let voteThreshold = 50;
      const fgNum = parseInt(String(fearGreed).match(/\d+/)?.[0] || '50');
      if (analysis.confidence < 40) voteThreshold += 8;                 // Claude unsure → stricter
      if (fgNum > 78 || fgNum < 22) voteThreshold += 6;                 // sentiment extreme → choppy → stricter
      if (totalChanged > TOTAL_AGENTS * 0.35) voteThreshold += 5;       // lots of mind-changing = uncertainty
      if (btcLead?.block) voteThreshold += 7;                           // fighting BTC → stricter
      if (analysis.confidence >= 70 && fgNum >= 35 && fgNum <= 65) voteThreshold -= 5; // clean trend, calm → relax
      voteThreshold = Math.max(45, Math.min(70, voteThreshold));
      if (swarmAgreePct < voteThreshold) {
        console.log(`❌ MiroFish ${swarmAgreePct}% < ${voteThreshold}% needed (adaptive) — skipping ${analysis.direction} ${scanCoin}`);
        asukaReact('trade_skip');
        logShadowTrade(scanCoin, analysis.direction, analysis.entry, analysis.target, analysis.stopLoss, `MiroFish ${swarmAgreePct}% < ${voteThreshold}% adaptive`, analysis.confidence);
        return;
      }
      console.log(`✅ MiroFish ${swarmAgreePct}% >= ${voteThreshold}% (adaptive threshold) — proceeding`);

      // ── Claude Final Decision (synthesizes Claude 1 + full 3-round debate) ──
      console.log(`🧠 Claude final decision synthesis...`);
      // Calculate combined confidence directly — don't let Claude underweight swarm
      const combinedConfidence = Math.round(
        (analysis.confidence * 0.35) +  // Claude 1: 35%
        (swarmConfidence * 0.40) +       // Swarm confidence: 40%
        (swarmAgreePct * 0.25)           // Swarm agreement %: 25%
      );

      const finalRes = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: `You are the final decision maker for a crypto trade.

CLAUDE INITIAL ANALYSIS:
- Direction: ${analysis.direction?.toUpperCase()}
- Confidence: ${analysis.confidence}%
- Reason: ${analysis.reason}

MIROFISH DEBATE (${TOTAL_AGENTS} traders, 2 rounds):
- ${agreeCount}/${TOTAL_AGENTS} agree (${swarmAgreePct}%)
- ${changed} changed mind during debate
- Bull argument: "${bestBullArg || 'momentum'}"
- Bear argument: "${bestBearArg || 'downtrend'}"

PRE-CALCULATED CONFIDENCE: ${combinedConfidence}%
(Claude 35% + Swarm quality 40% + Swarm agreement 25%)

MARKET: ${scanCoin} at ${coinPrice}, FG: ${fearGreed}

Your job: decide shouldTrade and confirm/adjust the direction.
Use the pre-calculated confidence — only change it by ±5% max.

JSON only:
{
  "shouldTrade": true/false,
  "direction": "long" or "short",
  "entry": ${analysis.entry},
  "target": number,
  "stopLoss": number,
  "confidence": ${combinedConfidence},
  "reason": "final reason under 15 words"
}` }]
      });

      const finalText = finalRes.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g, '').trim();
      const finalDecision = JSON.parse(finalText);
      // Enforce combined confidence — Claude can't override it wildly
      finalDecision.confidence = Math.round((finalDecision.confidence + combinedConfidence) / 2);

      console.log(`🧠 Claude final: ${finalDecision.shouldTrade ? finalDecision.direction?.toUpperCase() : 'NO TRADE'} ${scanCoin} — ${finalDecision.confidence}% (combined: ${combinedConfidence}%) — ${finalDecision.reason}`);

      if (!finalDecision.shouldTrade) {
        console.log(`❌ Claude final rejected the trade`);
        logShadowTrade(scanCoin, analysis.direction, analysis.entry, analysis.target, analysis.stopLoss, 'Sonnet final reject', analysis.confidence);
        return;
      }

      if (finalDecision.confidence < threshold) {
        console.log(`⏭️ Final confidence ${finalDecision.confidence}% below threshold ${threshold}% — skipping`);
        logShadowTrade(scanCoin, finalDecision.direction, finalDecision.entry || analysis.entry, finalDecision.target, finalDecision.stopLoss, `below threshold ${threshold}%`, finalDecision.confidence);
        // Near-miss → upcoming trade recommendation ping
        if (finalDecision.confidence >= threshold - 8 && loadSettings().upcomingAlerts !== false) {
          sendTelegramNotification(`👀 Watchlist: ${finalDecision.direction?.toUpperCase()} ${scanCoin} forming at ${finalDecision.confidence}% confidence (needs ${threshold}%)\nEntry zone ~$${finalDecision.entry || analysis.entry} | Target $${finalDecision.target || '—'}\nIf the next scan confirms, she takes it — or you can jump early 🎯`).catch(() => {});
        }
        return;
      }
      // ────────────────────────────────────────────────────────────────────

      // ── Smart Trade Calculator — auto TP/SL/scalp/swing ──────────────
      const entryPrice = finalDecision.entry || analysis.entry || 
        parseFloat(coinPrice?.match(/[\$]?([\d,]+\.?\d*)/)?.[1]?.replace(',','') || 0);
      const smartParams = await calculateSmartTrade(
        scanCoin, finalDecision.direction, finalDecision.confidence,
        fearGreed, funding, entryPrice
      );
      // Override with smart parameters
      finalDecision.target = smartParams.target;
      finalDecision.stopLoss = smartParams.stopLoss;
      // ─────────────────────────────────────────────────────────────────

      // ── BTC Lead Gate — alts can't fight BTC's direction ──────────────
      if (btcLead?.block && scanCoin !== 'BTC' && finalDecision.direction === btcLead.block) {
        console.log(`₿ BTC LEAD GATE: blocking ${finalDecision.direction} ${scanCoin} — ${btcLead.summary}`);
        logShadowTrade(scanCoin, finalDecision.direction, finalDecision.entry || analysis.entry, finalDecision.target, finalDecision.stopLoss, 'BTC lead gate', finalDecision.confidence);
        return;
      }

      // ── Chasing Guard — entry already ran toward target? Don't chase ──
      try {
        const _entryRef = finalDecision.entry || analysis.entry;
        const _targetRef = finalDecision.target || analysis.target;
        if (_entryRef && _targetRef && coinPrice) {
          const moveDone = (coinPrice - _entryRef) / (_targetRef - _entryRef);
          if (moveDone > 0.4) {
            console.log(`🏃 CHASING GUARD: ${scanCoin} already ${Math.round(moveDone * 100)}% toward target — skipping late entry`);
            logShadowTrade(scanCoin, finalDecision.direction, coinPrice, _targetRef, finalDecision.stopLoss, 'chasing guard', finalDecision.confidence);
            return;
          }
        }
      } catch(e) {}

      // ── News-Spike Freeze — never enter INTO a violent candle ──────────
      try {
        const spike = await getCandles(scanCoin, '5m', 2);
        if (spike?.length === 2) {
          const spikePct = Math.abs(spike[1].close - spike[1].open) / spike[1].open * 100;
          if (spikePct > 3) {
            console.log(`⚡ NEWS-SPIKE FREEZE: ${scanCoin} moving ${spikePct.toFixed(1)}% THIS 5m candle — wait for dust to settle`);
            logShadowTrade(scanCoin, finalDecision.direction, coinPrice, finalDecision.target, finalDecision.stopLoss, 'news spike freeze', finalDecision.confidence);
            return;
          }
        }
      } catch(e) {}

      // ── Spread Guard — thin book = bad fills ──────────────────────────
      try {
        const spread = await getSpreadPct(scanCoin);
        if (spread !== null && spread > 0.15) {
          console.log(`📏 SPREAD GUARD: ${scanCoin} spread ${spread.toFixed(3)}% too wide — skipping (bad fills)`);
          logShadowTrade(scanCoin, finalDecision.direction, coinPrice, finalDecision.target, finalDecision.stopLoss, 'spread too wide', finalDecision.confidence);
          return;
        }
      } catch(e) {}

      // ── MTF Confirmation Gate (Off/Soft/Hard) ─────────────────────────
      const mtfMode = (settings.mtfMode || 'soft').toLowerCase();
      if (mtfMode !== 'off') {
        const mtf = await getMultiTimeframeSignal(scanCoin, finalDecision.direction).catch(() => null);
        if (mtf) {
          console.log(`🔬 ${mtf.summary}`);
          if (!mtf.isAligned) {
            if (mtfMode === 'hard') {
              console.log(`❌ MTF HARD mode: timeframes mixed — skipping ${finalDecision.direction} ${scanCoin}`);
              logShadowTrade(scanCoin, finalDecision.direction, finalDecision.entry || analysis.entry, finalDecision.target, finalDecision.stopLoss, 'MTF hard reject', finalDecision.confidence);
              return;
            }
            finalDecision.confidence = Math.max(0, finalDecision.confidence - 10);
            console.log(`🔬 MTF soft penalty: confidence → ${finalDecision.confidence}%`);
          }
        }
      }

      // ── Regime Mechanical Rules — regime changes BEHAVIOR not just context ──
      const regimeName = (regime?.regime || '').toLowerCase();
      if (regimeName === 'bear' && finalDecision.direction === 'long') {
        finalDecision.confidence = Math.max(0, finalDecision.confidence - 10);
        console.log(`🐻 Counter-regime long in bear market: confidence → ${finalDecision.confidence}%`);
      } else if (regimeName === 'bull' && finalDecision.direction === 'short') {
        finalDecision.confidence = Math.max(0, finalDecision.confidence - 10);
        console.log(`🐂 Counter-regime short in bull market: confidence → ${finalDecision.confidence}%`);
      } else if ((regimeName === 'bull' && finalDecision.direction === 'long') || (regimeName === 'bear' && finalDecision.direction === 'short')) {
        finalDecision.confidence = Math.min(95, finalDecision.confidence + 5);
      }

      // Re-entry discipline: recently stopped out on this coin → need +5 confidence
      const reentryPenalty = getReentryPenalty(scanCoin);
      if (reentryPenalty) console.log(`🔁 Re-entry discipline: ${scanCoin} stopped out <24h ago — threshold +${reentryPenalty}`);

      // Re-check threshold after adjustments
      if (finalDecision.confidence < threshold + reentryPenalty) {
        console.log(`⏭️ Confidence ${finalDecision.confidence}% below threshold after MTF/regime adjustments — skipping`);
        logShadowTrade(scanCoin, finalDecision.direction, finalDecision.entry || analysis.entry, finalDecision.target, finalDecision.stopLoss, 'below threshold after adjustments', finalDecision.confidence);
        return;
      }

      // ── Conviction Sizing — quality grade gates size ──────────────────
      const qScore = Math.round(finalDecision.confidence * 0.6 + swarmAgreePct * 0.4);
      const qualityGrade = qScore >= 80 ? 'A' : qScore >= 65 ? 'B' : qScore >= 50 ? 'C' : 'D';
      const sizeMultiplier = qualityGrade === 'A' ? 1.0 : qualityGrade === 'B' ? 0.75 : qualityGrade === 'C' ? 0.5 : 0;
      if (sizeMultiplier === 0) {
        console.log(`❌ Quality grade D (score ${qScore}) — not worth the risk, skipping`);
        logShadowTrade(scanCoin, finalDecision.direction, finalDecision.entry || analysis.entry, finalDecision.target, finalDecision.stopLoss, 'quality grade D', finalDecision.confidence);
        return;
      }
      console.log(`💎 Signal quality: ${qualityGrade} (${qScore}) — sizing at ${sizeMultiplier * 100}%`);

      // Check not already in this coin
      const existingTrade = pd.trades.find(t => t.status === 'open' && t.coin === analysis.coin);
      if (existingTrade) {
        if (combinedConfidence > existingTrade.confidence + 15) {
          console.log(`🔄 Higher confidence for ${analysis.coin} (${combinedConfidence}% vs ${existingTrade.confidence}%) — replacing trade`);
          closePaperTrade(existingTrade.id, analysis.entry, 'replaced by higher confidence signal');
        } else {
          console.log(`⏭️ Already have ${analysis.coin} trade at ${existingTrade.confidence}% — skipping`);
          return;
        }
      }

      const signal = {
        coin: analysis.coin,
        direction: finalDecision.direction,
        entry: finalDecision.entry || analysis.entry,
        target: finalDecision.target,
        stopLoss: finalDecision.stopLoss,
        confidence: finalDecision.confidence,
        caller: 'Asuka (Independent)',
        groupName: `Claude→MiroFish→Claude | ${swarmAgreePct}% agree | ${smartParams.mode} mode`,
        messageId: `scan_${Date.now()}`,
        timestamp: Date.now(),
        tradeMode: smartParams.mode,
        trailingLevels: smartParams.trailingLevels,
        partialTp: smartParams.partialTp,
        qualityGrade,
        sizeMultiplier,
        swarmVotes: _swarmVotesForRecord
      };

      // Persist the FULL reasoning for later review (trust/audit)
      saveTradeReplay({
        coin: analysis.coin, direction: finalDecision.direction,
        entry: signal.entry, target: signal.target, stopLoss: signal.stopLoss,
        confidence: finalDecision.confidence, timestamp: signal.timestamp,
        claudeReason: analysis.reason,
        marketBias: analysis.marketBias,
        swarmAgreePct, agentsTotal: TOTAL_AGENTS, agentsChanged: totalChanged,
        bullArg: bestBullArg, bearArg: bestBearArg,
        finalReason: finalDecision.reason || finalDecision.summary || '',
        qualityGrade, mode: smartParams.mode,
        agentVotes: (_swarmVotesForRecord||[]).map(v => ({ role: v.role, agree: !!v.agree })),
        outcome: null
      });

      asukaReact('trade_open', { detail: `${finalDecision.direction?.toUpperCase()} ${analysis.coin}` });
      openPaperTrade(signal);

      // Run scalp scan using main trade as context
      const scalpSettings = loadSettings();
      if (scalpSettings.scalpTrading) {
        setTimeout(() => runScalpScan(signal), 2000);
      }

      if (mainWindow) {
        mainWindow.webContents.send('independent-signal', {
          ...signal,
          reason: `${finalDecision.reason} | ${agreeCount}/${agentTypes.length} swarm agree`
        });
      }

      // Alert via voice
      if (mainWindow) {
        mainWindow.webContents.send('play-audio-text',
          `I spotted a ${analysis.direction} opportunity on ${analysis.coin} with ${analysis.confidence}% confidence. ${analysis.reason}. Opening a paper trade.`
        );
      }
    }
  } catch(e) {
    console.error('Independent scan error:', e.message);
  }
}

// ── runIndependentScan ──
async function runIndependentScan() {
  if (!tradingEnabled()) return; // companion mode — no trading
  _lastScanHeartbeat = Date.now();
  const devOv = getDevOverrides();
  if (_globalPauseMain || devOv.pauseMain) { console.log('⏸️ Main scanner paused by dev'); return; }
  const settings = loadSettings();
  if (!settings.independentScanner) return;
  if (!settings.autoPaperTrade) return;

  console.log('🔍 Running independent market scan...');

  try {
    // Scan selected coins (default BTC, ETH, SOL, BNB)
    const settings = loadSettings();
    let coinsToScan = settings.tradingCoins || ['BTC', 'ETH', 'SOL', 'BNB'];
    // Dev panel coin override preset takes priority: "2"=BTC/ETH, "3"=BTC/ETH/SOL, "5"=first 5, or "BTC,ETH,..." list
    if (devOv.coinOverride && devOv.coinOverride !== 'all') {
      const raw = String(devOv.coinOverride).trim();
      let ov = null;
      if (raw === '2') ov = ['BTC', 'ETH'];
      else if (raw === '3') ov = ['BTC', 'ETH', 'SOL'];
      else if (/^\d+$/.test(raw)) ov = coinsToScan.slice(0, parseInt(raw));
      else ov = raw.split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
      if (ov && ov.length) {
        coinsToScan = ov;
        console.log(`🔧 Dev coin override active: scanning only ${ov.join(', ')}`);
      }
    }
    
    for (const scanCoin of coinsToScan) {
      await scanCoinForTrade(scanCoin);
    }
  } catch(e) {
    console.error('Independent scan error:', e.message);
  }
}

// ── startIndependentScanner ──
function startIndependentScanner() {
  if (independentScanInterval) clearInterval(independentScanInterval);
  const settings = loadSettings();
  const intervalMinutes = getEffectiveScanInterval();
  _lastEffectiveInterval = intervalMinutes;
  independentScanInterval = setInterval(runIndependentScan, intervalMinutes * 60 * 1000);
  console.log(`🔍 Independent market scanner started (every ${intervalMinutes} min — tier+dev enforced)`);
  if (settings.independentScanner) {
    setTimeout(runIndependentScan, 5000);
  }
}

// ── runIndependentScalpScan ──
async function runIndependentScalpScan() {
  if (!tradingEnabled()) return; // companion mode
  const devOv = getDevOverrides();
  if (_globalPauseScalp || devOv.pauseScalp) { return; }
  const tier = getUserTier();
  if (!tier.scalp_enabled) { return; } // Tier enforcement: Starter has no scalp
  const settings = loadSettings();
  if (!settings.scalpTrading) return;
  if (!settings.autoPaperTrade) return;

  const pd = loadPaperTrades();
  const coins = settings.scalpCoins || settings.tradingCoins || ['BTC', 'ETH', 'SOL'];
  const scalpLeverage = settings.scalpLeverage || 10;
  const scalpSize = settings.scalpSize || 50;
  const scalpDuration = settings.scalpDuration || 30;
  const scalpThreshold = settings.scalpThreshold || 55;
  const maxScalps = settings.maxScalpTrades || 3;

  // Check total open scalps
  const totalOpenScalps = pd.trades.filter(t => t.status === 'open' && t.isScalp).length;
  if (totalOpenScalps >= maxScalps) {
    console.log(`⚡ Scalp scan skipped — max scalps reached (${totalOpenScalps}/${maxScalps})`);
    return;
  }

  // Get lessons context for smarter decisions
  const lessonsCtx = buildLessonsContext();

  // Get market data once for all coins
  let fearGreed = 50, funding = {};
  try { 
    const fg = await getFearGreed();
    fearGreed = fg;
    // Cache for hard block in openPaperTrade
    const fgNum = parseInt(fg?.match(/\d+/)?.[0] || 50);
    global._cachedFearGreed = fgNum;
  } catch(e) {}

  console.log('⚡ Running scalp scan (Haiku→5 agents→Sonnet pipeline)...');

  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (const coin of coins) {
    try {
      // Reload fresh each coin
      const freshPd = loadPaperTrades();
      const openScalps = freshPd.trades.filter(t => t.status === 'open' && t.isScalp).length;
      if (openScalps >= maxScalps) break;

      const existingScalp = freshPd.trades.find(t =>
        t.status === 'open' && t.coin === coin && t.isScalp
      );
      if (existingScalp) continue;

      // Check cooldown
      const cooldown = isCoinOnCooldown(coin);
      if (cooldown) { console.log(`⏰ Scalp skipped: ${coin} on cooldown (${cooldown}min)`); continue; }

      const mainTrade = freshPd.trades.find(t =>
        t.status === 'open' && t.coin === coin && !t.isScalp
      );

      const priceStr = await getCryptoPrice(coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (!priceMatch) continue;
      const currentPrice = parseFloat(priceMatch[1].replace(',', ''));

      // Get extra signals for smarter scalp decisions
      const settings2 = loadSettings();
      const scalpIndicators = settings2.scalpIndicators || { rsi: true, bb: true, sr: true, ob: true };
      
      const [lsRatio, liq, vol, scalpRsi, scalpBb, scalpSr, scalpOb, scalpIchi] = await Promise.all([
        getLongShortRatio(coin).catch(() => null),
        getLiquidationZones(coin).catch(() => null),
        getVolumeAnalysis(coin).catch(() => null),
        scalpIndicators.rsi !== false ? getCandles(coin, '15m', 30).then(c => c ? `RSI(${settings2.rsiPeriod||14}) 15m: ${calcRSI(c, settings2.rsiPeriod||14)}` : null).catch(() => null) : null,
        scalpIndicators.bb !== false ? getCandles(coin, '15m', 25).then(c => {
          if (!c) return null;
          const bb = calcBollingerBands(c, 20, 2);
          if (!bb) return null;
          const price = c[c.length-1].close;
          if (price <= bb.lower * 1.001) return `BB: Price at LOWER band — oversold bounce signal`;
          if (price >= bb.upper * 0.999) return `BB: Price at UPPER band — overbought reversal signal`;
          return `BB: Mid band (upper=$${bb.upper.toFixed(2)} lower=$${bb.lower.toFixed(2)})`;
        }).catch(() => null) : null,
        scalpIndicators.sr !== false ? getCandles(coin, '15m', 50).then(c => {
          if (!c) return null;
          const sr = calcSupportResistance(c);
          if (!sr.nearestSupport) return null;
          return `S/R: Support=$${sr.nearestSupport.toFixed(2)} (${sr.distToSupport}% away) | Resistance=$${sr.nearestResistance?.toFixed(2)} (${sr.distToResistance}% away)`;
        }).catch(() => null) : null,
        scalpIndicators.ob !== false ? getOrderBook(coin).catch(() => null) : null,
        scalpIndicators.vwap !== false ? getVWAP(coin).catch(() => null) : null,
        scalpIndicators.stochRsi !== false ? getCandles(coin, '15m', 50).then(c => {
          if (!c) return null;
          const sr = calcStochRSI(c, settings2.rsiPeriod||14);
          return sr ? sr.summary : null;
        }).catch(() => null) : null,
        scalpIndicators.emaCross !== false ? getCandles(coin, '15m', 50).then(c => {
          if (!c) return null;
          const ec = detectEMACross(c, 9, 21);
          return ec?.crossedUp || ec?.crossedDown ? ec.summary : null;
        }).catch(() => null) : null,
        scalpIndicators.ichimoku !== false ? getCandles(coin, '1h', 120).then(c => {
          if (!c) return null;
          const ichi = calcIchimoku(c, { tenkan: settings2.ichimokuTenkan||9, kijun: settings2.ichimokuKijun||26, senkouB: 52 });
          return ichi ? `Ichimoku: ${ichi.aboveCloud ? '✅ Above cloud (bullish)' : ichi.belowCloud ? '❌ Below cloud (bearish)' : '⚠️ In cloud'} | ${ichi.overallBias}` : null;
        }).catch(() => null) : null
      ]);
      
      // Additional scalp signals
      const [scalpCVD, scalpBtcLead] = await Promise.all([
        getCVD(coin).catch(() => null),
        coin !== 'BTC' ? getBTCLeadSignal().catch(() => null) : Promise.resolve(null)
      ]);
      const [scalpFunding, scalpPivot] = await Promise.all([
        scalpIndicators.fundingExtreme !== false ? getFundingRateExtreme(coin).catch(() => null) : null,
        scalpIndicators.pivots !== false ? getPivotPoints(coin).catch(() => null) : null
      ]);

      // ATR for scalp sizing
      let scalpATRInfo = null;
      if (scalpIndicators.atr !== false) {
        const atrC = await getCandles(coin, '15m', 30).catch(() => null);
        if (atrC) {
          const atrVal = calcATR(atrC, settings2.rsiPeriod || 14);
          if (atrVal) scalpATRInfo = `ATR(15m): $${atrVal.toFixed(4)} — ${(atrVal/currentPrice*100).toFixed(3)}% volatility`;
        }
      }

      const extraSignals = [
        lsRatio, liq, vol, scalpRsi, scalpBb, scalpSr, scalpOb, scalpIchi,
        scalpATRInfo,
        scalpFunding?.extreme ? scalpFunding.summary : null,
        scalpPivot ? `Pivots: PP=$${scalpPivot.PP} | ${scalpPivot.abovePivot ? 'Above PP bullish' : 'Below PP bearish'}` : null,
        scalpCVD?.summary || null,
        scalpBtcLead?.summary || null
      ].filter(Boolean).join('\n');
      const vwapSignal = extraSignals;

      // Today's performance on this coin
      const todayTrades = freshPd.trades.filter(t =>
        t.coin === coin &&
        t.status !== 'open' &&
        t.closeTime > Date.now() - 86400000
      );
      const todayWins = todayTrades.filter(t => t.pnl > 0).length;
      const todayLosses = todayTrades.filter(t => t.pnl <= 0).length;
      const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);

      const mainContext = mainTrade
        ? `MAIN TRADE: ${mainTrade.direction?.toUpperCase()} ${coin} at $${mainTrade.entry} | Target: $${mainTrade.target} | SL: $${mainTrade.stopLoss} | Currently: ${mainTrade.unrealizedPnl >= 0 ? 'WINNING' : 'LOSING'}`
        : 'No main trade open';

      const performanceCtx = `Today on ${coin}: ${todayWins}W/${todayLosses}L, P&L: $${todayPnl.toFixed(2)}`;

      // ── STEP 1: Haiku Scout ──────────────────────────────────────────
      let scoutResult = null;
      try {
        const scoutRes = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: `You are a crypto scalp scout. Find quick trading opportunities.

COIN: ${coin} at $${currentPrice}
Fear & Greed: ${fearGreed}
${mainContext}
${performanceCtx}

MARKET SIGNALS:
${extraSignals || 'No extra signals'}

${lsRatio?.includes('TOO MANY LONGS') ? 'SHORT bias: crowded longs' : ''}
${lsRatio?.includes('TOO MANY SHORTS') ? 'LONG bias: crowded shorts' : ''}
${vol?.includes('SPIKE') ? '🔥 High volume: trade with momentum, normal size' : ''}
${vol?.includes('Low volume') ? '😴 Low volume: use SMALL scalp ($20-30 max), tight TP 0.2-0.3%, still scalp if direction clear' : ''}
${fearGreed < 20 ? 'Extreme Fear: short bias preferred' : ''}

${lessonsCtx ? 'RULES:\n' + lessonsCtx : ''}

Is there a scalp opportunity RIGHT NOW?
TP: 0.3-1.5% | SL: 0.2-0.8% | Max 30 min

JSON only: {"shouldScalp":true/false,"direction":"long"or"short","entry":${currentPrice},"target":number,"stopLoss":number,"confidence":0-100,"reason":"under 8 words"}` }]
        });
        const raw = scoutRes.content[0].text.trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) scoutResult = JSON.parse(m[0]);
      } catch(e) {
        if (e.status === 429) await delay(3000);
        continue;
      }

      if (!scoutResult?.shouldScalp || scoutResult.confidence < 45) {
        console.log(`⚡ Scout: no opportunity on ${coin} (${scoutResult?.confidence || 0}%)`);
        continue;
      }

      console.log(`⚡ Scout found: ${scoutResult.direction?.toUpperCase()} ${coin} ${scoutResult.confidence}% — ${scoutResult.reason}`);
      const scalpSetupHistory = getSimilarSetupHistory(coin, scoutResult.direction); // #5 free

      // ── STEP 2: 5 Agent Debate ───────────────────────────────────────
      const agentRoles = [
        'technical analyst',
        'momentum trader',
        'risk manager',
        'contrarian trader',
        'sentiment analyst'
      ];

      const agentResults = [];
      for (let i = 0; i < agentRoles.length; i++) {
        if (i > 0) await delay(400);
        try {
          const aRes = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            messages: [{ role: 'user', content: `You are a crypto ${agentRoles[i]}.

Scout proposes: ${scoutResult.direction?.toUpperCase()} ${coin} at $${currentPrice}
Target: $${scoutResult.target} (${((Math.abs(scoutResult.target - currentPrice)/currentPrice)*100).toFixed(2)}% away)
SL: $${scoutResult.stopLoss} (${((Math.abs(scoutResult.stopLoss - currentPrice)/currentPrice)*100).toFixed(2)}% away)
Scout reason: "${scoutResult.reason}"
Scout confidence: ${scoutResult.confidence}%
Fear & Greed: ${fearGreed}
Today on ${coin}: ${todayWins}W/${todayLosses}L
${scalpSetupHistory ? 'SETUP HISTORY: ' + scalpSetupHistory : ''}

${lessonsCtx ? 'LEARNED RULES: ' + lessonsCtx.slice(0, 300) : ''}


IMPORTANT: Scout has already analyzed market data. 
If scout confidence is 65%+, default to AGREE unless you have a SPECIFIC strong reason to disagree.
Disagreeing without reason = bad analysis.
Consider: Does the direction make sense given market conditions?

JSON: {"agree":true/false,"confidence":0-100,"argument":"specific reason 8 words"}` }]
          });
          const raw2 = aRes.content[0].text.trim();
          const m2 = raw2.match(/\{[\s\S]*\}/);
          if (m2) agentResults.push({ ...JSON.parse(m2[0]), role: agentRoles[i] });
          else agentResults.push({ agree: false, confidence: 50, argument: 'unclear', role: agentRoles[i] });
        } catch(e) {
          if (e.status === 429) await delay(3000);
          agentResults.push({ agree: false, confidence: 50, argument: 'rate limited', role: agentRoles[i] });
        }
      }

      const agreeCount = agentResults.filter(a => a.agree).length;
      const avgConf = Math.round(agentResults.reduce((s, a) => s + a.confidence, 0) / agentResults.length);
      const agentSummary = agentResults.map(a => `${a.role}: "${a.argument}" (${a.agree ? 'AGREE' : 'DISAGREE'})`).join('\n');

      // #2 EXPERIENCE WEIGHTING — proven scalp agents count more (squared accuracy)
      let sw = 0, swAgree = 0, scalpBenched = 0;
      for (const a of agentResults) {
        const track = getAgentAccuracy(a.role);
        if (track && track.votes >= 15 && track.accuracy < 38) { scalpBenched++; continue; } // #4-lite: bench chronic losers
        let weight;
        if (!track) weight = 0.30;
        else { const acc = track.accuracy / 100; weight = Math.max(0.10, acc * acc); }
        sw += weight;
        if (a.agree) swAgree += weight;
      }
      const weightedAgreePct = sw > 0 ? Math.round(swAgree / sw * 100) : Math.round(agreeCount / 5 * 100);
      if (scalpBenched) console.log(`🪑 Scalp benched ${scalpBenched} chronic-loss agent(s)`);

      // #3 ADAPTIVE THRESHOLD (lighter than main) — base 40% weighted, stricter when risky
      let scalpThreshold = 40;
      const sFg = parseInt(String(fearGreed).match(/\d+/)?.[0] || '50');
      if (scoutResult.confidence < 55) scalpThreshold += 8;        // weak scout → stricter
      if (sFg > 80 || sFg < 20) scalpThreshold += 6;               // extreme sentiment → choppy
      if (todayLosses >= 2 && todayLosses > todayWins) scalpThreshold += 6; // bad day on this coin → tighten
      if (scoutResult.confidence >= 72) scalpThreshold -= 5;       // strong scout → relax
      scalpThreshold = Math.max(35, Math.min(60, scalpThreshold));

      console.log(`⚡ Agents: ${agreeCount}/5 raw, ${weightedAgreePct}% weighted on ${scoutResult.direction?.toUpperCase()} ${coin} (need ${scalpThreshold}%)`);

      if (weightedAgreePct < scalpThreshold || agreeCount < 2) {
        console.log(`⚡ Scalp rejected: ${weightedAgreePct}% weighted < ${scalpThreshold}% (or <2 raw) — skipping ${coin}`);
        logShadowTrade(coin, scoutResult?.direction, scoutResult?.entry, scoutResult?.target, scoutResult?.stopLoss, `scalp ${weightedAgreePct}% < ${scalpThreshold}%`, scoutResult?.confidence);
        continue;
      }

      // ── STEP 3: Sonnet Final Decision ────────────────────────────────
      let finalDecision = null;
      try {
        await delay(500);
        const finalRes = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 200,
          messages: [{ role: 'user', content: `You are the final decision maker for a scalp trade.

SCOUT PROPOSAL: ${scoutResult.direction?.toUpperCase()} ${coin}
Price: $${currentPrice} | Target: $${scoutResult.target} | SL: $${scoutResult.stopLoss}
Scout confidence: ${scoutResult.confidence}%

5 AGENT DEBATE (${agreeCount}/5 agree):
${agentSummary}

USER CONTEXT:
Balance: $${freshPd.balance?.toFixed(2)}
Today on ${coin}: ${todayWins}W/${todayLosses}L ($${todayPnl.toFixed(2)})
Open scalps: ${openScalps}/${maxScalps}
${mainContext}
Fear & Greed: ${fearGreed}

LEARNED RULES:
${lessonsCtx || 'No lessons yet'}

Combined confidence: ${Math.round((scoutResult.confidence * 0.3) + (avgConf * 0.4) + (agreeCount / 5 * 100 * 0.3))}%

Should we execute this scalp? Consider:
- Agent consensus (${agreeCount}/5)
- Today performance on this coin
- Learned rules from past trades
- Risk vs reward

JSON only:
{
  "execute": true/false,
  "direction": "${scoutResult.direction}",
  "entry": ${currentPrice},
  "target": number,
  "stopLoss": number,
  "confidence": 0-100,
  "reason": "final reason under 12 words",
  "sizeMultiplier": 0.5-1.5
}` }]
        });

        const raw3 = finalRes.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g, '').trim();
        finalDecision = JSON.parse(raw3);
      } catch(e) {
        console.log(`⚡ Sonnet error on ${coin}: ${e.message?.slice(0, 60)}`);
        continue;
      }

      if (!finalDecision?.execute) {
        console.log(`⚡ Sonnet rejected ${coin}: ${finalDecision?.reason}`);
        logShadowTrade(coin, scoutResult?.direction, scoutResult?.entry, scoutResult?.target, scoutResult?.stopLoss, 'scalp Sonnet reject', scoutResult?.confidence);
        continue;
      }

      const threshold = settings.scalpThreshold || 55;
      // On low volume, lower threshold slightly (small scalps are fine)
      const isLowVolNow = vol?.includes('Low volume') || getTimeSignal()?.includes('Weekend');
      const effectiveThreshold = isLowVolNow ? Math.max(45, threshold - 10) : threshold;
      if (finalDecision.confidence < effectiveThreshold) {
        console.log(`⚡ Confidence ${finalDecision.confidence}% below threshold ${effectiveThreshold}% (${isLowVolNow ? 'low vol adjusted' : 'normal'}) — skipping ${coin}`);
        continue;
      }

      // ── STEP 4: Execute ──────────────────────────────────────────────
      // Auto-reduce scalp size on low volume / weekend
      const isLowVol = vol?.includes('Low volume') || getTimeSignal()?.includes('Weekend');
      const volMultiplier = isLowVol ? 0.4 : 1; // 40% size on low volume
      const adjustedSize = Math.max(10, Math.round(scalpSize * (finalDecision.sizeMultiplier || 1) * volMultiplier));
      if (isLowVol) console.log(`📉 Low volume scalp: size reduced to $${adjustedSize}`);

      const scalpSignal = {
        coin,
        direction: finalDecision.direction,
        entry: finalDecision.entry || currentPrice,
        target: finalDecision.target,
        stopLoss: finalDecision.stopLoss,
        confidence: finalDecision.confidence,
        leverage: scalpLeverage,
        size: adjustedSize,
        caller: 'Asuka (Scalp)',
        groupName: `Scalp | Scout+${agreeCount}/5 agents+Sonnet | ${scoutResult.reason}`,
        messageId: `scalp_${Date.now()}`,
        timestamp: Date.now(),
        isScalp: true,
        scalpExpiry: Date.now() + (scalpDuration * 60 * 1000),
      };

      await openPaperTrade(scalpSignal);
      console.log(`⚡ Scalp executed: ${finalDecision.direction?.toUpperCase()} ${coin} ${finalDecision.confidence}% — ${finalDecision.reason}`);

      sendIntelEvent({
        type: 'signal',
        source: `⚡ Scalp (${agreeCount}/5 agents)`,
        body: `${finalDecision.direction?.toUpperCase()} ${coin} — Scout+Agents+Sonnet agreed`,
        note: `${finalDecision.reason} | ${finalDecision.confidence}% confidence | Auto-closes ${scalpDuration}min`,
        notify: true
      });

      // Small delay between coins
      await delay(500);

    } catch(e) {
      console.error(`⚡ Scalp scan error on ${coin}:`, e.message?.slice(0, 80));
    }
  }
}

// ── runScalpScan ──
async function runScalpScan(mainTrade) {
  const settings = loadSettings();
  if (!settings.scalpTrading) return;
  if (!settings.autoPaperTrade) return;

  const pd = loadPaperTrades();
  
  // Check if already have scalp open for this coin
  const existingScalp = pd.trades.find(t => 
    t.status === 'open' && 
    t.coin === mainTrade.coin && 
    t.isScalp === true
  );
  if (existingScalp) return;

  const scalpLeverage = settings.scalpLeverage || 20;
  const scalpSize = settings.scalpSize || (pd.balance * 0.01); // 1% default
  const scalpDuration = settings.scalpDuration || 30; // minutes

  try {
    // Get current price
    const priceStr = await getCryptoPrice(mainTrade.coin.toLowerCase());
    const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
    if (!priceMatch) return;
    const currentPrice = parseFloat(priceMatch[1].replace(',', ''));

    // 10 smart agents find scalp opportunity using main trade as context
    const agentRoles = [
      'scalp specialist', 'technical analyst', 'momentum trader',
      'contrarian trader', 'pattern trader', 'funding specialist',
      'whale watcher', 'sentiment trader', 'risk manager', 'news trader'
    ];

    const scalpPrompt = (role) => `You are a crypto ${role} finding SCALP opportunities.

MAIN TRADE CONTEXT:
Coin: ${mainTrade.coin}
Direction: ${mainTrade.direction?.toUpperCase()} (swing trade)
Entry: $${mainTrade.entry}
Target: $${mainTrade.target}
SL: $${mainTrade.stopLoss}
Confidence: ${mainTrade.confidence}%

CURRENT MARKET:
Price: $${currentPrice}
Main trade P&L direction: ${mainTrade.direction === 'long' ? 'going up' : 'going down'}

Find the BEST scalp trade RIGHT NOW:
- Can be SAME direction as main (momentum scalp)
- Can be OPPOSITE direction (counter-trend scalp)
- Must be quick: TP 0.5-2%, SL 0.3-1%
- Must close within ${scalpDuration} minutes

JSON only:
{
  "shouldScalp": true/false,
  "direction": "long" or "short",
  "entry": ${currentPrice},
  "target": number,
  "stopLoss": number,
  "confidence": 0-100,
  "reason": "under 10 words",
  "expectedDuration": "5-30 minutes"
}`;

    // Run 10 agents in parallel
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const agentResults = [];
    
    for (let i = 0; i < agentRoles.length; i++) {
      if (i > 0) await delay(300);
      try {
        const res = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: scalpPrompt(agentRoles[i]) + '\n\nJSON only.' }]
        });
        const raw = res.content[0].text.trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          agentResults.push({ ...result, role: agentRoles[i] });
        }
      } catch(e) {
        if (e.status === 429) await delay(3000);
      }
    }

    if (!agentResults.length) return;

    // Find best scalp opportunity
    const scalpSuggestions = agentResults.filter(a => a.shouldScalp && a.confidence >= 60);
    if (scalpSuggestions.length < 3) {
      console.log(`⚡ Scalp: only ${scalpSuggestions.length}/10 agents see opportunity — skipping`);
      return;
    }

    // Average confidence and pick majority direction
    const avgConf = Math.round(scalpSuggestions.reduce((s, a) => s + a.confidence, 0) / scalpSuggestions.length);
    const longVotes = scalpSuggestions.filter(a => a.direction === 'long').length;
    const shortVotes = scalpSuggestions.filter(a => a.direction === 'short').length;
    const scalpDirection = longVotes >= shortVotes ? 'long' : 'short';

    // ₿ BTC Lead Gate — scalps follow BTC hardest on short timeframes
    const btcLeadScalp = coin !== 'BTC' ? await getBTCLeadSignal().catch(() => null) : null;
    if (btcLeadScalp?.block && btcLeadScalp.block === scalpDirection) {
      console.log(`₿ SCALP BTC GATE: blocking ${scalpDirection} ${coin} — ${btcLeadScalp.summary}`);
      logShadowTrade(coin, scalpDirection, null, null, null, 'scalp BTC lead gate', avgConf);
      return;
    }

    // Claude final scalp decision
    const finalRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      messages: [{ role: 'user', content: `You are deciding on a scalp trade.

MAIN TRADE: ${mainTrade.direction?.toUpperCase()} ${mainTrade.coin} swing
SCALP AGENTS: ${scalpSuggestions.length}/10 see opportunity
Direction votes: ${longVotes} LONG vs ${shortVotes} SHORT
Avg confidence: ${avgConf}%
Best reason: "${scalpSuggestions[0]?.reason}"
Current price: $${currentPrice}
Max duration: ${scalpDuration} min

Approve this scalp? JSON only:
{
  "approve": true/false,
  "direction": "${scalpDirection}",
  "entry": ${currentPrice},
  "target": number,
  "stopLoss": number,
  "confidence": 0-100,
  "reason": "under 10 words"
}` }]
    });

    const finalRaw = finalRes.content[0].text.trim();
    const finalMatch = finalRaw.match(/\{[\s\S]*\}/);
    if (!finalMatch) return;
    const finalDecision = JSON.parse(finalMatch[0]);

    if (!finalDecision.approve || finalDecision.confidence < 60) {
      console.log(`⚡ Scalp rejected by Claude: ${finalDecision.reason}`);
      return;
    }

    // Open scalp trade
    const scalpSignal = {
      coin: mainTrade.coin,
      direction: finalDecision.direction,
      entry: finalDecision.entry || currentPrice,
      target: finalDecision.target,
      stopLoss: finalDecision.stopLoss,
      confidence: finalDecision.confidence,
      caller: 'Asuka (Scalp)',
      groupName: `Scalp | ${scalpSuggestions.length}/10 agents | ${scalpDirection === mainTrade.direction ? 'With trend' : 'Counter trend'}`,
      messageId: `scalp_${Date.now()}`,
      timestamp: Date.now(),
      isScalp: true,
      scalpExpiry: Date.now() + (scalpDuration * 60 * 1000),
      leverage: scalpLeverage,
      size: scalpSize
    };

    const trade = await openPaperTrade(scalpSignal);
    console.log(`⚡ Scalp opened: ${finalDecision.direction?.toUpperCase()} ${mainTrade.coin} — ${finalDecision.confidence}% — ${finalDecision.reason}`);

    sendIntelEvent({
      type: 'signal',
      source: '⚡ Scalp Trade',
      body: `${finalDecision.direction?.toUpperCase()} ${mainTrade.coin} scalp — ${scalpSuggestions.length}/10 agents agree`,
      note: `${finalDecision.reason} | Auto-closes in ${scalpDuration} min | ${finalDecision.confidence}% confidence`,
      notify: true
    });

  } catch(e) {
    console.error('Scalp scan error:', e.message);
  }
}

// ── runDailyTradeBot ──
async function runDailyTradeBot() {
  const settings = loadSettings();
  if (!settings.dailyTradeEnabled) return;
  if (!settings.autoPaperTrade) return;

  console.log('📅 Running Daily Trade Bot...');

  const coins = settings.dayTradeCoins || settings.tradingCoins || ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB'];
  const period = settings.dailyRSIPeriod || 14;
  const powerOnly = settings.dailyPowerOnly !== false; // default true
  const leverage = settings.dailyLeverage || 3;
  const size = settings.dailyTradeSize || 1000;
  const maxTrades = settings.dailyMaxTrades || 1;

  // Check how many day trades already open
  const pd = loadPaperTrades();
  const openDayTrades = pd.trades.filter(t => t.status === 'open' && t.isDayTrade);
  if (openDayTrades.length >= maxTrades) {
    console.log(`📅 Daily bot: max day trades reached (${openDayTrades.length}/${maxTrades})`);
    return;
  }

  // Get FG for context
  const fg = global._cachedFearGreed || 50;
  const lessonsCtx = buildLessonsContext();

  // Scan each coin
  const signals = [];
  for (const coin of coins) {
    try {
      // Skip if already have day trade on this coin
      const existingDayTrade = pd.trades.find(t =>
        t.status === 'open' && t.coin === coin && t.isDayTrade
      );
      if (existingDayTrade) continue;

      const rsi = await getDailyRSI(coin, period);
      if (rsi === null) continue;

      const tier = getDailySignalTier(rsi, settings);
      const direction = getSignalDirection(tier);

      console.log(`📅 ${coin} Daily RSI: ${rsi?.toFixed(2)} → ${tier}`);

      // Skip neutral
      if (!direction) continue;

      // Skip non-power signals if powerOnly mode
      if (powerOnly && (tier === 'Buy' || tier === 'Sell')) {
        console.log(`📅 ${coin}: skipping ${tier} (Power Only mode enabled)`);
        continue;
      }

      signals.push({ coin, rsi, tier, direction });
    } catch(e) {
      console.error(`📅 Daily RSI error ${coin}:`, e.message?.slice(0, 50));
    }
  }

  if (!signals.length) {
    console.log('📅 Daily bot: no signals today — market neutral');
    // Save empty signals
    saveDailySignals({
      signals: {},
      lastUpdated: Date.now(),
      date: new Date().toISOString().split('T')[0]
    });
    return;
  }

  // Sort by signal strength (Power first, then by RSI extremity)
  signals.sort((a, b) => {
    const strength = { 'Power Buy': 3, 'Power Sell': 3, 'Buy': 1, 'Sell': 1 };
    if (strength[b.tier] !== strength[a.tier]) return strength[b.tier] - strength[a.tier];
    // More extreme RSI = stronger signal
    const aExtreme = Math.min(a.rsi, 100 - a.rsi);
    const bExtreme = Math.min(b.rsi, 100 - b.rsi);
    return aExtreme - bExtreme;
  });

  // Save daily signals for display
  const signalMap = {};
  for (const s of signals) {
    signalMap[s.coin] = { rsi: s.rsi?.toFixed(2), tier: s.tier, direction: s.direction };
  }
  saveDailySignals({
    signals: signalMap,
    lastUpdated: Date.now(),
    date: new Date().toISOString().split('T')[0]
  });

  // Execute trades for strongest signals
  const delay = ms => new Promise(r => setTimeout(r, ms));
  let tradesOpened = 0;

  for (const signal of signals) {
    if (tradesOpened + openDayTrades.length >= maxTrades) break;

    try {
      // Get current price
      const priceStr = await getCryptoPrice(signal.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (!priceMatch) continue;
      const currentPrice = parseFloat(priceMatch[1].replace(',', ''));

      // Claude makes the final decision with context
      await delay(1000);
      const claudeRes = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: `You are managing a DAILY TRADE for ${signal.coin}.

DAILY RSI SIGNAL:
Coin: ${signal.coin}
Daily RSI: ${signal.rsi?.toFixed(2)} (Period: ${period})
Signal: ${signal.tier}
Direction: ${signal.direction?.toUpperCase()}
Current Price: $${currentPrice}
Fear & Greed: ${fg}

CONTEXT:
${lessonsCtx || 'No lessons yet'}

This is a DAY TRADE — holds hours to days.
Use wider TP (5-15%) and SL (2-3%).
Confirm the signal or reject if market conditions are against it.

JSON only:
{
  "execute": true/false,
  "direction": "${signal.direction}",
  "entry": ${currentPrice},
  "target": number,
  "stopLoss": number,
  "confidence": 0-100,
  "reason": "under 12 words"
}` }]
      });

      const raw = claudeRes.content[0].text.replace(/```json|```/g, '').trim();
      const decision = JSON.parse(raw);

      if (!decision.execute) {
        console.log(`📅 Claude rejected ${signal.coin} day trade: ${decision.reason}`);
        continue;
      }

      // Open the day trade
      const daySignal = {
        coin: signal.coin,
        direction: decision.direction,
        entry: decision.entry || currentPrice,
        target: decision.target,
        stopLoss: decision.stopLoss,
        confidence: decision.confidence,
        leverage,
        size,
        caller: 'Asuka (Daily Trade)',
        groupName: `Daily Trade | ${signal.tier} | RSI ${signal.rsi?.toFixed(1)}`,
        messageId: `daily_${Date.now()}`,
        timestamp: Date.now(),
        isDayTrade: true,
        dailyRSI: signal.rsi,
        dailyTier: signal.tier
      };

      await openPaperTrade(daySignal);
      tradesOpened++;

      console.log(`📅 Day trade opened: ${signal.direction?.toUpperCase()} ${signal.coin} | ${signal.tier} | RSI ${signal.rsi?.toFixed(1)} | ${decision.confidence}%`);

      sendIntelEvent({
        type: 'signal',
        source: `📅 Daily Trade Bot`,
        body: `${signal.tier.toUpperCase()}: ${signal.direction?.toUpperCase()} ${signal.coin}`,
        note: `Daily RSI: ${signal.rsi?.toFixed(1)} | ${decision.reason} | ${decision.confidence}% confidence`,
        notify: true
      });

      await delay(2000);
    } catch(e) {
      console.error(`📅 Day trade error ${signal.coin}:`, e.message?.slice(0, 80));
    }
  }

  if (tradesOpened === 0) {
    console.log('📅 Daily bot: signals found but Claude rejected all entries');
  }
}

// ── scheduleDailyTradeBot ──
function scheduleDailyTradeBot() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(0, 5, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);

  const msUntilRun = nextRun - now;
  console.log(`📅 Daily Trade Bot scheduled — next run in ${Math.round(msUntilRun/3600000)}h ${Math.round((msUntilRun%3600000)/60000)}m`);

  setTimeout(() => {
    runDailyTradeBot();
    // Then run every 24 hours
    setInterval(runDailyTradeBot, 24 * 60 * 60 * 1000);
  }, msUntilRun);
}

// ── saveDailySignals ──
function saveDailySignals(d) { saveJSON(DAILY_SIGNALS_FILE, d); }

// ── loadDailySignals ──
function loadDailySignals() { return loadJSON(DAILY_SIGNALS_FILE, { signals: {}, lastUpdated: null, date: null }); }

// ── openPaperTrade ──
async function openPaperTrade(signal) {
  // ── Security: global daily loss limit (settings.dailyLossLimit, 0/unset = off) ──
  try {
    const s0 = loadSettings();
    const cap = Number(s0.dailyLossLimit) || 0;
    if (cap > 0) {
      const today = new Date().toDateString();
      const pd0 = loadPaperTrades();
      const lossToday = (pd0.trades||[]).filter(t => t.closeTime && new Date(t.closeTime).toDateString() === today)
                        .reduce((a,t) => a + (t.pnl||0), 0);
      if (lossToday <= -cap) {
        console.log(`🛑 Daily loss limit hit (-$${cap}) — trade blocked`);
        sendTelegramNotification(`🛑 Daily loss limit (-$${cap}) reached. No more trades today — protecting you from yourself. 🌸`).catch(()=>{});
        return null;
      }
    }
  } catch(e) {}
  // ── SECURITY: daily loss circuit-breaker — stop opening trades after losing $X today ──
  try {
    const lim = (loadTradeRules().global || {}).dailyMaxLossUsd || 0;
    if (lim > 0) {
      const today = new Date().toDateString();
      const pdL = loadPaperTrades();
      const lostToday = (pdL.trades||[]).filter(t => t.closeTime && new Date(t.closeTime).toDateString() === today)
                                        .reduce((a,t) => a + (t.pnl||0), 0);
      if (lostToday <= -lim) {
        if (!global._lossLimitNotified || Date.now() - global._lossLimitNotified > 36e5) {
          global._lossLimitNotified = Date.now();
          sendTelegramNotification(`🛑 Daily loss limit hit (-$${lim}). No new trades today.`).catch(()=>{});
          try { sendAsukaVoice(`We are down $${Math.abs(lostToday).toFixed(0)} today, so the trading floor is closed. Tomorrow is a new day.`); } catch(e){}
        }
        console.log(`🛑 Trade blocked — daily loss limit $${lim} reached`);
        return null;
      }
    }
  } catch(e){}
  // Check rage lock
  if (checkRageLock()) {
    console.log('🔒 Rage lock active — trade blocked');
    return null;
  }

  // Check daily P&L limit
  if (isTradingPaused()) {
    console.log("⏸️ Trading paused — daily loss limit or manual pause");
    return null;
  }

  // Check max concurrent positions
  if (checkMaxPositions()) {
    console.log("⚠️ Max concurrent positions reached");
    return null;
  }

  // Check cooldown
  const cooldownRemaining = isCoinOnCooldown(signal.coin);
  if (cooldownRemaining) {
    console.log(`⏰ ${signal.coin} is on cooldown — ${cooldownRemaining} min remaining after recent loss`);
    return null;
  }

  // Hard block based on learned lessons
  const settings = loadSettings();
  const lessons = loadTradingLessons();
  const lastFG = global._cachedFearGreed || 50;
  
  // Block BNB longs at 20x below 73% in Extreme Fear
  if (signal.coin === 'BNB' && signal.direction === 'long' && 
      signal.leverage >= 20 && signal.confidence < 73 && lastFG < 20) {
    console.log('🚫 Hard block: BNB long at 20x below 73% in Extreme Fear — lesson learned');
    return null;
  }
  
  // Block any altcoin long below 70% in Extreme Fear
  const altcoins = ['BNB','SOL','XRP','DOGE','AVAX','LINK','ARB','PEPE'];
  if (altcoins.includes(signal.coin) && signal.direction === 'long' &&
      signal.confidence < 70 && lastFG < 15) {
    console.log(`🚫 Hard block: ${signal.coin} long below 70% in Extreme Fear (FG=${lastFG}) — lesson learned`);
    return null;
  }
  // Manual demo trades skip auto-gates — user's explicit choice
  const isManual = !!signal.manual;

  // Event blackout — FOMC/CPI windows
  const blackout = isManual ? null : eventBlackoutCheck();
  if (blackout) { console.log(blackout); return null; }

  // Per-coin bench — coin on losing streak is blocked
  const benchDays = isManual ? null : getCoinBench(signal.coin);
  if (benchDays) {
    console.log(`🪑 ${signal.coin} is benched (${benchDays}d left after losing streak) — trade blocked`);
    return null;
  }

  const pd = loadPaperTrades();
  // settings already declared
  // Use signal leverage if provided (scalp trades), otherwise use settings
  const leverage = signal.leverage || settings.paperLeverage || 1;
  let size = signal.size || settings.paperTradeSize || (pd.balance * 0.05);
  // Kelly Criterion sizing (now works for leverage trades, not just spot)
  if (settings.useKellyCriterion) {
    try { size = calcKellySize(signal.coin, size); } catch(e) {}
  }
  // Conviction sizing — quality grade scales position (A=100% B=75% C=50%)
  if (signal.sizeMultiplier && signal.sizeMultiplier > 0 && signal.sizeMultiplier < 1) {
    size = size * signal.sizeMultiplier;
    console.log(`💎 Conviction sizing: grade ${signal.qualityGrade || '?'} → $${size.toFixed(0)} position`);
  }
  // Liquidation Guard — warn on dangerous leverage
  try {
    const lg = liqGuardCheck(signal.direction, signal.entry || 0, leverage);
    if (lg?.warning) { console.log(lg.warning); sendTelegramNotification(lg.warning).catch(() => {}); }
  } catch(e) {}
  // Anti-tilt (3 losses in a row → half size until a win)
  size = size * getAntiTiltMultiplier();
  // Equity-curve + win-streak discipline
  size = size * getEquityCurveMultiplier() * getStreakMultiplier();
  // Volatility-adaptive sizing (high ATR coin → smaller position)
  size = size * (await getVolatilityMultiplier(signal.coin));
  const positionSize = size * leverage;
  const liquidationPct = 1 / leverage * 0.8;
  const liquidationPrice = signal.direction === 'long'
    ? signal.entry * (1 - liquidationPct)
    : signal.entry * (1 + liquidationPct);

  const trade = {
    id: `t_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    coin: signal.coin,
    direction: signal.direction,
    entry: signal.entry,
    target: signal.target,
    stopLoss: signal.stopLoss,
    leverage,
    size,
    positionSize,
    liquidationPrice: parseFloat(liquidationPrice.toFixed(2)),
    confidence: signal.confidence,
    caller: signal.caller,
    groupName: signal.groupName,
    openTime: Date.now(),
    status: 'open',
    pnl: 0,
    useBinance: false,
    tradeMode: signal.tradeMode || 'normal',
    qualityGrade: signal.qualityGrade || null,
    swarmVotes: signal.swarmVotes || null,
    advisorId: signal.advisorId || null,
    isAdvisorTrade: signal.isAdvisorTrade || false,
    origTp: signal.target ?? null,
    origSl: signal.stopLoss ?? null,
    advisorCallId: signal.advisorCallId || null,
    trailingLevels: signal.trailingLevels || [],
    partialTp: signal.partialTp || 1.0,
    partialTpDone: false
  };

  // Use Binance testnet if configured AND coin is supported
  if (isBinanceTestnet() && isSupportedOnTestnet(signal.coin)) {
    try {
      const order = await openBinancePosition(signal);
      if (order?.orderId) {
        trade.binanceOrderId = order.orderId;
        trade.binanceSymbol = order.symbol;
        trade.binanceSide = order.side;
        trade.binanceQty = order.quantity;
        trade.useBinance = true;
        // Use ACTUAL leverage from Binance, not what we requested
        if (order.leverage && order.leverage !== leverage) {
          trade.leverage = order.leverage;
          trade.positionSize = trade.size * order.leverage;
          console.log(`📊 Trade leverage updated to actual: ${order.leverage}x (was ${leverage}x)`);
        }
        console.log(`🔗 Linked to Binance testnet order ${order.orderId}`);
      }
    } catch(e) {
      console.error('Binance open error:', e.message);
    }
  } else if (isBinanceTestnet() && !isSupportedOnTestnet(signal.coin)) {
    console.log(`ℹ️ ${signal.coin} not on Binance testnet — paper trade only`);
  }

  pd.trades.push(trade);
  savePaperTrades(pd);
  console.log(`📝 Paper trade opened: ${signal.direction} ${signal.coin} at $${signal.entry} ${leverage}x | Liq: $${liquidationPrice.toFixed(2)}${trade.useBinance ? ' [Binance Testnet]' : ''}`);

  const msg = `📝 Paper Trade Opened${trade.useBinance ? ' [Binance Testnet]' : ''}\n${signal.direction?.toUpperCase()} ${signal.coin} ${leverage}x\nEntry: $${signal.entry}\nTarget: $${signal.target}\nSL: $${signal.stopLoss}\nLiq: $${liquidationPrice.toFixed(2)}\nSize: $${size}\nConfidence: ${signal.confidence}%\nSource: ${signal.caller}`;
  sendTelegramNotification(msg);

  if (mainWindow) mainWindow.webContents.send('trade-opened', trade);
  return trade;
}

// ── loadPaperTrades ──
function loadPaperTrades() {
  return loadJSON(PAPER_TRADES_FILE, {
    balance: PAPER_BALANCE,
    trades: [],
    stats: { wins: 0, losses: 0, totalPnl: 0 }
  });
}

// ── savePaperTrades ──
function savePaperTrades(d) { saveJSON(PAPER_TRADES_FILE, d); }

// ── checkPaperTrades ──
async function checkPaperTrades() {
  const pd = loadPaperTrades();
  const openTrades = pd.trades.filter(t => t.status === 'open');
  if (!openTrades.length) return;

  for (const trade of openTrades) {
    try {
      const priceStr = await getCryptoPrice(trade.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (!priceMatch) continue;
      const currentPrice = parseFloat(priceMatch[1].replace(',', ''));
      if (isNaN(currentPrice)) continue;

      // Calculate unrealized P&L
      const leverage = trade.leverage || 1;
      const priceDiff = trade.direction === 'long'
        ? currentPrice - trade.entry
        : trade.entry - currentPrice;
      const pnlPct = priceDiff / trade.entry * leverage * 100;
      const pnlDollar = trade.size * (priceDiff / trade.entry) * leverage;

      // Precision measurement: max favorable / adverse excursion
      if (trade.mfe === undefined || pnlPct > trade.mfe) { trade.mfe = parseFloat(pnlPct.toFixed(2)); trade._dirty = true; }
      if (trade.mae === undefined || pnlPct < trade.mae) { trade.mae = parseFloat(pnlPct.toFixed(2)); trade._dirty = true; }

      // ── AUTO-BREAKEVEN: once the trade is up by the user's % , move SL to entry ──
      // GMGN-style trailing stop: SL follows the high-water mark
      if (trade.trailingPct) {
        if (trade.direction === 'LONG') {
          trade._high = Math.max(trade._high || trade.entry, price);
          const trailSL = trade._high * (1 - trade.trailingPct / 100);
          if (!trade.sl || trailSL > trade.sl) trade.sl = +trailSL.toFixed(8);
        } else {
          trade._low = Math.min(trade._low || trade.entry, price);
          const trailSL = trade._low * (1 + trade.trailingPct / 100);
          if (!trade.sl || trailSL < trade.sl) trade.sl = +trailSL.toFixed(8);
        }
      }
      if (trade.autoBreakevenPct && !trade._breakevenDone && pnlPct >= trade.autoBreakevenPct) {
        const pd3 = loadPaperTrades();
        const t3 = pd3.trades.find(tr => tr.id === trade.id);
        if (t3) {
          t3.stopLoss = t3.entry; t3._breakevenDone = true; savePaperTrades(pd3);
          sendTelegramNotification(`🛡️ ${trade.coin}: up ${trade.autoBreakevenPct}% — stop moved to breakeven (entry $${trade.entry}). Risk-free now.`).catch(()=>{});
          console.log(`🛡️ Auto-breakeven: ${trade.coin} SL → entry at +${trade.autoBreakevenPct}%`);
        }
      }

      // Profit notifications at milestones
      const profitMilestones = [5, 10, 25, 50, 100];
      const lastProfitNotified = trade.lastProfitNotify || 0;
      for (const milestone of profitMilestones) {
        if (pnlPct >= milestone && lastProfitNotified < milestone) {
          const msg = `📈 Profit Alert!\n${trade.direction?.toUpperCase()} ${trade.coin} ${leverage}x\nUp ${milestone}% — +$${pnlDollar.toFixed(2)}\nCurrent: $${currentPrice} | Entry: $${trade.entry}`;
          console.log(`💰 Profit milestone: ${milestone}% on ${trade.coin}`);
          sendTelegramNotification(msg);
          sendIntelEvent({ type: 'signal', source: 'Paper Trade', body: `${trade.coin} up ${milestone}% — +$${pnlDollar.toFixed(2)}`, note: `Current: $${currentPrice}`, action: `${milestone}% Profit 🎯`, notify: true });
          const pd2 = loadPaperTrades();
          const t2 = pd2.trades.find(tr => tr.id === trade.id);
          if (t2) { t2.lastProfitNotify = milestone; savePaperTrades(pd2); }
          break;
        }
      }

      // Loss notifications at milestones
      const lossMilestones = [1, 2, 3, 5, 10];
      const lastLossNotified = trade.lastLossNotify || 0;
      const lossPct = -pnlPct; // positive = losing
      for (const milestone of lossMilestones) {
        if (lossPct >= milestone && lastLossNotified < milestone) {
          const settings = loadSettings();
          const maxDrawdown = settings.maxDrawdown || null;
          
          // Check if should auto-close
          if (maxDrawdown && lossPct >= maxDrawdown) {
            console.log(`🛑 Max drawdown ${maxDrawdown}% hit on ${trade.coin} — auto closing`);
            closePaperTrade(trade.id, currentPrice, `max drawdown ${maxDrawdown}% hit`);
            break;
          }
          
          const msg = `⚠️ Loss Alert!\n${trade.direction?.toUpperCase()} ${trade.coin} ${leverage}x\nDown ${milestone}% — -$${Math.abs(pnlDollar).toFixed(2)}\nCurrent: $${currentPrice} | Entry: $${trade.entry}`;
          console.log(`📉 Loss milestone: ${milestone}% on ${trade.coin}`);
          sendTelegramNotification(msg);
          sendIntelEvent({ type: 'warning', source: 'Paper Trade', body: `${trade.coin} down ${milestone}% — -$${Math.abs(pnlDollar).toFixed(2)}`, note: `Current: $${currentPrice} | Entry: $${trade.entry}`, action: `⚠️ ${milestone}% Loss`, notify: true });
          const pd3 = loadPaperTrades();
          const t3 = pd3.trades.find(tr => tr.id === trade.id);
          if (t3) { t3.lastLossNotify = milestone; savePaperTrades(pd3); }
          break;
        }
      }

      // Sanity check — price shouldn't differ more than 80% from entry
      // For tiny prices (PEPE etc), use wider tolerance
      const priceDiffPct = Math.abs(currentPrice - trade.entry) / trade.entry * 100;
      const maxDiff = trade.entry < 0.001 ? 90 : 50; // wider for micro-cap
      if (priceDiffPct > maxDiff) {
        console.log(`⚠️ Price sanity fail for ${trade.coin}: entry $${trade.entry}, current $${currentPrice} (${priceDiffPct.toFixed(0)}% diff > ${maxDiff}%) — bad data, skipping`);
        continue;
      }

      // Partial TP — close portion at target
      if (!trade.partialTpDone && trade.partialTp && trade.partialTp < 1) {
        const hitTarget = trade.direction === 'long'
          ? currentPrice >= trade.target
          : currentPrice <= trade.target;
        if (hitTarget) {
          // Close partial position
          console.log(`💰 Partial TP hit: closing ${trade.partialTp * 100}% of ${trade.coin} position`);
          const partialPnl = pnlDollar * trade.partialTp;
          sendTelegramNotification(`💰 Partial TP Hit!\n${trade.direction?.toUpperCase()} ${trade.coin}\nClosed ${trade.partialTp * 100}% at $${currentPrice}\nLocked profit: +$${partialPnl.toFixed(2)}\nLetting remaining ${(1-trade.partialTp)*100}% run...`);
          const pd3 = loadPaperTrades();
          const t3 = pd3.trades.find(tr => tr.id === trade.id);
          if (t3) {
            t3.partialTpDone = true;
            t3.size = t3.size * (1 - trade.partialTp); // Reduce size
            // Move SL to entry (free trade)
            t3.stopLoss = trade.direction === 'long'
              ? Math.max(t3.stopLoss || 0, trade.entry)
              : Math.min(t3.stopLoss || Infinity, trade.entry);
            savePaperTrades(pd3);
          }
          continue; // Don't close fully yet
        }
      }

      // Check liquidation first
      if (trade.liquidationPrice) {
        if (trade.direction === 'long' && currentPrice <= trade.liquidationPrice) {
          closePaperTrade(trade.id, currentPrice, 'liquidated'); continue;
        }
        if (trade.direction === 'short' && currentPrice >= trade.liquidationPrice) {
          closePaperTrade(trade.id, currentPrice, 'liquidated'); continue;
        }
      }

      // Check target and stop loss
      if (trade.direction === 'long') {
        if (currentPrice >= trade.target) closePaperTrade(trade.id, currentPrice, 'target hit');
        else if (currentPrice <= trade.stopLoss) closePaperTrade(trade.id, currentPrice, 'stop loss hit');
      } else {
        if (currentPrice <= trade.target) closePaperTrade(trade.id, currentPrice, 'target hit');
        else if (currentPrice >= trade.stopLoss) closePaperTrade(trade.id, currentPrice, 'stop loss hit');
      }

      // Stagnant exit — main trades going nowhere lock capital
      if (trade.tradeMode !== 'scalp') {
        const stagnantHours = 18;
        const ageMs = Date.now() - trade.openTime;
        if (ageMs > stagnantHours * 60 * 60 * 1000 && Math.abs(pnlPct) < 1) {
          console.log(`💤 ${trade.coin} stagnant ${stagnantHours}h+ (${pnlPct.toFixed(2)}%) — freeing capital`);
          closePaperTrade(trade.id, currentPrice, `stagnant ${stagnantHours}h — freeing capital`);
          continue;
        }
      }

      // Auto close after 7 days
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - trade.openTime > sevenDays) {
        closePaperTrade(trade.id, currentPrice, 'expired');
      }
    } catch(e) { console.error('Paper trade check error:', e.message); }
  }

  // Persist MFE/MAE updates (atomic write, cheap)
  try {
    if (pd.trades.some(t => t._dirty)) {
      pd.trades.forEach(t => delete t._dirty);
      savePaperTrades(pd);
    }
  } catch(e) {}

  // Resolve shadow trades (throttled to every 10 min internally)
  resolveShadowTrades().catch(() => {});
}

// ── trackAPICall ──
function trackAPICall(model) {
  const cost = model === 'haiku' ? HAIKU_COST_PER_CALL : SONNET_COST_PER_CALL
  _devCostToday += cost
  _devCostMonth += cost
  _devApiCallCount[model] = (_devApiCallCount[model] || 0) + 1
}


// ── getEffectiveScanInterval ──
function getEffectiveScanInterval() {
  const dev = getDevOverrides();
  if (dev.intervalOverride) return dev.intervalOverride;
  const settings = loadSettings();
  const userInterval = settings.scanIntervalMinutes || 30;
  const tier = getUserTier();
  const tierMin = tier.scan_interval || 30; // tier defines FASTEST allowed
  return Math.max(userInterval, tierMin);
}


// ── getUserTier ──
function getUserTier() {
  const config = loadUserConfig();
  if (config.day_pass_until && Date.now() < config.day_pass_until) return { ...TIERS.degen, isDayPass:true };
  return TIERS[config.tier] || TIERS.pro;
}


// ── loadUserConfig ──
function loadUserConfig() {
  return loadJSON(USER_CONFIG_FILE, { tier:'pro', auto_extend:false, extra_voice:0, day_pass_until:null });
}


// ── USER_CONFIG_FILE ──
const USER_CONFIG_FILE = path.join(DATA_DIR, 'user-config.json');


// ── TIERS ──
const TIERS = {
  starter: { name:'Starter', price_annual:149, voice_per_day:50, scan_interval:30, scalp_enabled:false, mirofish_agents:10 },
  pro:     { name:'Pro',     price_annual:249, voice_per_day:200, scan_interval:15, scalp_enabled:true, mirofish_agents:20 },
  degen:   { name:'Degen',   price_annual:399, voice_per_day:999999, scan_interval:5, scalp_enabled:true, mirofish_agents:30 },
};


// ═══════════════════════════════════════════════════════════════════
// 🌐 API — what the Mac & phone apps call
// ═══════════════════════════════════════════════════════════════════
const DEV_PANEL_HTML = (() => { try { return fs.readFileSync(path.join(__dirname, 'dev-panel.html'), 'utf8'); } catch (e) { return '<h1>dev-panel.html missing</h1>'; } })();

const api = express();
api.use(express.json());
api.get('/health', (req, res) => res.json({ ok: true, brain: 'asuka', up: process.uptime() }));
api.get('/signals', (req, res) => { try { res.json(loadDailySignals()); } catch (e) { res.json({ signals: [] }); } });
api.get('/trades', (req, res) => { try { res.json(loadPaperTrades()); } catch (e) { res.json({ trades: [] }); } });
api.get('/stats', (req, res) => {
  try { const pd = loadPaperTrades(); const closed = (pd.trades||[]).filter(t => t.closed || ['closed','win','loss'].includes(t.status));
    res.json({ balance: pd.balance ?? 100000, totalTrades: (pd.trades||[]).length, closed: closed.length,
      wins: closed.filter(t => (t.pnl||0) > 0).length }); } catch (e) { res.json({}); }
});
// ═══════════════════════════════════════════════════════════════════
// 🔒 SECURITY — admin token gate + rate limiting for /dev
// ═══════════════════════════════════════════════════════════════════
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
if (!ADMIN_TOKEN) console.warn('⚠️  ADMIN_TOKEN not set in .env — /dev routes are DISABLED until you set it.');

// simple in-memory rate limiter: max 8 failed auths per IP per 5 min → 15-min ban
const _authFails = {};
function rateLimited(ip) {
  const now = Date.now(); const rec = _authFails[ip];
  if (rec && rec.bannedUntil && now < rec.bannedUntil) return true;
  return false;
}
function noteFail(ip) {
  const now = Date.now(); const rec = _authFails[ip] || { count: 0, first: now };
  if (now - rec.first > 5 * 60 * 1000) { rec.count = 0; rec.first = now; }
  rec.count++;
  if (rec.count >= 8) rec.bannedUntil = now + 15 * 60 * 1000;
  _authFails[ip] = rec;
}
function requireAdmin(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts — try again later.' });
  if (!ADMIN_TOKEN) return res.status(503).json({ error: 'Admin disabled: no token configured on server.' });
  const sent = req.headers['x-admin-token'] || req.query.token || (req.body && req.body.token);
  // constant-time-ish compare
  if (typeof sent !== 'string' || sent.length !== ADMIN_TOKEN.length) { noteFail(ip); return res.status(403).json({ error: 'Forbidden' }); }
  let diff = 0; for (let i = 0; i < ADMIN_TOKEN.length; i++) diff |= sent.charCodeAt(i) ^ ADMIN_TOKEN.charCodeAt(i);
  if (diff !== 0) { noteFail(ip); return res.status(403).json({ error: 'Forbidden' }); }
  next();
}

// ── admin dev endpoints ──
api.post('/dev/verify', requireAdmin, (req, res) => res.json({ ok: true }));
api.get('/dev/state', requireAdmin, (req, res) => {
  const ov = getDevOverrides();
  res.json({ overrides: ov, pauseMain: !!ov.pauseMain, pauseScalp: !!ov.pauseScalp, coinOverride: ov.coinOverride || 'all', uptime: process.uptime() });
});
api.post('/dev/pause', requireAdmin, (req, res) => {
  const ov = getDevOverrides();
  if (typeof req.body.pauseMain === 'boolean') ov.pauseMain = req.body.pauseMain;
  if (typeof req.body.pauseScalp === 'boolean') ov.pauseScalp = req.body.pauseScalp;
  setDevOverrides(ov); res.json({ ok: true, overrides: ov });
});
api.post('/dev/override', requireAdmin, (req, res) => {
  const ov = getDevOverrides();
  if (typeof req.body.coinOverride === 'string') ov.coinOverride = req.body.coinOverride.trim() || 'all';
  setDevOverrides(ov); res.json({ ok: true, overrides: ov });
});
api.get('/dev/stats', requireAdmin, (req, res) => {
  try { const pd = loadPaperTrades(); const sig = loadDailySignals();
    res.json({ balance: pd.balance ?? 100000, openTrades: (pd.trades||[]).filter(t=>!t.closed).length,
      totalTrades: (pd.trades||[]).length, signals: Object.keys(sig.signals||{}).length, uptime: process.uptime() });
  } catch (e) { res.json({ error: e.message }); }
});

// ── login-gated control panel (served at /dev) ──
api.get('/dev', (req, res) => res.type('html').send(DEV_PANEL_HTML));

// ═══════════════════════════════════════════════════════════════════
// 🎟️ CREDITS + 🤖 AI-PROXY — app AI calls route here so we can meter them.
// The user's app sends: x-user-id header (real id once Google login lands).
// Every AI call: check credits → call Claude with the vault key → charge.
// ═══════════════════════════════════════════════════════════════════
// balance + config (read) — app shows the user their credits
api.get('/credits/balance', authOptional, async (req, res) => {
  try { res.json(await credits.balance(userIdOf(req))); } catch (e) { res.status(500).json({ error: e.message }); }
});
api.get('/credits/config', (req, res) => {
  try { const c = credits.getConfig(); res.json({ tiers: c.tiers, actionCosts: c.actionCosts, topupPacks: c.topupPacks }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// after a successful purchase (wired to payment later) — add topup / set tier
api.post('/credits/topup', requireAdmin, async (req, res) => {
  try { res.json(await credits.addTopup(req.body.userId, Number(req.body.credits) || 0)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
api.post('/credits/set-tier', requireAdmin, async (req, res) => {
  try { res.json(await credits.setTier(req.body.userId, req.body.tier)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 🤖 the proxy: app → here → Claude. Charges credits per call.
api.post('/ai/chat', authRequired, async (req, res) => {
  const uid = userIdOf(req);
  const { messages, system, model, action, units } = req.body || {};
  const act = action || 'chat';
  const pre = await credits.check(uid, act, units || 1);
  if (!pre.ok) return res.status(402).json({ error: pre.reason, message: pre.message, balance: await credits.balance(uid) });
  try {
    const resp = await anthropic.messages.create({
      model: model || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: system || undefined,
      messages: messages || [{ role: 'user', content: 'Hello' }],
    });
    await credits.charge(uid, act, units || 1);   // only charge on success
    res.json({ content: resp.content, balance: await credits.balance(uid) });
  } catch (e) {
    res.status(500).json({ error: 'ai_failed', detail: e.message });   // no charge on failure
  }
});

// ── 🔊 VOICE PROXY — metered ElevenLabs TTS, server-side key ──
// App sends { text, personality? } → we synthesize with OUR key, charge
// voice credits, return base64 mp3. Keeps the voice key off every device.
api.post('/ai/voice', authRequired, async (req, res) => {
  const uid = userIdOf(req);
  const { text, personality, character, voiceId: reqVoiceId } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'no_text' });

  // voice billed per ~word-block; ~1 unit per 200 chars, min 1
  const units = Math.max(1, Math.ceil(text.length / 200));
  const pre = await credits.check(uid, 'voice_minute', units);
  if (!pre.ok) return res.status(402).json({ error: pre.reason, message: pre.message, balance: await credits.balance(uid) });

  try {
    const apiKey = await getSecret('ELEVENLABS_API_KEY').catch(() => process.env.ELEVENLABS_API_KEY);
    // pick the voice: explicit voiceId → per-character env (VOICE_ID_<CHARACTER>) → default
    let voiceId = reqVoiceId
      || (character && process.env['VOICE_ID_' + String(character).toUpperCase()])
      || process.env.VOICE_ID
      || 'TmK7x2BFDD7TOVlR69J2';
    if (!apiKey) return res.status(500).json({ error: 'voice_unavailable' });

    const isMommy = personality === 'mommy';
    const body = JSON.stringify({
      text: text.trim().slice(0, 800),
      model_id: 'eleven_flash_v2_5',
      output_format: 'mp3_22050_32',
      voice_settings: isMommy
        ? { stability: 0.75, similarity_boost: 0.85, style: 0.25, speed: 0.88 }
        : { stability: 0.4, similarity_boost: 0.8, speed: 1.0 },
    });

    const audio = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.elevenlabs.io', path: `/v1/text-to-speech/${voiceId}`, method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      }, (r2) => {
        const chunks = [];
        r2.on('data', c => chunks.push(c));
        r2.on('end', () => r2.statusCode === 200 ? resolve(Buffer.concat(chunks).toString('base64')) : reject(new Error('el status ' + r2.statusCode)));
      });
      r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('voice timeout')); });
      r.write(body); r.end();
    });

    await credits.charge(uid, 'voice_minute', units);   // charge only on success
    res.json({ audio, balance: await credits.balance(uid) });
  } catch (e) {
    res.status(500).json({ error: 'voice_failed', detail: e.message });   // no charge on failure
  }
});

// ═══════════════════════════════════════════════════════════════════
// ☁️ STATE SYNC — Asuka's soul, one record per user, shared PC ↔ phone.
// Stores memory, bond, tier, coins, level, streaks, personality, lessons.
// Now backed by POSTGRES (asuka_state table) via db.js — synced PC ↔ phone.
// GET  /state        → the user's full state (empty defaults on first call)
// PUT  /state        → replace (last-write-wins with client timestamp)
// PATCH /state       → merge a few fields (bond +1, coins -50, etc.)
// ═══════════════════════════════════════════════════════════════════
const db = require('./db');
db.initDB();   // ensure tables exist on boot

api.get('/state', authRequired, async (req, res) => {
  try {
    await db.upsertUser(req.user.userId, req.user.email, req.user.name);
    const state = await db.getAsukaState(req.user.userId);
    res.json(state);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
api.put('/state', authRequired, async (req, res) => {
  try {
    const incoming = req.body || {};
    await db.upsertUser(req.user.userId, req.user.email, req.user.name);
    const cur = await db.getAsukaState(req.user.userId);
    // last-write-wins: reject if client state is older than server (unless force)
    if (!incoming.force && incoming.updatedAt && cur.updatedAt && incoming.updatedAt < cur.updatedAt) {
      return res.status(409).json({ error: 'stale', server: cur });
    }
    const next = { ...incoming }; delete next.force;
    const saved = await db.saveAsukaState(req.user.userId, next);
    res.json({ ok: true, state: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
api.patch('/state', authRequired, async (req, res) => {
  try {
    await db.upsertUser(req.user.userId, req.user.email, req.user.name);
    const saved = await db.patchAsukaState(req.user.userId, req.body || {});
    res.json({ ok: true, state: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 🌱 Clarity wellness routes (Asuka-powered, replaces Groq coach) ──
async function callAsuka(system, userMsg, maxTokens = 1000) {
  const res = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userMsg }],
  });
  return (res.content || []).map(b => b.text || '').join('');
}
try {
  require('./clarity-routes').register(api, { authRequired, callAsuka });
} catch (e) { console.error('clarity-routes register failed:', e.message); }

const PORT = process.env.PORT || 3000;
api.listen(PORT, () => console.log(`🌐 API on :${PORT}`));

// ═══════════════════════════════════════════════════════════════════
// ⏰ SCHEDULERS — the 3 tiers
// ═══════════════════════════════════════════════════════════════════
console.log('🧠 Asuka scanner brain starting…');
startIndependentScanner();          // Main tier (30-min) + scalp cadence inside
scheduleDailyTradeBot();            // Daily RSI at 00:05 UTC
setInterval(() => { checkPaperTrades().catch(()=>{}); }, 60 * 1000);  // TP/SL monitor
console.log('✅ All tiers scheduled.');
