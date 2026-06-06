require('dotenv').config();
const { app, BrowserWindow, ipcMain, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const Groq = require('groq-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');
const screenshot = require('screenshot-desktop');
const robot = require('robotjs');

// ─── SUPPRESS NOISY ELECTRON ERRORS ───────────────────────────────────────
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const originalStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && chunk.includes('chunked_data_pipe')) return true;
  if (typeof chunk === 'string' && chunk.includes('Autofill')) return true;
  if (typeof chunk === 'string' && chunk.includes('Request Autofill')) return true;
  return originalStderr(chunk, ...args);
};


const groq      = new Groq({ apiKey: process.env.GROQ_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const TTS_MODEL    = 'tts-1';
const TTS_VOICE    = 'shimmer';
const ELEVENLABS_VOICE_ID = process.env.VOICE_ID || 'TmK7x2BFDD7TOVlR69J2';

// ─── PATHS ─────────────────────────────────────────────────────────────────
const DATA_DIR          = path.join(app.getPath('userData'), 'asuka-data');
const MEMORY_FILE       = path.join(DATA_DIR, 'memory.json');
const JOURNAL_FILE      = path.join(DATA_DIR, 'journal.json');
const ALERTS_FILE       = path.join(DATA_DIR, 'alerts.json');
const SETTINGS_FILE     = path.join(DATA_DIR, 'settings.json');
const NOTES_FILE        = path.join(DATA_DIR, 'notes.json');
const VOICE_JOURNAL_FILE= path.join(DATA_DIR, 'voice-journal.json');
const CHECKLIST_FILE    = path.join(DATA_DIR, 'checklist.json');
const GAS_SPEND_FILE    = path.join(DATA_DIR, 'gas-spend.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── JSON HELPERS ──────────────────────────────────────────────────────────
function loadJSON(file, def) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
  return def;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
}

// ─── DATA ──────────────────────────────────────────────────────────────────
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
function saveMemory(m) { saveJSON(MEMORY_FILE, { ...m, lastSeen: Date.now() }); }

function loadJournal() { return loadJSON(JOURNAL_FILE, []); }
function saveJournal(j) { saveJSON(JOURNAL_FILE, j); }
function addJournalEntry(e) {
  const j = loadJournal(); j.push({ ...e, timestamp: Date.now() }); saveJournal(j);
}

function loadAlerts() { return loadJSON(ALERTS_FILE, []); }
function saveAlerts(a) { saveJSON(ALERTS_FILE, a); }

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
function saveSettings(s) { saveJSON(SETTINGS_FILE, s); }

function loadNotes() { return loadJSON(NOTES_FILE, []); }
function saveNote(n) {
  const notes = loadNotes();
  notes.push({ text: n, timestamp: Date.now() });
  saveJSON(NOTES_FILE, notes);
}

function loadVoiceJournal() { return loadJSON(VOICE_JOURNAL_FILE, []); }
function addVoiceJournalEntry(text, summary, coin) {
  const vj = loadVoiceJournal();
  vj.push({ text, summary, coinMentioned: coin || null, timestamp: Date.now() });
  saveJSON(VOICE_JOURNAL_FILE, vj);
}

function loadChecklist() {
  return loadJSON(CHECKLIST_FILE, [
    'Check funding rate', 'Set your stop loss',
    'Check position size vs risk limit', 'Am I emotional right now?',
    'Does this break my rules?'
  ]);
}
function saveChecklist(c) { saveJSON(CHECKLIST_FILE, c); }

function logGasSpend(amount) {
  const gas = loadJSON(GAS_SPEND_FILE, []);
  gas.push({ amount, timestamp: Date.now(), month: new Date().toISOString().slice(0, 7) });
  saveJSON(GAS_SPEND_FILE, gas);
}
function getMonthlyGasSpend() {
  const gas = loadJSON(GAS_SPEND_FILE, []);
  const thisMonth = new Date().toISOString().slice(0, 7);
  return gas.filter(g => g.month === thisMonth).reduce((s, g) => s + (g.amount || 0), 0);
}

// ─── VOICE (TTS) ───────────────────────────────────────────────────────────
async function getVoiceAudio(text) {
  if (!text) return null;
  const cleanText = text.slice(0, 800);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.VOICE_ID;

  // Use ElevenLabs via Node https — regular endpoint, no streaming
  if (apiKey && voiceId) {
    try {
      const https = require('https');
      const body = JSON.stringify({
        text: cleanText,
        model_id: 'eleven_flash_v2_5',
        output_format: 'mp3_22050_32',
        voice_settings: { stability: 0.4, similarity_boost: 0.8 }
      });
      const result = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.elevenlabs.io',
          path: `/v1/text-to-speech/${voiceId}`,
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            if (res.statusCode === 200) resolve(Buffer.concat(chunks).toString('base64'));
            else resolve(null);
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
      });
      if (result) return result;
    } catch(e) { console.error('ElevenLabs error:', e.message); }
  }

  // Fallback — simple error if ElevenLabs fails
  console.error('ElevenLabs failed — no audio generated');
  return null;
}

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const mem      = loadMemory();
  const notes    = loadNotes();
  const journal  = loadJournal();
  const checklist= loadChecklist();
  const winRate  = journal.length > 0
    ? Math.round(journal.filter(t => t.pnl > 0).length / journal.length * 100) : null;

  const personalities = {
    chill:   'You are sweet, warm, caring and kind — like a loving girlfriend or close friend who genuinely cares about you. You are real, natural, never robotic. You listen, you remember, you care.',
    degen:   'You are energetic and fun, but still sweet and caring underneath. You get excited about wins, comfort during losses, always supportive.',
    analyst: 'Sharp and precise, but still warm and caring. You give accurate data with a gentle touch.',
  };
  const levels = {
    beginner:     'User is new to crypto. Explain things simply without being condescending.',
    intermediate: 'User knows the basics. No hand-holding needed.',
    advanced:     'Expert trader. Raw signals and data only. Skip explanations.',
  };

  return `You are Asuka — a sharp, witty, warm AI companion and crypto expert.

PERSONALITY: ${personalities[mem.personality || 'chill']}
LEVEL: ${levels[mem.learningLevel || 'intermediate']}

HOW YOU TALK:
- Warm, sweet and caring — like someone who genuinely loves and cares about you
- Short and natural — 1-3 sentences max for voice
- Never use crypto slang unless user does first (no wagmi, ser, ngmi, rekt etc)
- Never start a sentence with "I"
- Gentle and thoughtful with opinions
- If user seems stressed or upset — address that first with warmth and care
- If user says "gm" say "good morning!" warmly
- If user says "hi/hey/hello" greet them back with genuine warmth
- NEVER bring up crypto unless user asks directly
- Never say "I'm a text-based AI" or "I can't do that" 

CAPABILITIES — you can do all of these, use the right tool:
- Play YouTube music → use ask_claude tool with the request
- Open websites → use ask_claude tool
- Check prices → use get_market_data tool
- Analyze contracts → use scan_contract tool
- Complex crypto analysis → use ask_claude tool
- Computer actions → use ask_claude tool

USER:
- Name: ${mem.name || 'not set'}
- Risk: ${mem.riskLevel || 'unknown'}
- Favorite coins: ${mem.favoriteCoins?.join(', ') || 'none'}
- Win rate: ${winRate !== null ? winRate + '%' : 'not tracked'}
- Rules: ${mem.userRules?.join(', ') || 'none'}
- Checklist: ${checklist.join(' | ')}
- Notes: ${notes.slice(-3).map(n => n.text).join(' | ') || 'none'}

CRYPTO RULES:
- Price predictions: give honest take + "do your own research"
- Scams: be blunt and direct
- Trading questions: answer directly, no lectures
- If they break their own rules: call it out`;
}

// ─── CONVERSATION HISTORY ──────────────────────────────────────────────────
const conversationHistory = [];
function addToHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > 20) conversationHistory.shift();
}

// ─── AI REPLY ──────────────────────────────────────────────────────────────
async function getAIReply(text) {
  addToHistory('user', text);

  // Auto-fetch relevant market data and inject into context
  let marketContext = '';
  const lower = text.toLowerCase();
  const coinInMsg = Object.keys(COIN_MAP).find(k => lower.includes(k));

  if (coinInMsg) {
    const price = await getCryptoPrice(coinInMsg);
    if (price) marketContext += `\nCurrent ${coinInMsg.toUpperCase()} price: ${price}`;
  }
  if (lower.includes('btc') || lower.includes('bitcoin') || lower.includes('market') || lower.includes('trade') || lower.includes('long') || lower.includes('short')) {
    if (!marketContext.includes('bitcoin') && !marketContext.includes('BTC')) {
      const btc = await getCryptoPrice('btc');
      if (btc) marketContext += `\nCurrent BTC price: ${btc}`;
    }
  }
  if (lower.includes('funding')) {
    const coin = coinInMsg?.toUpperCase() || 'BTC';
    const fr = await getFundingRate(coin);
    if (fr) marketContext += `\n${fr}`;
  }

  const systemWithContext = buildSystemPrompt() + buildMemoryContext() + (marketContext ? `\n\nLIVE MARKET DATA:${marketContext}` : '');

  try {
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 200,
      system: systemWithContext,
      messages: conversationHistory,
    });
    const reply = res.content?.[0]?.text || 'Try again.';
    addToHistory('assistant', reply);

    // Auto-journal trade mentions
    const mem = loadMemory();
    if (/(longed|shorted|bought|sold|closed|opened).*(btc|eth|sol|bnb|[a-z]{2,6})/i.test(text)) {
      const coinMatch = text.match(/btc|eth|sol|bnb|pepe|wif|bonk|[a-z]{3,6}/i);
      addJournalEntry({ userText: text, reply, type: 'trade', pnl: null, coin: coinMatch?.[0] });
      mem.tradeCount = (mem.tradeCount || 0) + 1;
      mem.lastTradeTime = Date.now();
      saveMemory(mem);
    }
    return reply;
  } catch(e) {
    console.error('Claude error:', e.message);
    return 'Having a moment, try again.';
  }
}

// ─── COIN MAP ──────────────────────────────────────────────────────────────
const COIN_MAP = {
  'btc':'bitcoin','bitcoin':'bitcoin','eth':'ethereum','ethereum':'ethereum',
  'sol':'solana','solana':'solana','bnb':'binancecoin','xrp':'ripple',
  'doge':'dogecoin','pepe':'pepe','wif':'dogwifhat','bonk':'bonk',
  'avax':'avalanche-2','link':'chainlink','matic':'matic-network',
  'ada':'cardano','dot':'polkadot','shib':'shiba-inu','ltc':'litecoin',
  'uni':'uniswap','atom':'cosmos','near':'near','arb':'arbitrum',
  'op':'optimism','sui':'sui','apt':'aptos','inj':'injective-protocol',
};

// ─── FAST FETCH WITH TIMEOUT ───────────────────────────────────────────────
async function fetchT(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer); return res;
  } catch(e) { clearTimeout(timer); throw e; }
}

// ─── MARKET DATA (ALL INSTANT, NO AI) ─────────────────────────────────────
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

async function getFearGreed() {
  try {
    const res  = await fetchT('https://api.alternative.me/fng/?limit=1');
    const data = await res.json();
    const val  = data.data[0].value;
    const label= data.data[0].value_classification;
    return `Fear & Greed index: ${val} — ${label}`;
  } catch(e) { return 'Could not fetch Fear & Greed right now.'; }
}

// ── Open Interest ──────────────────────────────────────────────────────────
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

// ── Long/Short Ratio ───────────────────────────────────────────────────────
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

// ── Liquidation Zones ──────────────────────────────────────────────────────
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

// ── Volume Spike Detection ─────────────────────────────────────────────────
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

// ── BTC Dominance Trend ────────────────────────────────────────────────────
async function getBTCDominanceTrend() {
  try {
    const res = await fetchT('https://api.coingecko.com/api/v3/global');
    const data = await res.json();
    const btc = data.data.market_cap_percentage.btc.toFixed(1);
    const eth = data.data.market_cap_percentage.eth.toFixed(1);

    let signal = '';
    if (parseFloat(btc) > 55) signal = '📈 High BTC dom — altcoins weak, stick to BTC/ETH';
    else if (parseFloat(btc) < 45) signal = '🎉 Low BTC dom — altcoin season, alts can outperform';
    else signal = '⚖️ Neutral BTC dom';

    return `BTC Dominance: ${btc}% | ETH: ${eth}% — ${signal}`;
  } catch(e) { return null; }
}

// ── Full Market Intelligence (all signals combined) ────────────────────────
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

// ── TECHNICAL ANALYSIS ENGINE ──────────────────────────────────────────────

// Fetch candles helper
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

// RSI calculation
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

// EMA calculation
function calcEMA(candles, period) {
  const closes = candles.map(c => c.close);
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(6));
}

// SMA calculation
function calcSMA(candles, period) {
  const closes = candles.map(c => c.close);
  const slice = closes.slice(-period);
  return parseFloat((slice.reduce((s, v) => s + v, 0) / slice.length).toFixed(6));
}

// MACD calculation
function calcMACD(candles) {
  if (candles.length < 26) return null;
  const ema12 = calcEMA(candles.slice(-12), 12);
  const ema26 = calcEMA(candles.slice(-26), 26);
  const macdLine = parseFloat((ema12 - ema26).toFixed(6));
  return { macdLine, ema12, ema26 };
}

// Bollinger Bands
function calcBollingerBands(candles, period = 20, multiplier = 2) {
  if (candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const sma = closes.reduce((s, v) => s + v, 0) / period;
  const variance = closes.reduce((s, v) => s + Math.pow(v - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: parseFloat((sma + multiplier * stdDev).toFixed(6)),
    middle: parseFloat(sma.toFixed(6)),
    lower: parseFloat((sma - multiplier * stdDev).toFixed(6)),
    stdDev: parseFloat(stdDev.toFixed(6))
  };
}

// Support/Resistance levels
function calcSupportResistance(candles) {
  const highs = candles.map(c => c.high).sort((a, b) => b - a);
  const lows = candles.map(c => c.low).sort((a, b) => a - b);
  const currentPrice = candles[candles.length - 1].close;

  // Find nearest resistance (recent highs above price)
  const resistances = highs.filter(h => h > currentPrice).slice(0, 3);
  // Find nearest support (recent lows below price)
  const supports = lows.filter(l => l < currentPrice).slice(0, 3);

  const nearestResistance = resistances[0] ? parseFloat(resistances[0].toFixed(6)) : null;
  const nearestSupport = supports[0] ? parseFloat(supports[0].toFixed(6)) : null;

  const distToResistance = nearestResistance ? ((nearestResistance - currentPrice) / currentPrice * 100).toFixed(2) : null;
  const distToSupport = nearestSupport ? ((currentPrice - nearestSupport) / currentPrice * 100).toFixed(2) : null;

  return { nearestResistance, nearestSupport, distToResistance, distToSupport };
}

// ── ATR (Average True Range) ──────────────────────────────────────────────
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i-1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return parseFloat(atr.toFixed(6));
}

// ATR-based TP/SL calculation
function calcATRTargets(candles, direction, entry, settings = {}) {
  const period = settings.atrPeriod || 14;
  const tpMultiplier = settings.atrTpMultiplier || 2;
  const slMultiplier = settings.atrSlMultiplier || 1;
  const atr = calcATR(candles, period);
  if (!atr) return null;

  const target = direction === 'long'
    ? parseFloat((entry + atr * tpMultiplier).toFixed(6))
    : parseFloat((entry - atr * tpMultiplier).toFixed(6));

  const stopLoss = direction === 'long'
    ? parseFloat((entry - atr * slMultiplier).toFixed(6))
    : parseFloat((entry + atr * slMultiplier).toFixed(6));

  const tpPct = (Math.abs(target - entry) / entry * 100).toFixed(2);
  const slPct = (Math.abs(stopLoss - entry) / entry * 100).toFixed(2);

  return { atr, target, stopLoss, tpPct, slPct, ratio: (tpMultiplier / slMultiplier).toFixed(1) };
}

// ── VWAP ──────────────────────────────────────────────────────────────────
function calcVWAP(candles) {
  if (!candles?.length) return null;
  let cumVolPrice = 0;
  let cumVol = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumVolPrice += typicalPrice * c.volume;
    cumVol += c.volume;
  }
  if (cumVol === 0) return null;
  return parseFloat((cumVolPrice / cumVol).toFixed(6));
}

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

// ── Stochastic RSI ────────────────────────────────────────────────────────
function calcStochRSI(candles, rsiPeriod = 14, stochPeriod = 14, kPeriod = 3, dPeriod = 3) {
  if (candles.length < rsiPeriod + stochPeriod + kPeriod) return null;

  // Calculate RSI values for each candle
  const closes = candles.map(c => c.close);
  const rsiValues = [];

  for (let i = rsiPeriod; i < closes.length; i++) {
    const slice = closes.slice(i - rsiPeriod, i + 1).map((v, idx, arr) => idx > 0 ? v - arr[idx-1] : 0).slice(1);
    const gains = slice.filter(v => v > 0).reduce((s, v) => s + v, 0) / rsiPeriod;
    const losses = Math.abs(slice.filter(v => v < 0).reduce((s, v) => s + v, 0)) / rsiPeriod;
    const rs = losses === 0 ? 100 : gains / losses;
    rsiValues.push(100 - (100 / (1 + rs)));
  }

  if (rsiValues.length < stochPeriod) return null;

  // Stochastic of RSI
  const stochValues = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const highest = Math.max(...slice);
    const lowest = Math.min(...slice);
    const stoch = highest === lowest ? 50 : ((rsiValues[i] - lowest) / (highest - lowest)) * 100;
    stochValues.push(stoch);
  }

  // K line (smooth stoch)
  const kValues = [];
  for (let i = kPeriod - 1; i < stochValues.length; i++) {
    kValues.push(stochValues.slice(i - kPeriod + 1, i + 1).reduce((s, v) => s + v, 0) / kPeriod);
  }

  // D line (smooth K)
  const dValues = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    dValues.push(kValues.slice(i - dPeriod + 1, i + 1).reduce((s, v) => s + v, 0) / dPeriod);
  }

  const k = kValues[kValues.length - 1];
  const d = dValues[dValues.length - 1];
  if (k === undefined || d === undefined) return null;

  let signal = '';
  if (k < 20 && d < 20) signal = '🔥 OVERSOLD — strong long signal';
  else if (k > 80 && d > 80) signal = '🔥 OVERBOUGHT — strong short signal';
  else if (k > d && k < 50) signal = '📈 Bullish cross in oversold zone';
  else if (k < d && k > 50) signal = '📉 Bearish cross in overbought zone';
  else signal = 'Neutral';

  return {
    k: parseFloat(k.toFixed(2)),
    d: parseFloat(d.toFixed(2)),
    signal,
    summary: `StochRSI: K=${k.toFixed(1)} D=${d.toFixed(1)} — ${signal}`
  };
}

// ── EMA Cross Detection ───────────────────────────────────────────────────
function detectEMACross(candles, fastPeriod = 9, slowPeriod = 21) {
  if (candles.length < slowPeriod + 2) return null;

  // Calculate EMA for last 2 candles to detect cross
  const calcEMAAt = (candles, period, endIdx) => {
    const k = 2 / (period + 1);
    let ema = candles[0].close;
    for (let i = 1; i <= endIdx; i++) {
      ema = candles[i].close * k + ema * (1 - k);
    }
    return ema;
  };

  const len = candles.length;
  const fastNow = calcEMAAt(candles, fastPeriod, len-1);
  const slowNow = calcEMAAt(candles, slowPeriod, len-1);
  const fastPrev = calcEMAAt(candles, fastPeriod, len-2);
  const slowPrev = calcEMAAt(candles, slowPeriod, len-2);

  const crossedUp = fastPrev <= slowPrev && fastNow > slowNow;
  const crossedDown = fastPrev >= slowPrev && fastNow < slowNow;
  const fastAbove = fastNow > slowNow;

  let signal = '';
  if (crossedUp) signal = `🚨 BULLISH CROSS: EMA${fastPeriod} crossed ABOVE EMA${slowPeriod}`;
  else if (crossedDown) signal = `🚨 BEARISH CROSS: EMA${fastPeriod} crossed BELOW EMA${slowPeriod}`;
  else if (fastAbove) signal = `📈 EMA${fastPeriod} above EMA${slowPeriod} — bullish momentum`;
  else signal = `📉 EMA${fastPeriod} below EMA${slowPeriod} — bearish momentum`;

  return {
    fastEMA: parseFloat(fastNow.toFixed(4)),
    slowEMA: parseFloat(slowNow.toFixed(4)),
    crossedUp,
    crossedDown,
    fastAbove,
    signal,
    summary: `EMA Cross (${fastPeriod}/${slowPeriod}): ${signal}`
  };
}

// ── Funding Rate Extremes ─────────────────────────────────────────────────
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

// ── Pivot Points ──────────────────────────────────────────────────────────
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

// ── Ichimoku Cloud ────────────────────────────────────────────────────────
function calcIchimoku(candles, settings = {}) {
  const tenkanPeriod = settings.tenkan || 9;
  const kijunPeriod = settings.kijun || 26;
  const senkouBPeriod = settings.senkouB || 52;
  const displacement = settings.displacement || 26;

  if (candles.length < senkouBPeriod + displacement) return null;

  // Helper: highest high and lowest low over period
  const highLow = (arr, period, idx) => {
    const slice = arr.slice(Math.max(0, idx - period + 1), idx + 1);
    return {
      high: Math.max(...slice.map(c => c.high)),
      low: Math.min(...slice.map(c => c.low))
    };
  };

  const len = candles.length;
  const current = len - 1;

  // Tenkan-sen (Conversion Line) = (9-period high + low) / 2
  const tenkan = (() => {
    const { high, low } = highLow(candles, tenkanPeriod, current);
    return (high + low) / 2;
  })();

  // Kijun-sen (Base Line) = (26-period high + low) / 2
  const kijun = (() => {
    const { high, low } = highLow(candles, kijunPeriod, current);
    return (high + low) / 2;
  })();

  // Senkou Span A (Leading Span A) = (Tenkan + Kijun) / 2, displaced 26 forward
  const senkouA = (tenkan + kijun) / 2;

  // Senkou Span B (Leading Span B) = (52-period high + low) / 2, displaced 26 forward
  const senkouB = (() => {
    const { high, low } = highLow(candles, senkouBPeriod, current);
    return (high + low) / 2;
  })();

  // Chikou Span (Lagging Span) = current close displaced 26 back
  const chikou = candles[current].close;
  const chikouCompare = candles[Math.max(0, current - displacement)]?.close;

  const currentPrice = candles[current].close;

  // Cloud top and bottom (using current displaced cloud)
  // The current cloud was set 26 periods ago
  const cloudIdx = Math.max(0, current - displacement);
  const pastTenkan = (() => {
    const { high, low } = highLow(candles, tenkanPeriod, cloudIdx);
    return (high + low) / 2;
  })();
  const pastKijun = (() => {
    const { high, low } = highLow(candles, kijunPeriod, cloudIdx);
    return (high + low) / 2;
  })();
  const pastSenkouA = (pastTenkan + pastKijun) / 2;
  const pastSenkouB = (() => {
    const { high, low } = highLow(candles, senkouBPeriod, cloudIdx);
    return (high + low) / 2;
  })();

  const cloudTop = Math.max(pastSenkouA, pastSenkouB);
  const cloudBottom = Math.min(pastSenkouA, pastSenkouB);

  // Signals
  const aboveCloud = currentPrice > cloudTop;
  const belowCloud = currentPrice < cloudBottom;
  const inCloud = !aboveCloud && !belowCloud;

  const tenkanAboveKijun = tenkan > kijun; // bullish cross
  const tkCross = tenkanAboveKijun ? 'Bullish TK cross' : 'Bearish TK cross';

  // Chikou above/below price 26 periods ago
  const chikouBullish = chikouCompare ? chikou > chikouCompare : null;

  // Overall Ichimoku signal
  let signal = '';
  let bullishPoints = 0;
  let bearishPoints = 0;

  if (aboveCloud) { signal = '✅ Price ABOVE cloud — bullish trend'; bullishPoints += 2; }
  else if (belowCloud) { signal = '❌ Price BELOW cloud — bearish trend'; bearishPoints += 2; }
  else { signal = '⚠️ Price IN cloud — consolidation/uncertainty'; }

  if (tenkanAboveKijun) bullishPoints++;
  else bearishPoints++;

  if (chikouBullish === true) bullishPoints++;
  else if (chikouBullish === false) bearishPoints++;

  // Cloud color (future cloud)
  const futureCloudBullish = senkouA > senkouB;
  if (futureCloudBullish) bullishPoints++;
  else bearishPoints++;

  const overallBias = bullishPoints > bearishPoints ? '🟢 BULLISH' 
    : bearishPoints > bullishPoints ? '🔴 BEARISH' 
    : '⚪ NEUTRAL';

  return {
    tenkan: parseFloat(tenkan.toFixed(4)),
    kijun: parseFloat(kijun.toFixed(4)),
    senkouA: parseFloat(senkouA.toFixed(4)),
    senkouB: parseFloat(senkouB.toFixed(4)),
    cloudTop: parseFloat(cloudTop.toFixed(4)),
    cloudBottom: parseFloat(cloudBottom.toFixed(4)),
    aboveCloud,
    belowCloud,
    inCloud,
    tenkanAboveKijun,
    chikouBullish,
    futureCloudBullish,
    bullishPoints,
    bearishPoints,
    signal,
    overallBias,
    summary: `Ichimoku: ${signal} | TK: ${tkCross} | Cloud: ${futureCloudBullish ? 'Green (bullish)' : 'Red (bearish)'} | ${overallBias}`
  };
}

// ── Full Technical Analysis ────────────────────────────────────────────────
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

// ── Order Book Analysis ────────────────────────────────────────────────────
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

// ── Correlation Analysis ───────────────────────────────────────────────────
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

// ── Time of Day Filter ─────────────────────────────────────────────────────
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





async function getFundingRate(coin = 'BTC') {
  try {
    const res  = await fetchT(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin}USDT`);
    const data = await res.json();
    const rate = (parseFloat(data.lastFundingRate) * 100).toFixed(4);
    const extreme = Math.abs(parseFloat(rate)) > 0.05;
    return `${coin} funding rate: ${rate}%${extreme ? ' — EXTREME, be careful' : ''}`;
  } catch(e) { return `Could not fetch ${coin} funding rate.`; }
}

async function getDominance() {
  try {
    const res  = await fetchT('https://api.coingecko.com/api/v3/global');
    const data = await res.json();
    const btc  = data.data.market_cap_percentage.btc.toFixed(1);
    const eth  = data.data.market_cap_percentage.eth.toFixed(1);
    return `BTC dominance: ${btc}%, ETH: ${eth}%${parseFloat(btc) < 50 ? ' — altcoin season possible' : ''}`;
  } catch(e) { return 'Could not fetch dominance.'; }
}

async function getGasFees() {
  try {
    const settings = loadSettings();
    const key = settings.etherscanKey || process.env.ETHERSCAN_API_KEY || '';
    const res  = await fetchT(`https://api.etherscan.io/api?module=gastracker&action=gasoracle&apikey=${key}`);
    const data = await res.json();
    if (data.result) return `ETH gas — Fast: ${data.result.FastGasPrice} gwei, Standard: ${data.result.ProposeGasPrice} gwei`;
    return null;
  } catch(e) { return null; }
}

async function getStableYields() {
  try {
    const res  = await fetchT('https://yields.llama.fi/pools', {}, 5000);
    const data = await res.json();
    const pools= data.data
      .filter(p => ['USDT','USDC','DAI'].includes(p.symbol) && p.apy > 0)
      .sort((a, b) => b.apy - a.apy).slice(0, 3);
    return pools.map(p => `${p.project}: ${p.apy.toFixed(2)}% on ${p.symbol}`).join(', ');
  } catch(e) { return null; }
}

async function getLiquidationCascade() {
  try {
    const res  = await fetchT('https://fapi.binance.com/fapi/v1/forceOrders?symbol=BTCUSDT&limit=10');
    const data = await res.json();
    if (data?.length >= 5) return `${data.length} BTC liquidations just happened — possible cascade forming. Wait for it to settle.`;
    return 'No major liquidation cascade right now.';
  } catch(e) { return null; }
}

function getMarketSession() {
  const h = new Date().getUTCHours();
  if (h < 8)  return 'Asian session — lower volume';
  if (h < 16) return 'European session — medium volatility';
  return 'US session — highest volume and volatility';
}

async function getHalvingCountdown() {
  const nextHalving = new Date('2028-04-01');
  const days = Math.floor((nextHalving - Date.now()) / 86400000);
  return `Next BTC halving: approx ${nextHalving.toDateString()} — ${days} days away`;
}

async function getCryptoNews() {
  // Try multiple sources
  const sources = [
    // CryptoPanic public (no key needed)
    async () => {
      const res = await fetchT('https://cryptopanic.com/api/free/v1/posts/?auth_token=free&public=true&kind=news&filter=hot', {}, 5000);
      const data = await res.json();
      if (data?.results?.length > 0) return data.results.slice(0, 5).map(n => n.title).join('. ');
      return null;
    },
    // CoinGecko news
    async () => {
      const res = await fetchT('https://api.coingecko.com/api/v3/news?per_page=5', {}, 5000);
      const data = await res.json();
      if (data?.data?.length > 0) return data.data.slice(0, 5).map(n => n.title).join('. ');
      return null;
    },
  ];

  for (const source of sources) {
    try {
      const result = await source();
      if (result) return result;
    } catch(e) {}
  }
  return null;
}

// ─── WEATHER (Open-Meteo — no key needed) ─────────────────────────────────
async function getWeather(city = null) {
  try {
    // Get coordinates from city name or use default
    let lat = 25.2048, lon = 55.2708; // Default Dubai
    if (city) {
      const geo = await fetchT(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, {}, 5000);
      const geoData = await geo.json();
      if (geoData?.results?.[0]) {
        lat = geoData.results[0].latitude;
        lon = geoData.results[0].longitude;
        city = geoData.results[0].name;
      }
    }
    const res = await fetchT(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`, {}, 5000);
    const data = await res.json();
    const curr = data?.current;
    if (!curr) return 'Could not fetch weather.';
    const codes = { 0:'Clear sky', 1:'Mainly clear', 2:'Partly cloudy', 3:'Overcast', 45:'Foggy', 48:'Foggy', 51:'Light drizzle', 61:'Light rain', 63:'Moderate rain', 65:'Heavy rain', 71:'Light snow', 80:'Rain showers', 95:'Thunderstorm' };
    const condition = codes[curr.weather_code] || 'Unknown';
    const max = data?.daily?.temperature_2m_max?.[0];
    const min = data?.daily?.temperature_2m_min?.[0];
    return `${city || 'Current location'}: ${curr.temperature_2m}°C, ${condition}. High ${max}°C / Low ${min}°C. Humidity ${curr.relative_humidity_2m}%, Wind ${curr.wind_speed_10m} km/h.`;
  } catch(e) { return 'Could not fetch weather right now.'; }
}

// ─── STOCKS (Finnhub) ──────────────────────────────────────────────────────
async function getStockPrice(symbol) {
  try {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return 'No Finnhub API key.';
    // Company name to ticker mapping
    const tickers = {
      'apple': 'AAPL', 'microsoft': 'MSFT', 'google': 'GOOGL', 'alphabet': 'GOOGL',
      'amazon': 'AMZN', 'tesla': 'TSLA', 'meta': 'META', 'facebook': 'META',
      'netflix': 'NFLX', 'nvidia': 'NVDA', 'amd': 'AMD', 'intel': 'INTC',
      'disney': 'DIS', 'samsung': '005930.KS', 'twitter': 'X', 'snapchat': 'SNAP',
      'uber': 'UBER', 'airbnb': 'ABNB', 'paypal': 'PYPL', 'shopify': 'SHOP',
      'spy': 'SPY', 'qqq': 'QQQ', 'gold': 'GLD', 'silver': 'SLV', 'oil': 'USO'
    };
    const sym = tickers[symbol.toLowerCase()] || symbol.toUpperCase();
    const res = await fetchT(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${key}`, {}, 5000);
    const data = await res.json();
    if (!data?.c || data.c === 0) return `Could not find stock: ${symbol}`;
    const change = ((data.c - data.pc) / data.pc * 100).toFixed(2);
    const arrow = parseFloat(change) >= 0 ? '↑' : '↓';
    return `${sym}: $${data.c} ${arrow} ${Math.abs(change)}% today. High: $${data.h} Low: $${data.l}`;
  } catch(e) { return 'Could not fetch stock price.'; }
}

async function getForexRate(from = 'USD', to = 'AED') {
  try {
    const key = process.env.FINNHUB_API_KEY;
    const res = await fetchT(`https://finnhub.io/api/v1/forex/rates?base=${from}&token=${key}`, {}, 5000);
    const data = await res.json();
    const rate = data?.quote?.[to];
    if (!rate) return `Could not fetch ${from}/${to} rate.`;
    return `${from}/${to}: ${rate.toFixed(4)}`;
  } catch(e) { return 'Could not fetch forex rate.'; }
}

// ─── GENERAL NEWS (NewsData.io) ────────────────────────────────────────────
async function getGeneralNews(query = null) {
  try {
    const key = process.env.NEWSDATA_API_KEY;
    if (!key) return 'No NewsData API key.';
    const url = query 
      ? `https://newsdata.io/api/1/news?apikey=${key}&language=en&q=${encodeURIComponent(query)}&size=5`
      : `https://newsdata.io/api/1/news?apikey=${key}&language=en&size=5&prioritydomain=top`;
    const res = await fetchT(url, {}, 8000);
    const data = await res.json();
    if (!data?.results?.length) return 'No news found.';
    const headlines = data.results.slice(0, 5).map((n, i) => `${i+1}. ${n.title}`).join(' ');
    return `Top news: ${headlines}`;
  } catch(e) { return 'Could not fetch news.'; }
}

// ─── HACKERNEWS ────────────────────────────────────────────────────────────
async function getHackerNews() {
  try {
    const res = await fetchT('https://hacker-news.firebaseio.com/v0/topstories.json', {}, 5000);
    const ids = await res.json();
    const top5 = ids.slice(0, 5);
    const stories = await Promise.all(top5.map(async id => {
      const r = await fetchT(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {}, 3000);
      const s = await r.json();
      return s?.title;
    }));
    return stories.filter(Boolean).join('. ');
  } catch(e) { return 'Could not fetch tech news.'; }
}

// ─── MOVIES (OMDb) ─────────────────────────────────────────────────────────
async function getMovieInfo(title) {
  try {
    const key = process.env.OMDB_API_KEY;
    if (!key) return 'No OMDb API key.';
    const res = await fetchT(`http://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${key}`, {}, 5000);
    const data = await res.json();
    if (data?.Response === 'False') return `Movie not found: ${title}`;
    return `${data.Title} (${data.Year}) ⭐ ${data.imdbRating}/10 — ${data.Genre}. ${data.Plot?.slice(0, 120)}`;
  } catch(e) { return 'Could not fetch movie info.'; }
}

async function getMovieRecommendations(genre = 'action', year = null) {
  try {
    const key = process.env.OMDB_API_KEY;
    const yearParam = year ? `&y=${year}` : '';
    const res = await fetchT(`http://www.omdbapi.com/?s=${encodeURIComponent(genre + ' movie')}&type=movie${yearParam}&apikey=${key}`, {}, 5000);
    const data = await res.json();
    if (!data?.Search?.length) return `No ${genre} movies found.`;
    // Get ratings for top 3
    const top3 = data.Search.slice(0, 3);
    const withRatings = await Promise.all(top3.map(async m => {
      try {
        const r = await fetchT(`http://www.omdbapi.com/?i=${m.imdbID}&apikey=${key}`, {}, 3000);
        const d = await r.json();
        return `${d.Title} (${d.Year}) ⭐${d.imdbRating}`;
      } catch(e) { return `${m.Title} (${m.Year})`; }
    }));
    return withRatings.join(', ');
  } catch(e) { return 'Could not fetch movie recommendations.'; }
}

// ─── SPOTIFY ───────────────────────────────────────────────────────────────
let spotifyToken = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  try {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetchT('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials'
    }, 5000);
    const data = await res.json();
    if (data?.access_token) {
      spotifyToken = data.access_token;
      spotifyTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
      return spotifyToken;
    }
  } catch(e) { console.error('Spotify token error:', e.message); }
  return null;
}

async function searchSpotify(query) {
  try {
    const token = await getSpotifyToken();
    if (!token) return null;
    const res = await fetchT(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`, {
      headers: { 'Authorization': `Bearer ${token}` }
    }, 5000);
    const data = await res.json();
    const track = data?.tracks?.items?.[0];
    if (!track) return null;
    return { name: track.name, artist: track.artists[0].name, uri: track.uri, url: track.external_urls.spotify };
  } catch(e) { return null; }
}

async function playOnSpotify(query) {
  try {
    const track = await searchSpotify(query);
    if (!track) return `Could not find "${query}" on Spotify.`;
    const { shell } = require('electron');
    shell.openExternal(track.url);
    return `Opening "${track.name}" by ${track.artist} on Spotify.`;
  } catch(e) { return 'Could not open Spotify.'; }
}

// ─── REDDIT (no key — public JSON) ─────────────────────────────────────────
async function getRedditPosts(subreddit = 'CryptoCurrency', limit = 5) {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'www.reddit.com',
        path: `/r/${subreddit}/hot.json?limit=${limit}`,
        method: 'GET',
        headers: { 'User-Agent': 'crypto-ai-desktop:v1.0 (by /u/cryptoai)' },
        timeout: 8000
      }, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    const posts = data?.data?.children?.slice(0, 5).map(p => p.data.title);
    if (!posts?.length) return 'Could not fetch Reddit posts.';
    return `Top posts from r/${subreddit}: ` + posts.map((p, i) => `${i+1}. ${p}`).join(' ');
  } catch(e) { console.error('Reddit error:', e.message); return 'Could not fetch Reddit right now.'; }
}

// ─── RECIPES (Spoonacular) ─────────────────────────────────────────────────
async function getRecipe(query) {
  try {
    const key = process.env.SPOONACULAR_API_KEY;
    if (!key) return 'No Spoonacular API key.';
    const res = await fetchT(`https://api.spoonacular.com/recipes/complexSearch?query=${encodeURIComponent(query)}&number=1&addRecipeInformation=true&apiKey=${key}`, {}, 8000);
    const data = await res.json();
    if (!data?.results?.length) return `No recipe found for ${query}.`;
    const r = data.results[0];
    const ingredients = r.extendedIngredients?.slice(0, 6).map(i => i.name).join(', ') || 'ingredients not available';
    return `${r.title} — Ready in ${r.readyInMinutes} mins. Main ingredients: ${ingredients}. Want the full recipe?`;
  } catch(e) { return 'Could not fetch recipe right now.'; }
}

async function getRecipeDetails(id) {
  try {
    const key = process.env.SPOONACULAR_API_KEY;
    const res = await fetchT(`https://api.spoonacular.com/recipes/${id}/information?apiKey=${key}`, {}, 5000);
    const data = await res.json();
    if (!data?.title) return 'Recipe not found.';
    const ingredients = data.extendedIngredients?.slice(0, 8).map(i => i.original).join(', ');
    return `${data.title} — Ready in ${data.readyInMinutes} mins. Ingredients: ${ingredients}.`;
  } catch(e) { return 'Could not fetch recipe details.'; }
}

// ─── WIKIPEDIA ─────────────────────────────────────────────────────────────
async function getWikipediaSummary(query) {
  try {
    const res = await fetchT(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {}, 5000);
    const data = await res.json();
    if (!data?.extract) return `No Wikipedia article found for ${query}.`;
    return data.extract.slice(0, 300) + '...';
  } catch(e) { return 'Could not fetch Wikipedia.'; }
}

// ─── DICTIONARY ────────────────────────────────────────────────────────────
async function getDefinition(word) {
  try {
    const res = await fetchT(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {}, 5000);
    const data = await res.json();
    if (!data?.[0]) return `No definition found for ${word}.`;
    const meaning = data[0].meanings?.[0];
    const def = meaning?.definitions?.[0]?.definition;
    return `${word} (${meaning?.partOfSpeech}): ${def}`;
  } catch(e) { return 'Could not fetch definition.'; }
}

// ─── TIMEZONE ──────────────────────────────────────────────────────────────
async function getTimeInCity(city) {
  try {
    const res = await fetchT(`https://worldtimeapi.org/api/timezone`, {}, 5000);
    const zones = await res.json();
    const match = zones.find(z => z.toLowerCase().includes(city.toLowerCase()));
    if (!match) return `Could not find timezone for ${city}.`;
    const r = await fetchT(`https://worldtimeapi.org/api/timezone/${match}`, {}, 5000);
    const data = await r.json();
    const time = new Date(data.datetime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `Current time in ${city}: ${time}`;
  } catch(e) { return 'Could not fetch timezone.'; }
}

// ─── IP GEOLOCATION ────────────────────────────────────────────────────────
async function getUserLocation() {
  try {
    const res = await fetchT('https://ipapi.co/json/', {}, 5000);
    const data = await res.json();
    return { city: data.city, country: data.country_name, lat: data.latitude, lon: data.longitude };
  } catch(e) { return null; }
}

// ─── CONTRACT SCAN ─────────────────────────────────────────────────────────
async function scanContract(ca, chainHint = '1') {
  try {
    // Chain map
    const chainMap = { '1': '1', 'eth': '1', 'bsc': '56', '56': '56', 'polygon': '137', 'arbitrum': '42161', 'base': '8453' };
    const chainId = chainMap[chainHint] || chainHint;
    const res  = await fetchT(`https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${ca}`);
    const data = await res.json();
    const r    = data.result?.[ca.toLowerCase()];
    if (!r) return `Could not find data for ${ca} on chain ${chainId}. Try gopluslabs.io manually.`;
    const flags = [];
    if (r.is_honeypot === '1')             flags.push('HONEYPOT — cannot sell');
    if (r.is_open_source === '0')          flags.push('not open source');
    if (r.is_mintable === '1')             flags.push('mintable');
    if (r.hidden_owner === '1')            flags.push('hidden owner');
    if (r.can_take_back_ownership === '1') flags.push('owner can take back control');
    if (parseInt(r.holder_count) < 100)    flags.push('very few holders');
    if (parseFloat(r.sell_tax) > 10)       flags.push(`sell tax ${r.sell_tax}%`);
    const score   = Math.max(0, 10 - flags.length * 2);
    const verdict = flags.length === 0 ? 'Looks clean' : flags.length <= 2 ? 'Proceed with caution' : 'HIGH RISK — likely scam';
    return `${verdict}. Risk score ${score}/10. Buy tax: ${r.buy_tax || 0}%, Sell tax: ${r.sell_tax || 0}%. ${flags.length > 0 ? 'Issues: ' + flags.join(', ') : 'No major red flags.'}`;
  } catch(e) { return 'Could not scan. Try gopluslabs.io manually.'; }
}

// ─── YOUTUBE ───────────────────────────────────────────────────────────────
async function searchYouTube(query) {
  try {
    const settings = loadSettings();
    const key = settings.youtubeKey || process.env.YOUTUBE_API_KEY;
    if (!key) return null;
    const res  = await fetchT(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${key}`);
    const data = await res.json();
    if (data.items?.length > 0) {
      return { url: `https://www.youtube.com/watch?v=${data.items[0].id.videoId}`, title: data.items[0].snippet.title };
    }
  } catch(e) {}
  return null;
}

// ─── SMART URL ─────────────────────────────────────────────────────────────
async function smartOpen(command) {
  const lower = command.toLowerCase();
  if (lower.includes('play') || lower.includes('song') || lower.includes('music')) {
    const q = command.replace(/play|song|music|on youtube|youtube/gi, '').trim();
    if (q) {
      const r = await searchYouTube(q);
      if (r) { shell.openExternal(r.url); return `Playing ${r.title}!`; }
    }
  }
  if (lower.includes('spotify')) {
    const q = command.replace(/play|spotify|on spotify/gi, '').trim();
    shell.openExternal(`https://open.spotify.com/search/${encodeURIComponent(q)}`);
    return `Opening ${q} on Spotify.`;
  }
  try {
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 60,
      messages: [{ role: 'user', content: `Convert to URL only, no other text:\n"open binance btc" -> https://www.binance.com/en/futures/BTCUSDT\n"open tradingview btc" -> https://www.tradingview.com/chart/?symbol=BINANCE:BTCUSDT\n"open dexscreener" -> https://dexscreener.com\n"show me cats" -> https://google.com/search?q=cats&tbm=isch\n"search bitcoin news" -> https://google.com/search?q=bitcoin+news\n"open twitter" -> https://x.com\nCommand: "${command}"` }],
    });
    const url = res.content[0].text.trim();
    if (url.startsWith('http')) { shell.openExternal(url); return 'On it!'; }
  } catch(e) {}
  return null;
}

// ─── COMPUTER ACTIONS ──────────────────────────────────────────────────────
function doAction(command) {
  const lower = command.toLowerCase();
  if (lower.includes('volume up'))   { robot.keyTap('audio_vol_up');   robot.keyTap('audio_vol_up');   robot.keyTap('audio_vol_up');   return 'Volume up.'; }
  if (lower.includes('volume down')) { robot.keyTap('audio_vol_down'); robot.keyTap('audio_vol_down'); robot.keyTap('audio_vol_down'); return 'Volume down.'; }
  if (lower.includes('scroll down')) { robot.scrollMouse(0, 3);  return 'Scrolling down.'; }
  if (lower.includes('scroll up'))   { robot.scrollMouse(0, -3); return 'Scrolling up.'; }
  if (lower.includes('go back'))     { robot.keyTap('left', ['command']); return 'Going back.'; }
  if (lower.includes('refresh'))     { robot.keyTap('r', ['command']); return 'Refreshing.'; }
  if (lower.includes('close tab'))   { robot.keyTap('w', ['command']); return 'Closing tab.'; }
  if (lower.includes('new tab'))     { robot.keyTap('t', ['command']); return 'New tab.'; }
  if (lower.includes('zoom in'))     { robot.keyTap('=', ['command']); return 'Zoomed in.'; }
  if (lower.includes('zoom out'))    { robot.keyTap('-', ['command']); return 'Zoomed out.'; }
  return null;
}

// ─── SCREENSHOT ────────────────────────────────────────────────────────────
async function takeScreenshot(msg) {
  try {
    if (mainWindow) { mainWindow.hide(); await new Promise(r => setTimeout(r, 300)); }
    const img = await screenshot({ format: 'png' });
    if (mainWindow) mainWindow.show();
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 150, system: buildSystemPrompt(),
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img.toString('base64') } },
        { type: 'text', text: msg || 'What is on this screen? Be specific and casual in 1-2 sentences.' }
      ]}],
    });
    return res.content[0].text;
  } catch(e) { return 'Could not take screenshot: ' + e.message; }
}

// ─── EXPORT / RESTORE ──────────────────────────────────────────────────────
async function exportAllData() {
  const data = {
    memory: loadMemory(), journal: loadJournal(), alerts: loadAlerts(),
    notes: loadNotes(), voiceJournal: loadVoiceJournal(),
    settings: loadSettings(), checklist: loadChecklist(),
    gasSpend: loadJSON(GAS_SPEND_FILE, []),
    exportedAt: new Date().toISOString(),
  };
  const p = path.join(app.getPath('downloads'), `asuka-backup-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  shell.openPath(path.dirname(p));
  return `Backup saved to Downloads folder.`;
}

async function restoreBackup(raw) {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (data.memory)      saveMemory(data.memory);
    if (data.journal)     saveJournal(data.journal);
    if (data.alerts)      saveAlerts(data.alerts);
    if (data.notes)       saveJSON(NOTES_FILE, data.notes);
    if (data.voiceJournal)saveJSON(VOICE_JOURNAL_FILE, data.voiceJournal);
    if (data.settings)    saveSettings(data.settings);
    if (data.checklist)   saveChecklist(data.checklist);
    return 'Backup restored! Restart the app to apply everything.';
  } catch(e) { return 'Restore failed: ' + e.message; }
}

// ─── CASUAL PRE-FILTER ─────────────────────────────────────────────────────
const CASUAL = {
  'hi':['Hey!','Hi!','Hey, what\'s up?','Heyyy!'],
  'hey':['Hey!','Yo!','What\'s good?','Hey!'],
  'hello':['Hello!','Hey there!','Hi!'],
  'whats up':['Not much, you?','Just chilling. You?','All good!'],
  'what\'s up':['Not much, you?','Chilling. You?','All good here!'],
  'sup':['Yo!','Not much!','All good, you?'],
  'how are you':['Doing great!','All good! You?','Pretty good!'],
  'how r u':['Doing great!','All good!','Pretty good, you?'],
  'gm':['gm!','Morning!','gm gm!'],
  'good morning':['Good morning!','Morning!','gm!'],
  'good night':['Night!','Sleep well!','Good night!'],
  'goodnight':['Night!','Sleep well!','Later!'],
  'bye':['Bye!','See you!','Later!'],
  'lol':['haha','lmao 😂','haha exactly'],
  'haha':['haha','😄','right?'],
  'ok':['👍','Got it!','Okay!'],
  'okay':['👍','Got it!','Alright!'],
  'thanks':['Anytime!','Of course!','No problem!'],
  'thank you':['Anytime!','Of course!','No problem!'],
  'nice':['Right?','Exactly!','Pretty cool!'],
  'cool':['Right?','Yep!','Totally!'],
  'what are you':['An AI companion. Here to chat, help with crypto, and keep you company.'],
  'who are you':['Asuka — your AI companion. Here whenever you need.'],
};

function getCasualReply(lower) {
  const trimmed = lower.trim().replace(/[?!.]$/, '');
  const replies = CASUAL[trimmed];
  if (replies) return replies[Math.floor(Math.random() * replies.length)];
  return null;
}

// ─── ALERT MONITOR ─────────────────────────────────────────────────────────
let alertInterval      = null;
let lastPrices         = {};
let lastActivityTime   = Date.now();
let inActivityFired    = false;
let chartAlertFired    = false;
let lastCameraUsed     = 0;

async function startAlertMonitor() {
  if (alertInterval) return;
  alertInterval = setInterval(async () => {
    const mem      = loadMemory();
    const settings = loadSettings();
    if (!mainWindow || mem.sleepMode) return;
    const focusOk  = !mem.focusMode || Date.now() > (mem.focusModeUntil || 0);

    // Custom price alerts
    const alerts = loadAlerts();
    for (const alert of alerts) {
      if (alert.triggered || settings.suppressedAlerts?.includes(alert.id)) continue;
      const priceText = await getCryptoPrice(alert.coin);
      if (!priceText) continue;
      const match = priceText.match(/\$([\d,]+\.?\d*)/);
      if (!match) continue;
      const current = parseFloat(match[1].replace(/,/g, ''));
      const hit = alert.direction === 'above' ? current >= alert.target : current <= alert.target;
      if (hit) {
        alert.triggered = true; saveAlerts(alerts);
        const msg   = `${alert.coin.toUpperCase()} hit your target of $${alert.target}!`;
        const audio = await getVoiceAudio(msg);
        mainWindow.webContents.send('price-alert', { msg, audio });
        new Notification({ title: 'Price Alert — Asuka', body: msg }).show();
      }
    }

    // 3%+ moves on watchlist
    if (focusOk && !mem.inTrade) {
      const coins = ['btc', 'eth', 'sol', ...(settings.watchlist || [])].slice(0, 5);
      for (const coin of coins) {
        const priceText = await getCryptoPrice(coin);
        if (!priceText) continue;
        const match = priceText.match(/\$([\d,]+\.?\d*)/);
        if (!match) continue;
        const current = parseFloat(match[1].replace(/,/g, ''));
        const last    = lastPrices[coin];
        if (last && Math.abs((current - last) / last * 100) > 3) {
          const chg = ((current - last) / last * 100).toFixed(1);
          const msg = `${coin.toUpperCase()} just moved ${chg}% — watch it.`;
          const audio = await getVoiceAudio(msg);
          mainWindow.webContents.send('price-alert', { msg, audio });
        }
        lastPrices[coin] = current;
      }
    }

    // Extreme funding rate
    if (focusOk) {
      try {
        const res  = await fetchT('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
        const data = await res.json();
        const rate = parseFloat(data.lastFundingRate) * 100;
        if (Math.abs(rate) > 0.08) {
          const msg   = `BTC funding rate at ${rate.toFixed(4)}% — ${rate > 0 ? 'longs overleveraged' : 'shorts overleveraged'}. Be careful.`;
          const audio = await getVoiceAudio(msg);
          mainWindow.webContents.send('price-alert', { msg, audio });
        }
      } catch(e) {}
    }

    // Rug pull check on watchlist
    if (focusOk && settings.watchlist?.length > 0) {
      for (const coin of settings.watchlist.slice(0, 3)) {
        const priceText = await getCryptoPrice(coin);
        if (!priceText) continue;
        const cm = priceText.match(/(up|down) ([\d.]+)%/);
        if (cm && cm[1] === 'down' && parseFloat(cm[2]) > 20) {
          const msg   = `${coin.toUpperCase()} is down ${cm[2]}% — potential rug or massive sell. Check immediately.`;
          const audio = await getVoiceAudio(msg);
          mainWindow.webContents.send('price-alert', { msg, audio });
        }
      }
    }

    // Inactivity alert — once only
    if (Date.now() - lastActivityTime > 7200000 && focusOk && !inActivityFired) {
      const p     = await getCryptoPrice('btc');
      const msg   = `Hey, you there? ${p || 'Markets are moving while you\'re away.'}`;
      const audio = await getVoiceAudio(msg);
      mainWindow.webContents.send('price-alert', { msg, audio });
      inActivityFired = true;
    }

    // Chart staring alert — once only
    if (mem.chartStartTime && Date.now() - mem.chartStartTime > 14400000 && !chartAlertFired) {
      const msg   = "You've been staring at charts for over 4 hours. Take a break.";
      const audio = await getVoiceAudio(msg);
      mainWindow.webContents.send('price-alert', { msg, audio });
      chartAlertFired = true;
    }

    // Water reminder
    if (mem.waterReminderMinutes && focusOk) {
      const last = mem.lastWaterReminder || 0;
      if (Date.now() - last > mem.waterReminderMinutes * 60000) {
        const msg   = 'Drink some water. You probably forgot.';
        const audio = await getVoiceAudio(msg);
        mainWindow.webContents.send('price-alert', { msg, audio });
        mem.lastWaterReminder = Date.now(); saveMemory(mem);
      }
    }

    // Sleep time alert
    if (mem.sleepHour !== null) {
      const h = new Date().getHours();
      if (h === mem.sleepHour) {
        const msg   = `It's ${h}:00 — you said you sleep around now. Markets will still be here tomorrow.`;
        const audio = await getVoiceAudio(msg);
        mainWindow.webContents.send('price-alert', { msg, audio });
        mem.sleepHour = null; saveMemory(mem);
      }
    }

    // DCA reminders
    if (mem.dcaSchedule?.length > 0) {
      for (const dca of mem.dcaSchedule) {
        const freqDays = { daily: 1, weekly: 7, monthly: 30 }[dca.frequency] || 7;
        const nextDue  = new Date((dca.lastDone || 0) + freqDays * 86400000);
        if (Date.now() >= nextDue.getTime()) {
          const msg   = `DCA reminder: time to buy $${dca.amount} of ${dca.coin.toUpperCase()}.`;
          const audio = await getVoiceAudio(msg);
          mainWindow.webContents.send('price-alert', { msg, audio });
          dca.lastDone = Date.now(); saveMemory(mem); break;
        }
      }
    }

    // Morning alarm
    const mem2 = loadMemory();
    if (mem2.alarmTime && !mem2.alarmFired) {
      const now = new Date();
      const [h, min] = mem2.alarmTime.split(':').map(Number);
      if (now.getHours() === h && now.getMinutes() === min) {
        const btc = await getCryptoPrice('btc');
        const fg  = await getFearGreed();
        const msg = `Good morning${mem2.name ? ' ' + mem2.name : ''}! ${btc || ''}. ${fg || ''}.`;
        const audio = await getVoiceAudio(msg);
        mainWindow.webContents.send('price-alert', { msg, audio });
        mem2.alarmFired = true; saveMemory(mem2);
        setTimeout(() => { const m = loadMemory(); m.alarmFired = false; saveMemory(m); }, 3600000);
      }
    }

    // Influencer wallet alerts
    if (settings.influencerWallets?.length > 0 && focusOk) {
      const moralisKey = settings.moralisKey || process.env.MORALIS_API_KEY;
      if (moralisKey) {
        for (const wallet of settings.influencerWallets.slice(0, 3)) {
          if (!wallet.address || !wallet.label) continue;
          try {
            const res  = await fetchT(
              `https://deep-index.moralis.io/api/v2.2/${wallet.address}/erc20/transfers?limit=1`,
              { headers: { 'X-API-Key': moralisKey } }
            );
            const data = await res.json();
            if (data.result?.length > 0) {
              const msg   = `${wallet.label} just made a move — check what they bought.`;
              const audio = await getVoiceAudio(msg);
              mainWindow.webContents.send('price-alert', { msg, audio });
            }
          } catch(e) {}
        }
      }
    }

  }, 60000);
}

// ─── MAIN COMMAND ROUTER ───────────────────────────────────────────────────
async function routeCommand(userText) {
  const lower = userText.toLowerCase().trim();
  const mem   = loadMemory();
  const settings = loadSettings();
  lastActivityTime = Date.now();
  inActivityFired  = false;

  // ── MARKET INTELLIGENCE VOICE COMMANDS ──────────────────────────────────
  if (lower.includes('market intel') || lower.includes('full analysis') || lower.includes('market signals') || lower.includes('what does the market say')) {
    const coinInMsg = Object.keys(COIN_MAP).find(k => lower.includes(k)) || 'btc';
    const coinUpper = coinInMsg.toUpperCase();
    const intel = await getFullMarketIntel(coinUpper);
    return `Here's the full market intelligence for ${coinUpper}:\n\n${intel}`;
  }

  if (lower.includes('long short ratio') || lower.includes('ls ratio')) {
    const coinInMsg = Object.keys(COIN_MAP).find(k => lower.includes(k)) || 'btc';
    const ls = await getLongShortRatio(coinInMsg.toUpperCase());
    return ls || 'Could not fetch L/S ratio right now';
  }

  if (lower.includes('open interest') || lower.includes('oi')) {
    const coinInMsg = Object.keys(COIN_MAP).find(k => lower.includes(k)) || 'btc';
    const oi = await getOpenInterest(coinInMsg.toUpperCase());
    return oi || 'Could not fetch open interest right now';
  }

  // ── SPOT TRADING VOICE COMMANDS ──────────────────────────────────────────
  // "buy $200 of BTC" or "buy BTC 200"
  const buyMatch = lower.match(/buy\s+\$?(\d+)\s+(?:of\s+)?([a-z]+)|buy\s+([a-z]+)\s+\$?(\d+)/);
  if (buyMatch && (lower.includes('buy') && !lower.includes('should i buy'))) {
    const amount = parseFloat(buyMatch[1] || buyMatch[4]);
    const coin = (buyMatch[2] || buyMatch[3])?.toUpperCase();
    if (amount && coin && Object.keys(COIN_MAP).some(k => coin.toLowerCase().includes(k))) {
      const order = await spotBuy(coin, amount);
      if (order) {
        return `Bought ${order.quantity} ${coin} for $${amount} at ~$${parseFloat(order.price || 0).toLocaleString()} 🟢`;
      }
      return `Spot buy failed — check your balance or try again`;
    }
  }

  // "sell 50% of my BTC" or "sell all ETH" or "sell $100 of BTC"
  const sellMatch = lower.match(/sell\s+(all|\d+%?)\s+(?:of\s+)?(?:my\s+)?([a-z]+)/);
  if (sellMatch && lower.includes('sell')) {
    const amountStr = sellMatch[1];
    const coin = sellMatch[2]?.toUpperCase();
    if (coin && Object.keys(COIN_MAP).some(k => coin.toLowerCase().includes(k))) {
      let order;
      if (amountStr === 'all') {
        order = await spotSell(coin, null, 100);
      } else if (amountStr.includes('%')) {
        const pct = parseFloat(amountStr);
        order = await spotSell(coin, null, pct);
      } else {
        const price = await getSpotPrice(`${coin}USDT`);
        const qty = parseFloat(amountStr) / (price || 1);
        order = await spotSell(coin, qty);
      }
      if (order) {
        return `Sold ${order.quantity} ${coin} at ~$${parseFloat(order.price || 0).toLocaleString()} 🔴`;
      }
      return `Spot sell failed — check your balance`;
    }
  }

  // "set limit buy BTC at 60000" 
  const limitBuyMatch = lower.match(/limit buy\s+([a-z]+)\s+(?:at\s+)?\$?([\d,]+)/);
  if (limitBuyMatch) {
    const coin = limitBuyMatch[1]?.toUpperCase();
    const price = parseFloat(limitBuyMatch[2].replace(',',''));
    const settings = loadSettings();
    const baseTradeSize = settings.paperTradeSize || 500;
  const amount = settings.useKellyCriterion ? calcKellySize(signal?.coin || 'BTC', baseTradeSize) : baseTradeSize;
    const order = await spotLimitBuy(coin, amount, price);
    if (order) return `Limit buy set: ${order.quantity} ${coin} at $${price.toLocaleString()} 📋`;
    return `Limit buy failed`;
  }

  // "my spot balance" or "show my wallet"
  if (lower.includes('spot balance') || lower.includes('my wallet') || lower.includes('my holdings') || lower.includes('what do i hold')) {
    const balances = await getSpotBalances();
    if (!balances.length) return `No spot holdings yet. Say "buy $100 of BTC" to get started!`;
    let msg = `Your spot holdings:\n\n`;
    for (const b of balances.slice(0, 10)) {
      if (b.coin === 'USDT') {
        msg += `💵 USDT: $${b.total.toFixed(2)}\n`;
      } else {
        const price = await getSpotPrice(`${b.coin}USDT`).catch(() => null);
        const value = price ? (b.total * price).toFixed(2) : '?';
        msg += `🪙 ${b.coin}: ${b.total.toFixed(4)} (~$${value})\n`;
      }
    }
    return msg;
  }

  // ── END SPOT COMMANDS ─────────────────────────────────────────────────────

  // ── SECOND BRAIN ──────────────────────────────────────────────────────────
  if (lower.startsWith('remember ') || lower.startsWith('note ') || lower.includes("don't forget")) {
    const text = userText.replace(/^(remember|note)\s+/i, '').replace(/don't forget\s+/i, '');
    const memory = addMemory(text);
    return `Got it! I'll remember that 🧠\n"${text}"\nSaved on ${memory.date}`;
  }

  if (lower.startsWith('what do i know') || lower.startsWith('recall') || lower.startsWith('what did i save')) {
    const query = lower.replace(/^(what do i know about|recall|what did i save about?)\s+/i, '');
    const memories = searchMemories(query);
    if (!memories.length) return `Nothing saved about "${query}" yet. Tell me something to remember!`;
    return `Here's what I remember:\n\n${memories.map(m => `• [${m.date}] ${m.text}`).join('\n')}`;
  }

  if (lower.includes('show my memories') || lower.includes('what do you remember about me')) {
    const brain = loadBrain();
    if (!brain.memories.length) return "No memories saved yet! Say 'remember [something]' and I'll keep it.";
    return `Your memories:\n\n${brain.memories.slice(-10).reverse().map(m => `• [${m.date}] ${m.text}`).join('\n')}`;
  }

  // ── RAGE LOCK ─────────────────────────────────────────────────────────────
  if (lower.includes('lock trading') || lower.includes('lock me out')) {
    activateRageLock('Manual lock by user');
    return `🔒 Trading locked! Taking a break is smart. I'll unlock in ${settings.rageLockMinutes || 30} minutes. You've got this 💙`;
  }

  if (lower.includes('unlock trading') || lower.includes('unlock me')) {
    ipcMain.emit('unlock-rage-lock');
    return '🔓 Trading unlocked! Trade wisely 💙';
  }

  // ── PSYCHOLOGY SCORE ──────────────────────────────────────────────────────
  if (lower.includes('psychology score') || lower.includes('my trading psychology') || lower.includes('how am i trading')) {
    const score = await calculatePsychologyScore();
    if (!score) return "Not enough trades yet to calculate your psychology score. Keep trading!";
    return `🧠 Trading Psychology Score: ${score.score}/100 (Grade: ${score.grade})\n\nWin Rate: ${score.winRate}%\n${score.issues.length ? '\n⚠️ Issues:\n' + score.issues.map(i => `• ${i}`).join('\n') : ''}\n${score.wins.length ? '\n✅ Strengths:\n' + score.wins.map(w => `• ${w}`).join('\n') : ''}`;
  }

  // ── 1. CASUAL FILTER ──────────────────────────────────────────────────────
  const casual = getCasualReply(lower);
  if (casual) return casual;

  // ── 2. INSTANT MARKET DATA — direct API, no AI ──────────────────────────
  const coinInMsg = Object.keys(COIN_MAP).find(k => lower.includes(k));

  // Price
  if (coinInMsg && (lower.includes('price') || lower.includes('how much') || lower.includes('how is') || lower.includes('worth') || lower.includes('trading at') || lower === coinInMsg || lower === coinInMsg + '?')) {
    const p = await getCryptoPrice(coinInMsg);
    return p || 'Could not fetch price right now.';
  }

  // Fear & Greed
  if (lower.includes('fear') || lower.includes('greed') || lower.includes('market sentiment') || lower.includes('sentiment index')) {
    return await getFearGreed();
  }

  // Funding rate
  if (lower.includes('funding')) {
    const coin = Object.keys(COIN_MAP).find(k => lower.includes(k))?.toUpperCase() || 'BTC';
    return await getFundingRate(coin);
  }

  // Dominance
  if (lower.includes('dominance') || lower.includes('btc dom') || lower.includes('altcoin season')) {
    return await getDominance();
  }

  // Gas fees
  if (lower.includes('gas fee') || lower.includes('gas price') || lower.includes('gwei')) {
    const gas = await getGasFees();
    return gas || 'Check etherscan.io for current gas prices.';
  }

  // Halving
  if (lower.includes('halving')) return await getHalvingCountdown();

  // Market session
  if (lower.includes('market session') || lower.includes('which session') || lower.includes('what session')) {
    return getMarketSession();
  }

  // Liquidation cascade
  if (lower.includes('liquidation cascade') || lower.includes('cascade') || lower.includes('mass liquidation')) {
    const r = await getLiquidationCascade();
    return r || 'No major cascade right now.';
  }

  // Stable yields
  if (lower.includes('stable') && (lower.includes('yield') || lower.includes('apy') || lower.includes('where to park'))) {
    const y = await getStableYields();
    return y || 'Check defillama.com/yields for current rates.';
  }

  // Gas spending this month
  if (lower.includes('how much gas') || lower.includes('gas spend') || lower.includes('fees this month')) {
    const spend = getMonthlyGasSpend();
    return `You've spent $${spend.toFixed(2)} in gas fees this month.`;
  }

  if (lower.includes('sleep mode') || lower.includes('goodnight') || lower.includes('good night')) {
    mem.sleepMode = true; saveMemory(mem);
    return `Goodnight${mem.name ? ' ' + mem.name : ''}! Sleep well.`;
  }
  if (mem.sleepMode) {
    if (lower.includes('good morning') || lower.includes('wake up') || lower.includes("i'm up") || lower.includes('im up')) {
      mem.sleepMode = false; saveMemory(mem);
      const btc = await getCryptoPrice('btc');
      const fg  = await getFearGreed();
      return `Good morning! ${btc || ''}. ${fg || ''}`;
    }
    return 'Still in sleep mode. Say good morning to wake me up.';
  }

  // ── 4. MODES & SETTINGS ─────────────────────────────────────────────────
  if (lower.includes('degen') && (lower.includes('mode') || lower.includes('go'))) {
    mem.personality = 'degen'; saveMemory(mem); return 'WAGMI LFG degen mode activated ser 🚀';
  }
  if (lower.includes('analyst') && (lower.includes('mode') || lower.includes('go'))) {
    mem.personality = 'analyst'; saveMemory(mem); return 'Analyst mode. Data only.';
  }
  if (lower.includes('chill') && (lower.includes('mode') || lower.includes('go'))) {
    mem.personality = 'chill'; saveMemory(mem); return 'Chill mode. Just vibing.';
  }
  if (lower.includes('focus mode')) {
    const hours = parseInt(lower.match(/(\d+)\s*hour/)?.[1] || 2);
    mem.focusMode = true; mem.focusModeUntil = Date.now() + hours * 3600000;
    saveMemory(mem); return `Focus mode on for ${hours} hours. No interruptions.`;
  }
  if (lower.includes('stop focus') || lower.includes('end focus')) {
    mem.focusMode = false; saveMemory(mem); return 'Focus mode off.';
  }
  if (lower.includes('talk faster') || lower.includes('speak faster')) {
    mem.voiceSpeed = Math.min(1.5, (mem.voiceSpeed || 1) + 0.2); saveMemory(mem); return 'Speaking faster.';
  }
  if (lower.includes('slow down') || lower.includes('talk slower')) {
    mem.voiceSpeed = Math.max(0.7, (mem.voiceSpeed || 1) - 0.2); saveMemory(mem); return 'Slowing down.';
  }
  if (lower.includes('beginner mode') || lower.includes('explain simply')) {
    mem.learningLevel = 'beginner'; saveMemory(mem); return "Beginner mode on. I'll explain everything simply.";
  }
  if (lower.includes('advanced mode') || lower.includes('expert mode')) {
    mem.learningLevel = 'advanced'; saveMemory(mem); return 'Advanced mode. Raw signals only.';
  }

  // ── 5. SMART SILENCE ────────────────────────────────────────────────────
  if (lower.includes("i'm in a trade") || lower.includes('in a trade') || lower.includes('trading now')) {
    mem.inTrade = true; saveMemory(mem); return 'Got it, going quiet. Only urgent alerts will come through.';
  }
  if (lower.includes('done trading') || lower.includes('trade closed') || lower.includes('out of trade')) {
    mem.inTrade = false; saveMemory(mem); return 'Back to normal. How did it go?';
  }

  // ── 6. NOTES & MEMORY ───────────────────────────────────────────────────
  if (lower.includes('remember this') || lower.includes('remember that')) {
    const note = userText.replace(/remember this|remember that/gi, '').trim();
    if (note) { saveNote(note); return 'Saved.'; }
  }
  if (lower.includes('what did i tell you to remember') || lower.includes('read my notes') || lower.includes('my notes')) {
    const notes = loadNotes();
    if (!notes.length) return 'No notes saved yet.';
    return notes.slice(-3).map(n => n.text).join('. ');
  }
  if (lower.includes('my rule is') || lower.includes('i never trade') || lower.includes('i always')) {
    mem.userRules = mem.userRules || [];
    mem.userRules.push(userText);
    if (mem.userRules.length > 10) mem.userRules.shift();
    saveMemory(mem); return "Got it, I'll remind you if you break it.";
  }

  // ── 7. ALARM & REMINDERS ────────────────────────────────────────────────
  if (lower.includes('set alarm') || lower.includes('wake me up at')) {
    const tm = lower.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/);
    if (tm) {
      let h = parseInt(tm[1]); const min = parseInt(tm[2] || '0'); const p = tm[3];
      if (p === 'pm' && h < 12) h += 12;
      if (p === 'am' && h === 12) h = 0;
      mem.alarmTime = `${h}:${min.toString().padStart(2,'0')}`; mem.alarmFired = false; saveMemory(mem);
      return `Alarm set for ${mem.alarmTime}. I'll wake you with a market briefing.`;
    }
  }
  if (lower.includes('remind me to drink') || lower.includes('water reminder')) {
    const mMatch = lower.match(/every (\d+) (minute|hour)/);
    mem.waterReminderMinutes = mMatch ? parseInt(mMatch[1]) * (mMatch[2] === 'hour' ? 60 : 1) : 60;
    saveMemory(mem); return `Water reminder set for every ${mem.waterReminderMinutes} minutes.`;
  }
  if (lower.includes('i sleep at') || lower.includes('i go to bed at')) {
    const hMatch = lower.match(/at (\d{1,2})/);
    if (hMatch) { mem.sleepHour = parseInt(hMatch[1]); saveMemory(mem); return `Got it, I'll remind you at ${hMatch[1]}pm.`; }
  }

  // ── 8. VOICE JOURNAL ────────────────────────────────────────────────────
  if (lower.includes('what was i thinking when i bought') || lower.includes('read my journal about')) {
    const vj = loadVoiceJournal();
    const coin = Object.keys(COIN_MAP).find(k => lower.includes(k));
    if (coin) {
      const entry = vj.filter(e => e.coinMentioned?.toLowerCase() === coin).pop();
      return entry ? `Your journal about ${coin.toUpperCase()}: ${entry.summary || entry.text.slice(0, 150)}` : `No journal entry for ${coin.toUpperCase()}.`;
    }
    const last = vj[vj.length - 1];
    return last ? `Last entry: ${last.summary || last.text.slice(0, 150)}` : 'No voice journal entries yet.';
  }

  // ── 9. TRADING JOURNAL ───────────────────────────────────────────────────
  if (lower.includes('best trade') || lower.includes('worst trade')) {
    const j = loadJournal().filter(t => t.pnl !== null && t.pnl !== undefined);
    if (!j.length) return 'No trades with PnL logged yet.';
    if (lower.includes('best')) {
      const best = j.reduce((b, t) => t.pnl > b.pnl ? t : b);
      return `Best trade: ${best.userText?.slice(0, 80)} — PnL: $${best.pnl}`;
    }
    const worst = j.reduce((w, t) => t.pnl < w.pnl ? t : w);
    return `Worst trade: ${worst.userText?.slice(0, 80)} — PnL: $${worst.pnl}`;
  }
  if (lower.includes('my recap') || lower.includes('recap today') || lower.includes('how did i do')) {
    const j   = loadJournal().filter(t => Date.now() - t.timestamp < 86400000);
    const btc = await getCryptoPrice('btc');
    const fg  = await getFearGreed();
    return `Today: ${j.length} trades logged. ${btc || ''}. ${fg || ''}.`;
  }

  // ── 10. PRE-TRADE CHECKLIST ──────────────────────────────────────────────
  if (lower.includes('checklist') || lower.includes('before i trade') || lower.includes('pre-trade')) {
    return `Pre-trade checklist: ${loadChecklist().join('. ')}`;
  }
  if (lower.includes('add to checklist')) {
    const item = userText.replace(/add to checklist/gi, '').trim();
    const cl   = loadChecklist(); cl.push(item); saveChecklist(cl);
    return `Added to your checklist.`;
  }

  // ── 11. TRADING DISCIPLINE ───────────────────────────────────────────────
  if (lower.includes('revenge') || (lower.includes('just lost') && lower.includes('want to'))) {
    return "That sounds like a revenge trade. Wait 30 minutes before doing anything. Emotional trading almost always loses.";
  }
  if (lower.includes('fomo') || (lower.includes('already up') && lower.includes('should i buy'))) {
    return "Buying something already pumping hard is FOMO. Wait for a pullback or stay out.";
  }
  if (mem.tradeCount > 6 && (lower.includes('trade') || lower.includes('long') || lower.includes('short'))) {
    return `You've made ${mem.tradeCount} trades today. That's a lot — are you overtrading?`;
  }

  const isWatchlistCmd = lower.includes('watchlist') || lower.includes('watch list');
  if (isWatchlistCmd && (lower.includes('add') || lower.includes('track'))) {
    // Try COIN_MAP first, then extract any uppercase ticker or word after "add"
    let coin = Object.keys(COIN_MAP).find(k => lower.includes(k));
    if (!coin) {
      const tickerMatch = userText.match(/\b([A-Z]{2,10})\b/);
      const afterAdd = userText.match(/(?:add|track)\s+(\w+)/i);
      coin = tickerMatch?.[1]?.toLowerCase() || afterAdd?.[1]?.toLowerCase();
    }
    if (coin) {
      settings.watchlist = settings.watchlist || [];
      if (!settings.watchlist.includes(coin)) settings.watchlist.push(coin);
      saveSettings(settings); return `Added ${coin.toUpperCase()} to watchlist.`;
    }
    return 'Which coin do you want to add to watchlist?';
  }
  if (isWatchlistCmd && lower.includes('remove')) {
    let coin = Object.keys(COIN_MAP).find(k => lower.includes(k));
    if (!coin) {
      const afterRemove = userText.match(/remove\s+(\w+)/i);
      coin = afterRemove?.[1]?.toLowerCase();
    }
    if (coin) {
      settings.watchlist = (settings.watchlist || []).filter(c => c !== coin);
      saveSettings(settings); return `Removed ${coin.toUpperCase()} from watchlist.`;
    }
  }

  if (lower.includes('alert me when') || lower.includes('notify me when') || lower.includes('tell me when')) {
    const coin  = Object.keys(COIN_MAP).find(k => lower.includes(k));
    const pMatch= userText.match(/\$?([\d,]+\.?\d*)[k]?/);
    if (coin && pMatch) {
      let target = parseFloat(pMatch[1].replace(/,/g, ''));
      if (lower.includes('k')) target *= 1000;
      const alerts = loadAlerts();
      const p = await getCryptoPrice(coin);
      const current = p ? parseFloat(p.match(/\$([\d,]+)/)?.[1]?.replace(/,/g, '') || 0) : 0;
      alerts.push({ id: Date.now().toString(), coin, target, direction: target > current ? 'above' : 'below', triggered: false });
      saveAlerts(alerts); return `Alert set for ${coin.toUpperCase()} at $${target.toLocaleString()}.`;
    }
  }

  if (lower.includes('dca') || (lower.includes('every') && lower.includes('into') && coinInMsg)) {
    const coin    = coinInMsg;
    const amtMatch= lower.match(/\$?(\d+)/);
    const freqMatch= lower.match(/every (day|week|month)/);
    if (coin && amtMatch && freqMatch) {
      mem.dcaSchedule = mem.dcaSchedule || [];
      mem.dcaSchedule.push({ coin, amount: amtMatch[1], frequency: freqMatch[1] + 'ly', lastDone: null });
      saveMemory(mem); return `DCA saved: $${amtMatch[1]} into ${coin.toUpperCase()} every ${freqMatch[1]}.`;
    }
  }

  // ── 15. RISK CALCULATOR ──────────────────────────────────────────────────
  if (lower.includes('liquidat') || (lower.match(/\d+x/) && lower.includes('usdt'))) {
    const lev = parseInt(lower.match(/(\d+)x/)?.[1] || 10);
    const amt = parseInt(lower.match(/(\d+)\s*usdt/i)?.[1] || 100);
    return `${lev}x on $${amt} USDT — liquidation at ${(100/lev).toFixed(1)}% move against you. Set a stop loss well before that.`;
  }

  // ── 16. CONTRACT SCAN ────────────────────────────────────────────────────
  const caMatch = userText.match(/0x[a-fA-F0-9]{40}/);
  if (caMatch) {
    // Detect chain from URL context
    let chainHint = '1'; // default ethereum
    if (lower.includes('/bsc/') || lower.includes('bscscan') || lower.includes('bnb'))  chainHint = '56';
    if (lower.includes('/polygon/') || lower.includes('polygonscan'))                    chainHint = '137';
    if (lower.includes('/arbitrum/') || lower.includes('arbiscan'))                      chainHint = '42161';
    if (lower.includes('/base/') || lower.includes('basescan'))                          chainHint = '8453';
    if (lower.includes('dexview.com/bsc') || lower.includes('dexscreener.com/bsc'))     chainHint = '56';
    if (lower.includes('dexview.com/eth') || lower.includes('dexscreener.com/ethereum'))chainHint = '1';
    return await scanContract(caMatch[0], chainHint);
  }
  if (lower.includes('check this ca') || lower.includes('scan this') || lower.includes('check ca')) {
    if (mainWindow) mainWindow.webContents.send('open-chat-for-ca');
    return 'Sure, paste the contract address in the chat.';
  }
  if (lower.includes('is this a scam') || lower.includes('check this message') || lower.includes('got a dm') || lower.includes('someone sent me')) {
    return await getAIReply(`Analyze this for scam signals, be blunt: ${userText}`);
  }

  // ── 17. COIN DEEP DIVE ───────────────────────────────────────────────────
  if ((lower.includes('tell me everything about') || lower.includes('deep dive') || lower.includes('full analysis')) && coinInMsg) {
    const price = await getCryptoPrice(coinInMsg);
    const fr    = await getFundingRate(coinInMsg.toUpperCase());
    return await getAIReply(`Give a complete analysis of ${coinInMsg.toUpperCase()}: ${price || ''}. ${fr || ''}. Cover trend, sentiment, whale activity, risks, your honest opinion. 2-3 sentences.`);
  }

  if (lower.includes('news') || lower.includes('what happened') || lower.includes('catch me up') || lower.includes('what did i miss')) {
    if (lower.includes('tell me') || lower.includes('give me') || lower.includes('today') || lower.includes('latest') || lower.includes('now')) {
      let headlines = await getCryptoNews();
      if (headlines) return await getAIReply(`Summarize these crypto news in 2-3 punchy sentences, most important first: ${headlines}`);
      return await getAIReply('What are the top 3-4 most important crypto news and market events from the last 24 hours? Be specific and direct.');
    }
    if (mainWindow) mainWindow.webContents.send('ask-news-briefing');
    return 'Want me to pull the latest crypto news?';
  }

  // ── 19. MORNING BRIEFING ─────────────────────────────────────────────────
  if (lower.includes('morning briefing') || lower.includes('market update') || lower.includes('whats happening')) {
    const btc  = await getCryptoPrice('btc');
    const eth  = await getCryptoPrice('eth');
    const fg   = await getFearGreed();
    const sess = getMarketSession();
    return `${btc || ''}. ${eth || ''}. ${fg || ''}. ${sess}.`;
  }

  // ── 20. BRIDGE / YIELDS / NFT ────────────────────────────────────────────
  if (lower.includes('bridge') && (lower.includes('to') || lower.includes('from'))) {
    const chains = ['ethereum','arbitrum','optimism','base','polygon','bsc'];
    const from   = chains.find(c => lower.includes('from ' + c)) || 'ethereum';
    const to     = chains.find(c => lower.includes('to ' + c) && c !== from) || 'arbitrum';
    const bridges = {
      'ethereum-arbitrum': 'Use bridge.arbitrum.io — official, cheapest, ~5min',
      'ethereum-optimism': 'Use app.optimism.io — official, ~1min',
      'ethereum-base': 'Use bridge.base.org — official',
      'ethereum-polygon': 'Use portal.polygon.technology — official',
    };
    return bridges[`${from}-${to}`] || `Check stargate.finance for ${from} to ${to}`;
  }

  if (lower.includes('airdrop')) {
    return await getAIReply('What are the most promising upcoming crypto airdrops right now? Which protocols have rumored tokens with active testnets? 2 sentences, specific projects only.');
  }

  // ── 22. COPY TRADE / WALLETS ─────────────────────────────────────────────
  if (lower.includes('copy trade') || lower.includes('follow this wallet') || lower.includes('track this wallet') || lower.includes('add wallet') || lower.includes('track wallet')) {
    // Match ETH address (0x...) or Solana address (base58, 32-44 chars)
    const ethMatch = userText.match(/0x[a-fA-F0-9]{40}/);
    const solMatch = userText.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    const walletAddr = ethMatch?.[0] || solMatch?.[0];
    
    if (walletAddr) {
      settings.trackedWallets = settings.trackedWallets || [];
      const label = `Wallet ${settings.trackedWallets.length + 1}`;
      settings.trackedWallets.push({ address: walletAddr, label, addedAt: Date.now() });
      saveSettings(settings);
      return `Got it! Now tracking ${label}: ${walletAddr.slice(0, 8)}...${walletAddr.slice(-6)}. I'll monitor their trades and alert you to big moves.`;
    }
    return 'Paste the wallet address you want to track — ETH (0x...) or Solana address.';
  }

  // ── 23. TOKEN UNLOCK / FED ───────────────────────────────────────────────
  if (lower.includes('token unlock') || lower.includes('fed meeting') || lower.includes('upcoming events') || lower.includes('calendar')) {
    return await getAIReply('What are the major token unlocks, FED meetings, and crypto events in the next 30 days? Be specific with dates. 2 sentences.');
  }

  // ── 24. MEMECOIN META ────────────────────────────────────────────────────
  if (lower.includes('memecoin') || lower.includes('what narrative') || lower.includes('what meta') || lower.includes('trending narrative')) {
    return await getAIReply('What is the hottest memecoin narrative right now — AI coins, dog coins, political coins, gaming? Which meta is trending? 1-2 sentences.');
  }

  // ── 25. SOCIAL SENTIMENT ─────────────────────────────────────────────────
  if (lower.includes('sentiment') || lower.includes('what are people saying') || lower.includes('twitter says')) {
    const coin = Object.keys(COIN_MAP).find(k => lower.includes(k)) || 'bitcoin';
    return await getAIReply(`What is the current social sentiment for ${coin}? Twitter/Reddit — bullish, bearish, neutral? Any big influencer calls? 1-2 sentences.`);
  }

  // ── 26. PROFIT TAKING ────────────────────────────────────────────────────
  if (lower.includes('take profit') || lower.includes('should i take') || (lower.includes('up') && lower.includes('should i sell'))) {
    return await getAIReply(`${userText}. Should they take some profit? What does historical data suggest? 2 sentences, mention you're an AI.`);
  }

  if (lower.includes('whitepaper') || lower.includes('analyze this pdf')) {
    return 'Drop the PDF on my window and I will analyze it for you.';
  }

  // ── 28. EXPORT / RESTORE ─────────────────────────────────────────────────
  if (lower.includes('export') || lower.includes('backup my data')) {
    return await exportAllData();
  }
  if (lower.includes('restore backup') || lower.includes('import backup')) {
    return 'Drop your backup JSON file on my window to restore.';
  }

  // ── 29. PORTFOLIO / WALLET ───────────────────────────────────────────────
  if (lower.includes('my portfolio') || lower.includes('check my wallet') || lower.includes('how much do i have')) {
    if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); }
    else createDashboardWindow();
    return 'Opening your portfolio in the dashboard.';
  }

  if (lower.includes('open dashboard') || lower.includes('show dashboard')) {
    if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); }
    else createDashboardWindow();
    return 'Opening dashboard.';
  }

  if (lower.includes('take a break') || lower.includes('need a break')) {
    mem.chartStartTime = null; chartAlertFired = false; saveMemory(mem);
    return 'Step away for at least 15 minutes. Your brain needs it.';
  }

  // ── 32. PERSONAL ASSISTANT ───────────────────────────────────────────────
  // Note: Weather and time are handled above in sections 35 and 44

  // ── 33. VISION — SCREEN ──────────────────────────────────────────────────
  const screenTriggers = ['look at my screen','what is on my screen','whats on my screen','analyze my screen','what do you see on screen'];
  if (screenTriggers.some(t => lower.includes(t))) {
    const reply = await takeScreenshot(userText);
    return reply;
  }

  // ── 34. VISION — WEBCAM context aware ───────────────────────────────────
  const webcamTriggers = ['look at me','can you see me','can u see me','do you see me','what am i doing','what do i look like','are you watching me'];
  if (webcamTriggers.some(t => lower.includes(t))) {
    lastCameraUsed = Date.now();
    if (mainWindow) mainWindow.webContents.send('look-at-me-now');
    return 'Looking at you now.';
  }
  // Generic "what do you see" — use camera if recently used, else screen
  if (lower.includes('what do you see') || lower.includes('what do u see') || lower.includes('see this')) {
    if (Date.now() - lastCameraUsed < 120000) {
      mainWindow.webContents.send('look-at-me-now'); return 'Looking at you.';
    }
    return await takeScreenshot(userText);
  }

  if (['stop watching','look away','stop camera','camera off','turn off camera'].some(t => lower.includes(t))) {
    lastCameraUsed = 0;
    if (mainWindow) mainWindow.webContents.send('stop-webcam');
    return 'Camera off.';
  }

  // ── 36. COMPUTER ACTIONS ─────────────────────────────────────────────────
  const actionResult = doAction(lower);
  if (actionResult) return actionResult;

  const notWatchlist = !lower.includes('watchlist') && !lower.includes('watch list');
  const openTriggers = ['open ','play ','show me','find me','search '];
  const watchTrigger = lower.includes('watch ') && notWatchlist;
  if (watchTrigger || openTriggers.some(t => lower.includes(t))) {
    const result = await smartOpen(userText);
    if (result) return result;
  }

  // ── 35. WEATHER ──────────────────────────────────────────────────────────
  if (lower.includes('weather') || lower.includes('temperature') || lower.includes('forecast') || lower.includes('hot outside') || lower.includes('cold outside') || lower.includes('raining')) {
    const cityMatch = userText.match(/weather (?:in|at|for) (.+)/i) || userText.match(/(?:in|at) (.+?) weather/i);
    const city = cityMatch?.[1]?.trim() || null;
    if (!city) {
      // Auto detect location
      const loc = await getUserLocation();
      return await getWeather(loc?.city || null);
    }
    return await getWeather(city);
  }

  // ── 36. STOCKS & FOREX ───────────────────────────────────────────────────
  if (lower.includes('stock') || lower.includes('share price') || lower.includes('stock price') || /\b(aapl|tsla|msft|googl|amzn|nvda|meta|nflx|amd|spy|qqq|apple|tesla|microsoft|google|amazon|nvidia|netflix|disney|uber|airbnb|paypal)\b/i.test(lower)) {
    // Extract company name or ticker
    const companies = ['apple','microsoft','google','amazon','tesla','nvidia','meta','netflix','disney','uber','airbnb','paypal','samsung','snapchat','shopify','intel'];
    const foundCompany = companies.find(c => lower.includes(c));
    if (foundCompany) return await getStockPrice(foundCompany);
    const tickerMatch = userText.match(/\b([A-Z]{2,5})\b/);
    const symbol = tickerMatch?.[1] || 'SPY';
    return await getStockPrice(symbol);
  }
  if (lower.includes('forex') || lower.includes('exchange rate') || lower.includes('usd to') || lower.includes('convert currency')) {
    const fromMatch = userText.match(/(\w+) to (\w+)/i);
    const from = fromMatch?.[1]?.toUpperCase() || 'USD';
    const to = fromMatch?.[2]?.toUpperCase() || 'AED';
    return await getForexRate(from, to);
  }

  // ── 37. GENERAL NEWS ─────────────────────────────────────────────────────
  if ((lower.includes('news') || lower.includes('headlines') || lower.includes('what happened') || lower.includes('whats happening') || lower.includes("what's happening")) && !lower.includes('crypto') && !lower.includes('bitcoin') && !lower.includes('btc')) {
    const topicMatch = userText.match(/news (?:about|on) (.+)/i) || userText.match(/(?:about|on|for) (.+?) news/i);
    const topic = topicMatch?.[1] || null;
    return await getGeneralNews(topic);
  }
  if (lower.includes('tech news') || lower.includes('hacker news') || lower.includes('trending tech')) {
    return await getHackerNews();
  }
  if (lower.includes('reddit') || lower.includes('what people saying') || lower.includes('crypto reddit')) {
    const subMatch = userText.match(/r\/(\w+)/i) || userText.match(/reddit (\w+)/i);
    const sub = subMatch?.[1] || 'CryptoCurrency';
    return await getRedditPosts(sub);
  }

  // ── 38. MOVIES & TV ──────────────────────────────────────────────────────
  if (lower.includes('movie') || lower.includes('film') || lower.includes('watch tonight') || lower.includes('what to watch')) {
    // Check if asking about specific movie
    const specificMovie = userText.match(/(?:tell me about|info on|about the movie|movie called) (.+)/i);
    if (specificMovie) return await getMovieInfo(specificMovie[1].trim());
    
    // Check if asking for recommendations
    if (lower.includes('recommend') || lower.includes('suggest') || lower.includes('what to watch') || lower.includes('watch tonight')) {
      const genreMatch = userText.match(/(?:recommend|suggest|good) (.+?) (?:movie|film)/i) || userText.match(/(?:action|comedy|horror|thriller|romance|sci.fi|drama|animation)/i);
      const genre = genreMatch?.[1] || genreMatch?.[0] || 'action';
      const isNew = lower.includes('new') || lower.includes('latest') || lower.includes('recent') || lower.includes('2024') || lower.includes('2025') || lower.includes('2026');
      const year = isNew ? '2025' : null;
      return await getMovieRecommendations(genre, year);
    }
    
    // Generic movie request — ask what they want
    return 'Sure! Are you looking for a specific movie or want me to recommend something? If recommending — any genre preference? Action, comedy, thriller, horror?';
  }

  // ── 39. SPOTIFY ───────────────────────────────────────────────────────────
  if (lower.includes('spotify') || (lower.includes('play') && lower.includes('spotify'))) {
    const songMatch = userText.match(/play (.+?) (?:on spotify|spotify)/i) || userText.match(/spotify (.+)/i);
    const query = songMatch?.[1] || userText.replace(/play|spotify|on/gi, '').trim();
    return await playOnSpotify(query);
  }

  // ── 40. YOUTUBE OR SPOTIFY CHOICE ────────────────────────────────────────
  if (lower.includes('play') && !lower.includes('youtube') && !lower.includes('spotify')) {
    const mem = loadMemory();
    const preferred = mem.musicPlatform || null;
    if (!preferred) {
      // Ask user preference — store it
      return 'YouTube or Spotify? Just say which one and I\'ll remember for next time.';
    }
    const query = userText.replace(/play/gi, '').trim();
    if (preferred === 'spotify') return await playOnSpotify(query);
    // Default YouTube handled by existing router
  }

  // ── 41. RECIPES ──────────────────────────────────────────────────────────
  if (lower.includes('recipe') || lower.includes('how to cook') || lower.includes('how to make') || lower.includes('ingredients for')) {
    const query = userText.replace(/recipe|how to cook|how to make|ingredients for/gi, '').trim();
    return await getRecipe(query || 'pasta');
  }

  // ── 42. WIKIPEDIA ────────────────────────────────────────────────────────
  if (lower.includes('what is') || lower.includes('who is') || lower.includes('tell me about') || lower.includes('wikipedia')) {
    const query = userText.replace(/what is|who is|tell me about|wikipedia/gi, '').trim();
    if (query.length > 2) return await getWikipediaSummary(query);
  }

  // ── 43. DICTIONARY ───────────────────────────────────────────────────────
  if (lower.includes('define') || lower.includes('definition of') || lower.includes('what does') || lower.includes('meaning of')) {
    const word = userText.replace(/define|definition of|what does|meaning of|mean/gi, '').trim().split(' ')[0];
    if (word) return await getDefinition(word);
  }

  // ── 44. TIME IN CITY ─────────────────────────────────────────────────────
  if (lower.includes('what time') || lower.includes('time in') || lower.includes('current time in')) {
    const cityMatch = userText.match(/time in (.+)/i) || userText.match(/what time is it in (.+)/i);
    if (cityMatch?.[1]) return await getTimeInCity(cityMatch[1].trim());
    return `Current time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  }

  // ── 45. TELEGRAM SIGNALS ─────────────────────────────────────────────────
  if (lower.includes('telegram signal') || lower.includes('tg signal') || lower.includes('caller stats') || lower.includes('who to follow')) {
    const td = loadTelegramData();
    if (!td.connected) return 'Telegram not connected. Say "connect Telegram" to set it up.';
    const stats = Object.entries(td.callerStats)
      .sort((a, b) => b[1].winRate - a[1].winRate)
      .slice(0, 5)
      .map(([caller, s]) => `${caller}: ${s.winRate}% win rate (${s.total} calls)`)
      .join(', ');
    return stats || 'No caller stats yet — need more signals tracked.';
  }

  if (lower.includes('monitor') && lower.includes('group')) {
    return 'To monitor a Telegram group say the group name or go to Settings → Telegram to add it.';
  }

  // ── 46. PAPER TRADING STATUS ─────────────────────────────────────────────
  if (lower.includes('paper trade') || lower.includes('paper trading') || lower.includes('my trades') || lower.includes('trading performance') || lower.includes('win rate') || lower.includes('paper balance') || lower.includes('open position') || lower.includes('trading loss') || lower.includes('trading profit') || lower.includes('close my trade') || lower.includes('take profit') || lower.includes('take the loss') || lower.includes('should i close')) {
    const pd = loadPaperTrades();
    const open = pd.trades.filter(t => t.status === 'open');
    const closed = pd.trades.filter(t => t.status !== 'open');
    const winRate = closed.length ? Math.round(pd.stats.wins / closed.length * 100) : 0;

    let response = `Paper balance: $${pd.balance.toFixed(0)} | Win rate: ${winRate}% (${pd.stats.wins}W/${pd.stats.losses}L) | Total P&L: ${pd.stats.totalPnl >= 0 ? '+' : ''}$${pd.stats.totalPnl.toFixed(2)}`;

    if (open.length) {
      for (const t of open) {
        try {
          const priceStr = await getCryptoPrice(t.coin.toLowerCase());
          const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
          const currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
          if (currentPrice) {
            const leverage = t.leverage || 1;
            const priceDiff = t.direction === 'long' ? currentPrice - t.entry : t.entry - currentPrice;
            const pnlPct = (priceDiff / t.entry * leverage * 100).toFixed(1);
            const pnlDollar = (t.size * priceDiff / t.entry * leverage).toFixed(2);
            const isProfit = parseFloat(pnlDollar) >= 0;
            response += ` | ${t.direction?.toUpperCase()} ${t.coin} ${t.leverage > 1 ? t.leverage + 'x' : ''}: current $${currentPrice} (${isProfit ? '+' : ''}${pnlPct}% = ${isProfit ? '+' : ''}$${pnlDollar})`;

            // Give advice if asked
            if (lower.includes('should i close') || lower.includes('close my') || lower.includes('take the loss') || lower.includes('take profit')) {
              if (isProfit) {
                response += `. You're up ${pnlPct}% — consider taking partial profit if near target ($${t.target}).`;
              } else {
                const lossFromSL = t.stopLoss ? ((Math.abs(currentPrice - t.stopLoss) / t.entry * 100)).toFixed(1) : null;
                response += `. You're down ${Math.abs(pnlPct)}%. Stop loss is at $${t.stopLoss}${lossFromSL ? ` (${lossFromSL}% away)` : ''}. If thesis broken — cut. If still valid — hold to SL.`;
              }
            }
          }
        } catch(e) {}
      }
    } else {
      response += ' | No open positions';
    }
    return response;
  }

  // ── 38. WAKE WORD ONLY ───────────────────────────────────────────────────
  if (mem.wakeName && lower === mem.wakeName.toLowerCase()) {
    return `Yeah? What's up${mem.name ? ' ' + mem.name : ''}?`;
  }

  // ── 39. DEFAULT — CLAUDE SONNET ──────────────────────────────────────────
  return await getAIReply(userText);
}

// ─── WINDOWS ───────────────────────────────────────────────────────────────
let mainWindow, dashboardWindow;

function createWaifuWindow() {
  mainWindow = new BrowserWindow({
    width: 400, height: 750, transparent: true, frame: false, alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false, allowRunningInsecureContent: true }
  });
  mainWindow.loadFile('waifu.html');
  
  // Flush queued intel events when window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      while (intelQueue.length > 0) {
        mainWindow.webContents.send('intel-event', intelQueue.shift());
      }
    }, 2000); // Wait 2s for dashboard to init
  });
  mainWindow.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  mainWindow.webContents.session.setPermissionCheckHandler(() => true);
  // Allow all network requests including Vapi
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });
}

function createDashboardWindow() {
  if (dashboardWindow) { dashboardWindow.show(); dashboardWindow.focus(); return; }
  dashboardWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    frame: true, title: 'Asuka — Dashboard',
    webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false }
  });
  dashboardWindow.loadFile('dashboard.html');
  
  // Flush queued intel events when dashboard loads
  dashboardWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      const queueCopy = [...intelQueue];
      intelQueue.length = 0;
      queueCopy.forEach(item => dashboardWindow?.webContents.send('intel-event', item));
      console.log(`📡 Flushed ${queueCopy.length} queued intel events to dashboard`);
    }, 1500);
  });
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
    if (mainWindow) { mainWindow.show(); mainWindow.setAlwaysOnTop(true); mainWindow.webContents.send('start-recording'); }
  });
}

// ─── IPC HANDLERS ──────────────────────────────────────────────────────────
ipcMain.on('move-waifu', (e, { dx, dy }) => {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + dx, y + dy);
});
ipcMain.on('open-browser', (e, url) => shell.openExternal(url));
ipcMain.on('open-dashboard', () => {
  if (mainWindow) { mainWindow.webContents.send('stop-recording'); mainWindow.setAlwaysOnTop(false); mainWindow.hide(); }
  createDashboardWindow();
});
ipcMain.on('dashboard-closed', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.setAlwaysOnTop(true); mainWindow.webContents.send('start-recording'); }
});

// Data handlers
// ── GEMINI LIVE HANDLERS ───────────────────────────────────────────────────
// ─── TIERED MEMORY SYSTEM ─────────────────────────────────────────────────
const LONG_MEMORY_FILE    = path.join(DATA_DIR, 'long-memory.json');
const SESSION_FILE        = path.join(DATA_DIR, 'active-session.json');
const PATTERNS_FILE       = path.join(DATA_DIR, 'patterns.json');

function loadLongMemory() { return loadJSON(LONG_MEMORY_FILE, { fresh: [], medium: [], longterm: [], corefacts: [], lastCompressed: null }); }
function saveLongMemory(m) { saveJSON(LONG_MEMORY_FILE, m); }
function loadPatterns() { return loadJSON(PATTERNS_FILE, []); }
function savePatterns(p) { saveJSON(PATTERNS_FILE, p); }

// Active session — saves every message in real time for pipeline handoff
function saveActiveSession(messages, context = {}) {
  saveJSON(SESSION_FILE, { messages: messages.slice(-20), context, updatedAt: Date.now() });
}
function loadActiveSession() { return loadJSON(SESSION_FILE, { messages: [], context: {} }); }
function clearActiveSession() { saveJSON(SESSION_FILE, { messages: [], context: {}, updatedAt: Date.now() }); }

// After conversation ends — extract learnings
async function extractConversationLearnings(messages) {
  if (!messages || messages.length < 3) return null;
  try {
    const convo = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 300,
      messages: [{ role: 'user', content: `Analyze this conversation and extract key learnings about the user in 3-5 bullet points. Focus on: trading behavior, emotional patterns, preferences, mistakes, wins, rules mentioned. Be specific and factual. Format as bullet points only.\n\n${convo}` }]
    });
    return res.content[0].text;
  } catch(e) { return null; }
}

// Compress old memories — runs weekly
async function compressMemories() {
  const lm = loadLongMemory();
  const now = Date.now();
  const oneWeek = 7 * 86400000;
  const oneMonth = 30 * 86400000;

  // Move fresh memories older than 7 days to medium
  const stillFresh = [];
  const toMedium = [];
  for (const m of lm.fresh) {
    if (now - m.timestamp > oneWeek) toMedium.push(m);
    else stillFresh.push(m);
  }

  if (toMedium.length > 0) {
    // Summarize them into one medium memory
    const combined = toMedium.map(m => m.summary).join('\n');
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 200,
      messages: [{ role: 'user', content: `Summarize these conversation learnings into one concise paragraph:\n${combined}` }]
    });
    lm.medium.push({ summary: res.content[0].text, timestamp: now, count: toMedium.length });
    lm.fresh = stillFresh;
  }

  // Move medium memories older than 30 days to longterm
  const stillMedium = [];
  const toLongterm = [];
  for (const m of lm.medium) {
    if (now - m.timestamp > oneMonth) toLongterm.push(m);
    else stillMedium.push(m);
  }

  if (toLongterm.length > 0) {
    const combined = toLongterm.map(m => m.summary).join('\n');
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 150,
      messages: [{ role: 'user', content: `Extract 3-5 core facts about this user's trading behavior from these summaries:\n${combined}` }]
    });
    lm.longterm.push({ summary: res.content[0].text, timestamp: now });
    lm.medium = stillMedium;
  }

  lm.lastCompressed = now;
  saveLongMemory(lm);
}

// Build memory context for injection into prompts
function buildMemoryContext() {
  const lm = loadLongMemory();
  const patterns = loadPatterns();
  let ctx = '';

  if (lm.corefacts?.length > 0) {
    ctx += '\nCORE FACTS ABOUT THIS USER:\n' + lm.corefacts.slice(-5).map(f => f.fact).join('\n');
  }
  if (lm.longterm?.length > 0) {
    ctx += '\n\nLONG TERM PATTERNS:\n' + lm.longterm.slice(-3).map(m => m.summary).join('\n');
  }
  if (lm.medium?.length > 0) {
    ctx += '\n\nRECENT PATTERNS (last 30 days):\n' + lm.medium.slice(-3).map(m => m.summary).join('\n');
  }
  if (lm.fresh?.length > 0) {
    ctx += '\n\nRECENT LEARNINGS (last 7 days):\n' + lm.fresh.slice(-5).map(m => m.summary).join('\n');
  }
  if (patterns?.length > 0) {
    ctx += '\n\nBEHAVIOR PATTERNS DETECTED:\n' + patterns.slice(-5).map(p => `- ${p.pattern}`).join('\n');
  }
  return ctx;
}

// Save a new learning to fresh memory
function saveNewLearning(summary) {
  if (!summary) return;
  const lm = loadLongMemory();
  lm.fresh = lm.fresh || [];
  lm.fresh.push({ summary, timestamp: Date.now() });
  if (lm.fresh.length > 50) lm.fresh = lm.fresh.slice(-50);
  saveLongMemory(lm);
}

// ─── GROK VOICE AGENT (disabled — re-enable when needed)
// ─── GROK VOICE — runs entirely in main.js Node.js, no browser restrictions ──
let grokWsNode     = null;
let grokSessionReady = false;
let grokCurrentText = '';

function startGrokNodeWS() {
  const apiKey = process.env.GROK_VOICE_API_KEY || process.env.XAI_API_KEY;
  if (!apiKey) { console.error('No GROK_VOICE_API_KEY'); return; }

  const WebSocket = require('ws');
  console.log('Grok connecting — API key starts with:', apiKey.slice(0, 10));
  grokWsNode = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
    handshakeTimeout: 10000,
  });

  grokWsNode.on('open', () => {
    console.log('Grok Node WebSocket opened');

    // Keepalive ping every 4 minutes to prevent 15min timeout
    const keepAlive = setInterval(() => {
      if (grokWsNode?.readyState === 1) {
        grokWsNode.ping();
      } else {
        clearInterval(keepAlive);
      }
    }, 4 * 60 * 1000);
    grokWsNode._keepAlive = keepAlive;
    // Send session config
    grokWsNode.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: buildSystemPrompt() + buildMemoryContext() + `\n\nCRITICAL TOOL RULES:\n- For ANY price, funding, fear&greed, dominance, gas → use get_market_data tool\n- For EVERYTHING else (watchlist, notes, YouTube, alerts, journal, portfolio, news, analysis) → use ask_claude tool\n- NEVER answer from memory for market data or commands — always use the tools`,
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.3,
          prefix_padding_ms: 100,
          silence_duration_ms: 300,
        },
        tools: [
          {
            type: 'function',
            name: 'ask_claude',
            description: 'Use for EVERYTHING except live market data. This includes: watchlist (add/remove coins), price alerts, notes, reminders, play YouTube music, open websites, trading journal, portfolio, contract scan, whale analysis, trading advice, morning briefing, news, and any other command.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: 'The full user request exactly as they said it' } },
              required: ['query']
            }
          },
          {
            type: 'function',
            name: 'get_market_data',
            description: 'Get live crypto price, funding rate, fear and greed, dominance, gas',
            parameters: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['price','funding','feargreed','dominance','gas'] },
                coin: { type: 'string' }
              },
              required: ['type']
            }
          }
        ],
        tool_choice: 'auto',
      }
    }));
  });

  grokWsNode.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('Grok Node msg:', msg.type);

      switch(msg.type) {
        case 'session.created':
        case 'session.updated':
          grokSessionReady = true;
          console.log('Grok session ready');
          if (mainWindow) mainWindow.webContents.send('grok-ready');
          break;

        case 'input_audio_buffer.speech_started':
          if (mainWindow) mainWindow.webContents.send('grok-speech-started');
          break;

        case 'input_audio_buffer.speech_stopped':
          grokWsNode.send(JSON.stringify({ type: 'response.create' }));
          break;

        case 'response.audio_transcript.delta':
          grokCurrentText += (msg.delta || '');
          break;

        case 'response.audio_transcript.done':
        case 'response.text.done':
          const text = msg.text || grokCurrentText;
          if (text && mainWindow) {
            console.log('Grok response:', text.slice(0, 80));
            mainWindow.webContents.send('grok-response', text);
          }
          grokCurrentText = '';
          break;

        case 'response.function_call_arguments.done':
          // Handle tool calls
          try {
            const args = JSON.parse(msg.arguments || '{}');
            let result = '';
            if (msg.name === 'ask_claude') result = await routeCommand(args.query || '');
            else if (msg.name === 'get_market_data') {
              const type = args.type;
              const coin = args.coin || 'BTC';
              switch(type) {
                case 'price': result = await getCryptoPrice(coin) || 'Could not fetch'; break;
                case 'funding': result = await getFundingRate(coin); break;
                case 'feargreed': result = await getFearGreed(); break;
                case 'dominance': result = await getDominance(); break;
                case 'gas': result = await getGasFees() || 'Could not fetch'; break;
              }
            }
            grokWsNode.send(JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'function_call_output', call_id: msg.call_id, output: result || 'No data' }
            }));
            grokWsNode.send(JSON.stringify({ type: 'response.create' }));
          } catch(e) { console.error('Grok tool error:', e.message); }
          break;

        case 'error':
          console.error('Grok error:', msg.error);
          if (mainWindow) mainWindow.webContents.send('grok-error', msg.error?.message || 'Unknown error');
          break;
      }
    } catch(e) { console.error('Grok msg parse error:', e.message); }
  });

  grokWsNode.on('error', (e) => {
    console.error('Grok Node WS error:', e.message);
    grokSessionReady = false;
    if (mainWindow) mainWindow.webContents.send('grok-error', e.message);
  });

  grokWsNode.on('close', (code, reason) => {
    console.log('Grok Node WS closed — code:', code, 'reason:', reason.toString());
    if (grokWsNode?._keepAlive) clearInterval(grokWsNode._keepAlive);
    grokSessionReady = false;
    grokWsNode = null;
    const reasonStr = reason.toString();
    // Auto reconnect on timeout
    if (code === 1000 && reasonStr.includes('timeout')) {
      console.log('Grok timed out — reconnecting...');
      if (mainWindow) mainWindow.webContents.send('grok-reconnecting');
      setTimeout(() => startGrokNodeWS(), 1000);
    } else {
      if (mainWindow) mainWindow.webContents.send('grok-closed', code);
    }
  });
}

// IPC handlers for Grok
// Fast audio chunk handler — fire and forget, no reply needed
ipcMain.on('grok-audio-chunk', (e, base64Audio) => {
  if (!grokWsNode || grokWsNode.readyState !== 1 || !grokSessionReady) return;
  try {
    grokWsNode.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    }));
  } catch(e) {}
});

ipcMain.handle('grok-start', async () => {
  try {
    if (grokWsNode) { try { grokWsNode.close(); } catch(e) {} grokWsNode = null; }
    startGrokNodeWS();
    return { success: true };
  } catch(e) {
    console.error('grok-start error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('grok-send-audio', async (e, base64Audio) => {
  if (!grokWsNode || grokWsNode.readyState !== 1 || !grokSessionReady) return false;
  try {
    grokWsNode.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    }));
    return true;
  } catch(e) { return false; }
});

ipcMain.handle('grok-send-text', async (e, text) => {
  if (!grokWsNode || grokWsNode.readyState !== 1) return false;
  try {
    grokWsNode.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
    }));
    grokWsNode.send(JSON.stringify({ type: 'response.create' }));
    return true;
  } catch(e) { return false; }
});

ipcMain.handle('grok-force-response', async () => {
  if (!grokWsNode || grokWsNode.readyState !== 1) return false;
  try {
    grokWsNode.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    grokWsNode.send(JSON.stringify({ type: 'response.create' }));
    return true;
  } catch(e) { return false; }
});

ipcMain.handle('grok-stop', async () => {
  if (grokWsNode) { try { grokWsNode.close(1000); } catch(e) {} grokWsNode = null; }
  grokSessionReady = false;
  return true;
});



// Terminal logging from renderer
ipcMain.on('log', (e, ...args) => console.log('[APP]', ...args));

ipcMain.handle('get-gemini-key', async () => {
  const key = process.env.GEMINI_API_KEY;
  if (key) console.log('Gemini API key loaded:', key.slice(0, 10) + '...');
  return key || null;
});
ipcMain.handle('get-system-prompt', async () => buildSystemPrompt() + buildMemoryContext());

// Save active session for pipeline handoff
ipcMain.handle('save-session', async (e, messages, context) => {
  saveActiveSession(messages, context);
  return true;
});

ipcMain.handle('load-session', async () => loadActiveSession());
ipcMain.handle('clear-session', async () => { clearActiveSession(); return true; });

// End of conversation — extract and save learnings
ipcMain.handle('end-conversation', async (e, messages) => {
  try {
    const learning = await extractConversationLearnings(messages);
    if (learning) saveNewLearning(learning);
    // Check if weekly compression needed
    const lm = loadLongMemory();
    if (!lm.lastCompressed || Date.now() - lm.lastCompressed > 7 * 86400000) {
      compressMemories(); // runs in background
    }
    clearActiveSession();
    return { success: true };
  } catch(e) { return { success: false }; }
});

// Get memory context for injection
ipcMain.handle('get-memory-context', async () => buildMemoryContext());

// Claude direct query with full memory context
ipcMain.handle('claude-query', async (e, query) => {
  try {
    const result = await routeCommand(query);
    return result || 'Try again.';
  } catch(e) {
    console.error('Claude query error:', e.message);
    return 'Having a moment, try again.';
  }
});

// Market data handler
ipcMain.handle('market-data', async (e, type, coin = 'BTC') => {
  switch(type) {
    case 'price':    return await getCryptoPrice(coin) || 'Could not fetch price.';
    case 'funding':  return await getFundingRate(coin);
    case 'feargreed':return await getFearGreed();
    case 'dominance':return await getDominance();
    case 'gas':      return await getGasFees() || 'Could not fetch gas.';
    default:         return 'Unknown data type.';
  }
});

ipcMain.handle('claude-query-legacy', async (e, query) => {
  try {
    const result = await routeCommand(query);
    return result || 'Try again.';
  } catch(err) {
    console.error('Claude query error:', err.message);
    return 'Having a moment, try again.';
  }
});


ipcMain.handle('get-voice',       async (e, text)    => getVoiceAudio(text));
ipcMain.handle('get-memory',      async ()            => loadMemory());
ipcMain.handle('save-memory',     async (e, m)        => { saveMemory(m); return true; });
ipcMain.handle('get-settings',    async ()            => loadSettings());
ipcMain.on('tg-intel-notify', async (e, item) => {
  const typeEmojis = { signal:'📡', warning:'⚠️', news:'📰', whale:'🐋', scan:'📊', win:'✅', loss:'❌' };
  const emoji = typeEmojis[item.type] || '💭';
  const msg = `${emoji} ${item.type?.toUpperCase()}${item.source ? ` | ${item.source}` : ''}\n${item.body}${item.note ? '\n' + item.note : ''}${item.action ? '\n→ ' + item.action : ''}`;
  await sendTelegramNotification(msg);
});

ipcMain.on('save-weights', (e, weights) => {
  const s = loadSettings();
  s.signalWeights = weights;
  saveJSON(SETTINGS_FILE, s);
});
ipcMain.on('set-setting', (e, key, value) => {
  const s = loadSettings();
  s[key] = value;
  saveJSON(SETTINGS_FILE, s);
});
ipcMain.handle('save-settings',   async (e, s)        => { saveSettings(s); return true; });
ipcMain.handle('get-journal',     async ()            => loadJournal());
ipcMain.handle('save-journal',    async (e, j)        => { saveJournal(j); return true; });
ipcMain.handle('get-alerts',      async ()            => loadAlerts());
ipcMain.handle('save-alerts',     async (e, a)        => { saveAlerts(a); return true; });
ipcMain.handle('get-notes',       async ()            => loadNotes());
ipcMain.handle('get-checklist',   async ()            => loadChecklist());
ipcMain.handle('save-checklist',  async (e, c)        => { saveChecklist(c); return true; });
ipcMain.handle('get-voice-journal',async ()           => loadVoiceJournal());
ipcMain.handle('export-data',     async ()            => exportAllData());
ipcMain.handle('restore-backup',  async (e, data)     => restoreBackup(data));
ipcMain.handle('get-crypto-price',async (e, coin)     => getCryptoPrice(coin));
ipcMain.handle('get-fear-greed',  async ()            => getFearGreed());
ipcMain.handle('get-funding-rate',async (e, coin)     => getFundingRate(coin));
ipcMain.handle('get-dominance',   async ()            => getDominance());
ipcMain.handle('get-gas-fees',    async ()            => getGasFees());
ipcMain.handle('get-monthly-gas', async ()            => getMonthlyGasSpend());
ipcMain.handle('get-halving',     async ()            => getHalvingCountdown());
ipcMain.handle('scan-contract',   async (e, ca)       => scanContract(ca));
ipcMain.handle('get-wallet-data', async (e, addr, chain) => {
  try {
    const key = process.env.MORALIS_API_KEY;
    if (!key) return null;
    const chainMap = { eth: '0x1', bsc: '0x38', polygon: '0x89', arbitrum: '0xa4b1', base: '0x2105', sol: 'mainnet' };
    const nativeSymbols = { eth: 'ETH', bsc: 'BNB', polygon: 'MATIC', arbitrum: 'ETH', base: 'ETH', sol: 'SOL' };
    const chainId = chainMap[chain] || '0x38';
    const isSol = chain === 'sol';

    let tokens = [], txns = [], totalUsd = 0;

    if (isSol) {
      const res = await fetchT(`https://solana-gateway.moralis.io/account/mainnet/${addr}/portfolio`, {
        headers: { 'X-API-Key': key }
      }, 8000);
      const data = await res.json();
      tokens = (data?.tokens || []).map(t => ({
        symbol: t.symbol, balance: t.amount, usdValue: t.usdValue || 0
      }));
      totalUsd = data?.totalUsd || 0;
    } else {
      // Get native balance + ERC20 tokens + transactions
      const [nativeRes, tokensRes, txnsRes] = await Promise.all([
        fetchT(`https://deep-index.moralis.io/api/v2.2/${addr}/balance?chain=${chainId}`, {
          headers: { 'X-API-Key': key }
        }, 8000),
        fetchT(`https://deep-index.moralis.io/api/v2.2/${addr}/erc20?chain=${chainId}&limit=20`, {
          headers: { 'X-API-Key': key }
        }, 8000),
        fetchT(`https://deep-index.moralis.io/api/v2.2/${addr}?chain=${chainId}&limit=5`, {
          headers: { 'X-API-Key': key }
        }, 8000)
      ]);

      const nativeData = await nativeRes.json();
      const tokensData = await tokensRes.json();
      const txnsData = await txnsRes.json();

      // Native balance (BNB/ETH/MATIC)
      const nativeBal = parseFloat(nativeData?.balance || 0) / 1e18;
      const nativeSymbol = nativeSymbols[chain] || 'ETH';

      // Get native price
      let nativePrice = 0;
      try {
        const priceStr = await getCryptoPrice(nativeSymbol.toLowerCase());
        const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
        if (priceMatch) nativePrice = parseFloat(priceMatch[1].replace(',', ''));
      } catch(e) {}

      const nativeUsd = nativeBal * nativePrice;

      if (nativeBal > 0.0001) {
        tokens.push({
          symbol: nativeSymbol,
          balance: nativeBal,
          usdValue: nativeUsd
        });
        totalUsd += nativeUsd;
      }

      // ERC20 tokens
      const erc20 = (tokensData?.result || []).map(t => ({
        symbol: t.symbol,
        balance: parseFloat(t.balance) / Math.pow(10, parseInt(t.decimals) || 18),
        usdValue: parseFloat(t.usd_value || t.usdValue || 0)
      })).filter(t => t.balance > 0);

      tokens = tokens.concat(erc20);
      totalUsd += erc20.reduce((s, t) => s + t.usdValue, 0);

      // Transactions — deduplicate by hash
      const seenHashes = new Set();
      txns = (txnsData?.result || []).filter(t => {
        if (seenHashes.has(t.hash)) return false;
        seenHashes.add(t.hash);
        return true;
      }).map(t => ({
        type: t.from_address?.toLowerCase() === addr.toLowerCase() ? 'send' : 'receive',
        amount: parseFloat(t.value) / 1e18,
        symbol: nativeSymbol,
        date: new Date(t.block_timestamp).toLocaleDateString(),
        hash: t.hash
      }));
    }

    return { tokens, txns, totalUsd };
  } catch(e) {
    console.error('Wallet data error:', e.message);
    return null;
  }
});

ipcMain.handle('add-voice-journal', async (e, text, coin) => {
  const summary = await getAIReply(`Summarize this trading journal entry in 1 sentence: "${text}"`);
  addVoiceJournalEntry(text, summary, coin);
  return summary;
});

ipcMain.handle('look-at-screen', async (e, msg) => {
  const reply = await takeScreenshot(msg);
  const audio = await getVoiceAudio(reply);
  return { success: true, reply, base64Audio: audio };
});

ipcMain.handle('look-at-image', async (e, b64, mimeType, prompt) => {
  try {
    const isPDF = mimeType === 'application/pdf';
    const content = isPDF
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: prompt || 'Analyze this. Check for red flags. Give verdict in 3 sentences.' }]
      : [{ type: 'image', source: { type: 'base64', media_type: mimeType || 'image/png', data: b64 } }, { type: 'text', text: prompt || 'Identify exactly what this is. Be precise. 1-2 sentences.' }];
    const res   = await anthropic.messages.create({ model: CLAUDE_MODEL, max_tokens: 200, system: buildSystemPrompt(), messages: [{ role: 'user', content }] });
    const reply = res.content[0].text;
    const audio = await getVoiceAudio(reply);
    return { success: true, reply, base64Audio: audio };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('analyze-webcam-frame', async (e, b64) => {
  try {
    const res   = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 100, system: buildSystemPrompt(),
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: 'What is the person doing? What objects, devices, brands do you see? One short casual sentence.' }
      ]}],
    });
    const reply = res.content[0].text;
    const audio = await getVoiceAudio(reply);
    return { success: true, reply, base64Audio: audio };
  } catch(e) { return { success: false, error: e.message }; }
});

ipcMain.handle('confirm-morning-briefing', async () => {
  const btc  = await getCryptoPrice('btc');
  const eth  = await getCryptoPrice('eth');
  const fg   = await getFearGreed();
  const sess = getMarketSession();
  const reply= `${btc || ''}. ${eth || ''}. ${fg || ''}. ${sess}.`;
  return { reply, base64Audio: await getVoiceAudio(reply) };
});

ipcMain.handle('confirm-news-briefing', async () => {
  let headlines = await getCryptoNews();
  let reply;
  if (headlines) {
    reply = await getAIReply(`Summarize these crypto news in 2-3 punchy sentences: ${headlines}`);
  } else {
    reply = await getAIReply('Give me the top 3-4 most important crypto news from the last 24 hours. Be specific.');
  }
  return { reply, base64Audio: await getVoiceAudio(reply) };
});

ipcMain.handle('process-voice-input-text', async (e, text, cameraFrame) => {
  try {
    console.log('💬 Text:', text);
    
    // If camera frame provided and text is about seeing/looking
    const lower = text.toLowerCase();
    const isVisionQuery = lower.includes('see me') || lower.includes('look at me') || 
                          lower.includes('what do i look') || lower.includes('can you see') ||
                          lower.includes('see my') || lower.includes('look at my') ||
                          lower.includes('what am i') || lower.includes('describe me');
    
    let reply;
    if (cameraFrame && isVisionQuery) {
      console.log('📷 Using camera frame for vision query');
      const visionRes = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: cameraFrame } },
            { type: 'text', text: `You are Asuka, a sweet AI companion. The user asked: "${text}". Describe what you see in 1-2 sentences, warmly and naturally as their companion.` }
          ]
        }]
      });
      reply = visionRes.content[0].text;
    } else if (cameraFrame) {
      // Inject camera context into normal query
      reply = await routeCommand(text + (webcamActive ? ' [Camera is on, I can see you]' : ''));
    } else {
      reply = await routeCommand(text);
    }
    
    console.log('🤖 Reply:', reply?.slice(0, 80));
    const audio = await getVoiceAudio(reply);
    console.log('🔊 Audio:', audio ? 'generated' : 'FAILED');
    return { success: true, reply, base64Audio: audio };
  } catch(e) { 
    console.error('❌ Text handler error:', e.message);
    return { success: false, error: e.message }; 
  }
});

// ─── DEEPGRAM STREAMING STT ───────────────────────────────────────────────
const https = require('https');

// Stream audio to Deepgram and get transcript
async function transcribeWithDeepgram(audioBuffer) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return resolve(null);

    const req = https.request({
      hostname: 'api.deepgram.com',
      path: '/v1/listen?model=nova-2&language=en&smart_format=true&punctuate=true',
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'audio/webm',
        'Content-Length': audioBuffer.length,
      },
      timeout: 8000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
          resolve(transcript || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(audioBuffer);
    req.end();
  });
}

// ElevenLabs streaming TTS — returns audio faster
async function getVoiceAudioStreaming(text) {
  if (!text) return null;
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.VOICE_ID;
  if (!apiKey || !voiceId) return getVoiceAudio(text);

  return new Promise((resolve) => {
    const body = JSON.stringify({
      text,
      model_id: 'eleven_flash_v2_5',
      output_format: 'mp3_22050_32',
      voice_settings: { stability: 0.4, similarity_boost: 0.8 }
    });

    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(Buffer.concat(chunks).toString('base64'));
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Fast voice pipeline — Deepgram STT + Claude + ElevenLabs streaming
ipcMain.handle('process-voice-input', async (e, audioInput) => {
  try {
    const buf = Buffer.from(audioInput, 'base64');
    if (buf.length < 2000) return { success: false, error: 'Too short' };

    // Try Deepgram first (faster), fall back to OpenAI Whisper
    let userText = await transcribeWithDeepgram(buf);

    if (!userText && process.env.OPENAI_API_KEY) {
      // Fallback to OpenAI Whisper only if key exists
      const tempPath = path.join(app.getPath('temp'), `input_${Date.now()}.webm`);
      fs.writeFileSync(tempPath, buf);
      try {
        const t = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: 'whisper-1',
          language: 'en',
          response_format: 'text',
        });
        userText = typeof t === 'string' ? t.trim() : t?.text?.trim();
      } finally {
        try { fs.unlinkSync(tempPath); } catch(e) {}
      }
    }

    if (!userText) return { success: false, error: 'No speech detected' };

    console.log('🎤 Heard:', userText);
    const reply = await routeCommand(userText);
    if (!reply) return { success: false, error: 'No reply' };
    console.log('🤖 Reply:', reply.slice(0, 80));

    const audio = await getVoiceAudio(reply);
    console.log('🔊 Audio:', audio ? 'generated' : 'FAILED');
    return { success: true, transcript: userText, reply, base64Audio: audio };
  } catch(e) {
    console.error('Voice error:', e.message);
    return { success: false, error: e.message };
  }
});

// Send Telegram message to self
async function sendTelegramNotification(message) {
  const settings = loadSettings();
  
  // If bot is authenticated — send there instead of saved messages
  if (settings.telegramBotChatId && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      await fetchT(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.telegramBotChatId, text: message })
      }, 8000);
      console.log('📱 Bot notification sent:', message.slice(0, 50));
      return;
    } catch(e) { console.error('Bot notify error:', e.message); }
  }
  
  // Fallback to saved messages via MTProto
  if (!tgClient) return;
  try {
    const contact = settings.tgNotifyContact || 'me';
    await tgClient.sendMessage(contact, { message });
    console.log('📱 TG notification sent:', message.slice(0, 50));
  } catch(e) { console.error('TG notify error:', e.message); }
}

// ─── SMART TRADE CALCULATOR ───────────────────────────────────────────────
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

  return { sizeMultiplier, tpPct, slPct, target, stopLoss, mode, partialTp, trailingLevels };
}

// Apply trailing stops in checkPaperTrades
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

// ─── INDEPENDENT MARKET SCANNER ───────────────────────────────────────────
async function runIndependentScan() {
  const settings = loadSettings();
  if (!settings.independentScanner) return;
  if (!settings.autoPaperTrade) return;

  console.log('🔍 Running independent market scan...');

  try {
    // Scan selected coins (default BTC, ETH, SOL, BNB)
    const settings = loadSettings();
    const coinsToScan = settings.tradingCoins || ['BTC', 'ETH', 'SOL', 'BNB'];
    
    for (const scanCoin of coinsToScan) {
      await scanCoinForTrade(scanCoin);
    }
  } catch(e) {
    console.error('Independent scan error:', e.message);
  }
}

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
const [coinPrice, funding, fearGreed, dominance, news, openInterest, lsRatio, liquidations, volume, technicalAnalysis, orderBook, correlation, timeSignal] = await Promise.all([
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
      Promise.resolve(getTimeSignal())
    ]);

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
      const settings2 = loadSettings();
      let threshold = settings2.paperTradeThreshold || 20;
      if (settings2.autoThreshold) {
        threshold = 50;
      }

      // ── MiroFish Group Chat 2-Round Debate (Groq + Cerebras) ────────────
      const TOTAL_AGENTS = 20;
      const NUM_GROUPS = 2;  // 2 groups of 10 agents — within rate limit
      const AGENTS_PER_GROUP = 10;
      const marketSummary = `${scanCoin} at ${coinPrice}, Funding: ${funding}, FG: ${fearGreed}. Claude suggests: ${analysis.direction?.toUpperCase()} with ${analysis.confidence}% confidence. Reason: ${analysis.reason}`;

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
          const result = await callMiroAgent(role,
            `You are a crypto ${role}. Market: ${marketSummary}. Should we ${analysis.direction?.toUpperCase()} ${scanCoin} right now? JSON: {"agree":true/false,"confidence":0-100,"argument":"specific reason in 10 words"}`
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
          pct: Math.round(groupAgree / groupRoles.length * 100)
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
        groups.map(g => runGroupDebate(g.id, g.roles))
      );

      // Compile group results
      const totalAgree = groupResults.reduce((s, g) => s + g.agree, 0);
      const totalChanged = groupResults.reduce((s, g) => s + g.changed, 0);
      const swarmAgreePct = Math.round(totalAgree / TOTAL_AGENTS * 100);
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
      console.log(`🐟 Group breakdown: ${groupResults.map(g => `G${g.groupId}:${g.pct}%`).join(' ')}`);

      sendIntelEvent({
        type: 'scan',
        source: 'MiroFish Group Chat (8 groups × 10 agents)',
        body: `${analysis.direction?.toUpperCase()} ${scanCoin} — ${agreeCount}/${TOTAL_AGENTS} agree (${swarmAgreePct}%)`,
        note: `${totalChanged} agents changed mind | Best bull: "${bestBullArg}" | Best bear: "${bestBearArg}"`,
        notify: false
      });

      // Skip if swarm disagrees
      if (swarmAgreePct < 50) {
        console.log(`❌ MiroFish disagrees (${swarmAgreePct}%) — skipping ${analysis.direction} ${scanCoin}`);
        return;
      }

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
        return;
      }

      if (finalDecision.confidence < threshold) {
        console.log(`⏭️ Final confidence ${finalDecision.confidence}% below threshold ${threshold}% — skipping`);
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
        partialTp: smartParams.partialTp
      };

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

// Start independent scanner
let independentScanInterval = null;
function startIndependentScanner() {
  if (independentScanInterval) clearInterval(independentScanInterval);
  const settings = loadSettings();
  const intervalMinutes = settings.scanIntervalMinutes || 30;
  independentScanInterval = setInterval(runIndependentScan, intervalMinutes * 60 * 1000);
  console.log(`🔍 Independent market scanner started (every ${intervalMinutes} min)`);
  if (settings.independentScanner) {
    setTimeout(runIndependentScan, 5000);
  }
}

// ─── TRADING LEARNING ENGINE ───────────────────────────────────────────────
const TRADING_LESSONS_FILE = path.join(DATA_DIR, 'trading-lessons.json');

function loadTradingLessons() {
  return loadJSON(TRADING_LESSONS_FILE, { lessons: [], patterns: [], lastUpdated: null });
}
function saveTradingLessons(d) { saveJSON(TRADING_LESSONS_FILE, d); }

// ── Learning Queue — prevents concurrent Sonnet rate limits ───────────────
const learningQueue = [];
let learningRunning = false;

async function processLearningQueue() {
  if (learningRunning) return;
  learningRunning = true;
  while (learningQueue.length > 0) {
    const fn = learningQueue.shift();
    try { await fn(); } catch(e) { console.error('Learning error:', e.message?.slice(0,60)); }
    await new Promise(r => setTimeout(r, 4000)); // 4s between lessons
  }
  learningRunning = false;
}

function queueLearnFromTrade(trade, pnl, reason) {
  learningQueue.push(() => learnFromTrade(trade, pnl, reason));
  processLearningQueue();
}

async function learnFromTrade(trade, pnl, reason) {
  try {
    console.log(`🧠 Learning from ${pnl >= 0 ? 'winning' : 'losing'} trade...`);

    // Get market conditions at time of trade
    const [currentPrice, funding, fearGreed, dominance] = await Promise.all([
      getCryptoPrice(trade.coin.toLowerCase()).catch(() => null),
      getFundingRate(trade.coin).catch(() => null),
      getFearGreed().catch(() => null),
      getDominance().catch(() => null)
    ]);

    const pd = loadPaperTrades();
    const totalTrades = pd.trades.filter(t => t.status !== 'open').length;
    const winRate = pd.stats.wins + pd.stats.losses > 0
      ? Math.round(pd.stats.wins / (pd.stats.wins + pd.stats.losses) * 100)
      : 0;

    const lessons = loadTradingLessons();
    const recentLessons = lessons.lessons.slice(-10);

    const prompt = `You are analyzing a paper trade to extract lessons for future trading.

TRADE DETAILS:
- Coin: ${trade.coin}
- Direction: ${trade.direction?.toUpperCase()}
- Entry: $${trade.entry}
- Exit: $${trade.closePrice}
- P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
- Leverage: ${trade.leverage}x
- Result: ${pnl >= 0 ? 'WIN' : 'LOSS'}
- Close reason: ${reason}
- Confidence at entry: ${trade.confidence}%
- Source: ${trade.caller}

MARKET CONDITIONS NOW (approx at close):
- ${trade.coin} price: ${currentPrice}
- Funding rate: ${funding}
- Fear & Greed: ${fearGreed}
- BTC Dominance: ${dominance}

OVERALL PERFORMANCE:
- Win rate: ${winRate}% from ${totalTrades} trades
- Total P&L: $${pd.stats.totalPnl.toFixed(2)}

RECENT LESSONS LEARNED:
${recentLessons.map(l => `- ${l.lesson}`).join('\n') || 'None yet'}

Based on this trade, extract:
1. What went right or wrong
2. What market conditions to look for (or avoid) in future
3. A specific rule to apply next time

Respond with JSON only:
{
  "lesson": "one clear sentence about what was learned",
  "rule": "specific actionable rule for future trades e.g. avoid longing BTC when funding > 0.05%",
  "pattern": "market pattern identified e.g. extreme fear + low funding = good long entry",
  "sentiment": "positive|negative|neutral",
  "confidence_adjustment": -10 to +10 (how to adjust confidence threshold based on this)
}`;

    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = res.content[0].text.trim().replace(/```json|```/g, '').trim();
    const learning = JSON.parse(text);

    // Save lesson
    lessons.lessons.push({
      ...learning,
      tradeId: trade.id,
      coin: trade.coin,
      direction: trade.direction,
      won: pnl >= 0,
      pnl: pnl.toFixed(2),
      timestamp: Date.now()
    });

    // Update patterns
    if (learning.pattern) {
      const existingPattern = lessons.patterns.find(p => p.pattern === learning.pattern);
      if (existingPattern) {
        existingPattern.count++;
        existingPattern.wins += pnl >= 0 ? 1 : 0;
      } else {
        lessons.patterns.push({
          pattern: learning.pattern,
          count: 1,
          wins: pnl >= 0 ? 1 : 0
        });
      }
    }

    // Keep last 100 lessons
    if (lessons.lessons.length > 100) lessons.lessons = lessons.lessons.slice(-100);
    lessons.lastUpdated = Date.now();
    saveTradingLessons(lessons);

    console.log(`🧠 Lesson learned: ${learning.lesson}`);
    console.log(`📋 Rule: ${learning.rule}`);

    // Send to intel feed
    sendIntelEvent({
      type: 'note',
      source: '🧠 Learning Engine',
      body: learning.lesson,
      note: `Rule: ${learning.rule}`,
      notify: false
    });

  } catch(e) {
    console.error('Learning engine error:', e.message);
  }
}

// Build lessons context for scanner — inject what she learned into every scan
function buildLessonsContext() {
  const lessons = loadTradingLessons();
  if (!lessons.lessons.length) return '';

  const recentLessons = lessons.lessons.slice(-15);
  const winningPatterns = lessons.patterns
    .filter(p => p.count >= 2 && p.wins / p.count >= 0.6)
    .map(p => `✅ ${p.pattern} (${Math.round(p.wins/p.count*100)}% win rate)`)
    .slice(0, 5);
  const losingPatterns = lessons.patterns
    .filter(p => p.count >= 2 && p.wins / p.count < 0.4)
    .map(p => `❌ ${p.pattern} (${Math.round(p.wins/p.count*100)}% win rate)`)
    .slice(0, 5);

  return `
LESSONS FROM PAST TRADES (use these to make better decisions):
${recentLessons.map(l => `- [${l.won ? 'WIN' : 'LOSS'}] ${l.lesson}`).join('\n')}

WINNING PATTERNS (look for these):
${winningPatterns.join('\n') || 'Still learning...'}

LOSING PATTERNS (avoid these):
${losingPatterns.join('\n') || 'Still learning...'}

RULES TO FOLLOW:
${recentLessons.filter(l => l.rule).slice(-5).map(l => `- ${l.rule}`).join('\n') || 'None yet'}
`;
}

// IPC handler to get lessons
ipcMain.handle('get-lessons', async () => {
  const data = loadTradingLessons();
  return data?.lessons || [];
});

ipcMain.handle('get-trading-lessons', async () => {
  return loadTradingLessons();
});

// ─── BINANCE TESTNET INTEGRATION ──────────────────────────────────────────
const crypto = require('crypto');

function binanceSign(params, secret) {
  const query = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${sig}`;
}

async function binanceTestnetRequest(method, path, params = {}) {
  const apiKey = process.env.BINANCE_TESTNET_API_KEY;
  const secret = process.env.BINANCE_TESTNET_SECRET;
  if (!apiKey || !secret) return null;

  params.timestamp = Date.now();
  params.recvWindow = 5000;
  const query = binanceSign(params, secret);
  const url = `https://testnet.binancefuture.com${path}?${query}`;

  try {
    // Strict 5 second timeout to prevent hanging
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': apiKey },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return await res.json();
  } catch(e) {
    if (e.name === 'AbortError') console.log('Binance testnet timeout — using local data');
    else console.error('Binance testnet error:', e.message);
    return null;
  }
}

// Set leverage on Binance testnet and return actual leverage set
async function setBinanceLeverage(symbol, leverage) {
  const res = await binanceTestnetRequest('POST', '/fapi/v1/leverage', { symbol, leverage });
  if (res?.leverage) {
    const actualLeverage = parseInt(res.leverage);
    if (actualLeverage !== leverage) {
      console.log(`⚠️ Binance capped leverage: requested ${leverage}x → actual ${actualLeverage}x for ${symbol}`);
    }
    return actualLeverage;
  }
  return leverage; // fallback to requested
}

// Open position on Binance testnet
async function openBinancePosition(signal) {
  const settings = loadSettings();
  const leverage = settings.paperLeverage || 1;
  const symbol = `${signal.coin}USDT`;
  const side = signal.direction === 'long' ? 'BUY' : 'SELL';

  // Set leverage first — get ACTUAL leverage Binance accepts
  const actualLeverage = await setBinanceLeverage(symbol, leverage);
  
  // Use actual leverage for quantity calculation
  const priceStr = await getCryptoPrice(signal.coin.toLowerCase());
  const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
  const currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : signal.entry;
  const pd = loadPaperTrades();
  const size = settings.paperTradeSize || (pd.balance * 0.05);
  const quantity = parseFloat((size / currentPrice).toFixed(3));

  const order = await binanceTestnetRequest('POST', '/fapi/v1/order', {
    symbol,
    side,
    type: 'MARKET',
    quantity
  });

  if (!order?.orderId) {
    console.error('Binance order failed:', JSON.stringify(order));
    return null;
  }

  console.log(`✅ Binance testnet order: ${side} ${symbol} qty=${quantity} leverage=${actualLeverage}x orderId=${order.orderId}`);

  // Place real SL and TP orders on Binance
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  
  // Stop Loss order
  if (signal.stopLoss) {
    try {
      const slOrder = await binanceTestnetRequest('POST', '/fapi/v1/order', {
        symbol,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: signal.stopLoss.toFixed(2),
        closePosition: true,
        quantity
      });
      if (slOrder?.orderId) {
        console.log(`🛑 Binance SL set: $${signal.stopLoss} orderId=${slOrder.orderId}`);
      }
    } catch(e) { console.log(`⚠️ SL order failed: ${e.message?.slice(0,60)}`); }
  }

  // Take Profit order  
  if (signal.target) {
    try {
      const tpOrder = await binanceTestnetRequest('POST', '/fapi/v1/order', {
        symbol,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: signal.target.toFixed(2),
        closePosition: true,
        quantity
      });
      if (tpOrder?.orderId) {
        console.log(`🎯 Binance TP set: $${signal.target} orderId=${tpOrder.orderId}`);
      }
    } catch(e) { console.log(`⚠️ TP order failed: ${e.message?.slice(0,60)}`); }
  }

  return { ...order, symbol, side, quantity, leverage: actualLeverage };
}

// Close position on Binance testnet
async function closeBinancePosition(symbol, side, quantity) {
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  const order = await binanceTestnetRequest('POST', '/fapi/v1/order', {
    symbol,
    side: closeSide,
    type: 'MARKET',
    quantity,
    reduceOnly: true
  });
  if (order?.orderId) {
    console.log(`✅ Binance testnet position closed: ${symbol}`);
  }
  return order;
}

// Get all open positions from Binance testnet
async function getBinancePositions() {
  const positions = await binanceTestnetRequest('GET', '/fapi/v2/positionRisk', {});
  if (!positions) return [];
  return positions.filter(p => parseFloat(p.positionAmt) !== 0);
}

// Get Binance testnet account balance
async function getBinanceBalance() {
  const account = await binanceTestnetRequest('GET', '/fapi/v2/account', {});
  if (!account) return null;
  const usdt = account.assets?.find(a => a.asset === 'USDT');
  return usdt ? parseFloat(usdt.availableBalance) : null;
}

// Check if Binance testnet is configured
function isBinanceTestnet() {
  return !!(process.env.BINANCE_TESTNET_API_KEY && process.env.BINANCE_TESTNET_SECRET);
}

// Coins supported on Binance testnet futures
const BINANCE_TESTNET_COINS = ['BTC', 'ETH', 'BNB', 'LTC', 'TRX', 'XRP', 'ADA', 'DOT', 'LINK', 'SOL'];

function isSupportedOnTestnet(coin) {
  return BINANCE_TESTNET_COINS.includes(coin?.toUpperCase());
}

// ─── INDEPENDENT SCALP SCANNER ────────────────────────────────────────────
async function runIndependentScalpScan() {
  const settings = loadSettings();
  if (!settings.scalpTrading) return;
  if (!settings.autoPaperTrade) return;

  const pd = loadPaperTrades();
  const coins = settings.tradingCoins || ['BTC', 'ETH', 'SOL'];
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
        scalpPivot ? `Pivots: PP=$${scalpPivot.PP} | ${scalpPivot.abovePivot ? 'Above PP bullish' : 'Below PP bearish'}` : null
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

      console.log(`⚡ Agents: ${agreeCount}/5 agree on ${scoutResult.direction?.toUpperCase()} ${coin}`);

      if (agreeCount < 2) {
        console.log(`⚡ Agents rejected: only ${agreeCount}/5 agree — skipping ${coin}`);
        continue;
      }
      // Need at least 2/5 agents to agree

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


// ─── SCALP TRADING SYSTEM ─────────────────────────────────────────────────
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

// Check scalp trades — smart exit + time expiry
async function checkScalpExpiry() {
  const pd = loadPaperTrades();
  const openScalps = pd.trades.filter(t => t.status === 'open' && t.isScalp);

  for (const trade of openScalps) {
    try {
      const priceStr = await getCryptoPrice(trade.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (!priceMatch) continue;
      const currentPrice = parseFloat(priceMatch[1].replace(',', ''));

      // Sanity check
      const priceDiffPct = Math.abs(currentPrice - trade.entry) / trade.entry * 100;
      if (priceDiffPct > 50) continue;

      const leverage = trade.leverage || 1;
      const priceDiff = trade.direction === 'long'
        ? currentPrice - trade.entry
        : trade.entry - currentPrice;
      const pnlPct = (priceDiff / trade.entry) * leverage * 100;

      // 1. Time limit expired
      if (trade.scalpExpiry && Date.now() > trade.scalpExpiry) {
        await closePaperTrade(trade.id, currentPrice, 'scalp time limit reached');
        console.log(`⚡ Scalp auto-closed (time): ${trade.direction} ${trade.coin} P&L: ${pnlPct.toFixed(1)}%`);
        continue;
      }

      // 2. Smart exit — conditions turned against scalp
      const timeSinceOpen = (Date.now() - trade.openTime) / 1000 / 60; // minutes
      
      // If losing more than 3% leveraged AND been open 5+ min → close early
      if (pnlPct < -3 && timeSinceOpen > 5) {
        await closePaperTrade(trade.id, currentPrice, 'scalp smart exit — conditions changed');
        console.log(`⚡ Scalp smart exit (losing): ${trade.direction} ${trade.coin} ${pnlPct.toFixed(1)}%`);
        sendTelegramNotification(`⚡ Scalp Smart Exit\n${trade.direction?.toUpperCase()} ${trade.coin}\nConditions changed — cutting loss early\nP&L: ${pnlPct.toFixed(1)}%`);
        continue;
      }

      // 3. Profit target hit (scalp TP)
      const hitTarget = trade.direction === 'long'
        ? currentPrice >= trade.target
        : currentPrice <= trade.target;
      if (hitTarget) {
        await closePaperTrade(trade.id, currentPrice, 'scalp target hit');
        console.log(`⚡ Scalp TP hit: ${trade.direction} ${trade.coin} +${pnlPct.toFixed(1)}%`);
        continue;
      }

      // 4. Half time passed + already profitable → close to lock profit
      const halfTime = trade.scalpExpiry 
        ? Date.now() > (trade.openTime + (trade.scalpExpiry - trade.openTime) / 2)
        : false;
      if (halfTime && pnlPct > 1.5) {
        await closePaperTrade(trade.id, currentPrice, 'scalp locking profit at half time');
        console.log(`⚡ Scalp profit lock at half time: ${trade.coin} +${pnlPct.toFixed(1)}%`);
        continue;
      }

    } catch(e) {}
  }
}


// ─── BINANCE SPOT TRADING ─────────────────────────────────────────────────

// Binance spot testnet: https://testnet.binance.vision
async function binanceSpotRequest(method, path, params = {}) {
  const apiKey = process.env.BINANCE_TESTNET_API_KEY;
  const secret = process.env.BINANCE_TESTNET_SECRET;
  if (!apiKey || !secret) return null;

  params.timestamp = Date.now();
  params.recvWindow = 5000;
  const query = binanceSign(params, secret);
  
  const isGet = method === 'GET';
  const url = isGet 
    ? `https://testnet.binance.vision${path}?${query}`
    : `https://testnet.binance.vision${path}`;
    
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, {
      method,
      headers: { 
        'X-MBX-APIKEY': apiKey,
        ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' })
      },
      body: isGet ? undefined : query,
      signal: controller.signal
    });
    clearTimeout(timeout);
    return await res.json();
  } catch(e) {
    if (e.name === 'AbortError') console.log('Binance spot timeout');
    else console.error('Binance spot error:', e.message?.slice(0,60));
    return null;
  }
}

// Get spot balances
async function getSpotBalances() {
  const res = await binanceSpotRequest('GET', '/api/v3/account', {});
  if (!res?.balances) return [];
  return res.balances
    .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
    .map(b => ({
      coin: b.asset,
      free: parseFloat(b.free),
      locked: parseFloat(b.locked),
      total: parseFloat(b.free) + parseFloat(b.locked)
    }));
}

// Get spot ticker price
async function getSpotPrice(symbol) {
  const res = await binanceSpotRequest('GET', `/api/v3/ticker/price`, { symbol });
  return res?.price ? parseFloat(res.price) : null;
}

// Place spot market buy order
async function spotBuy(coin, usdtAmount) {
  const symbol = `${coin}USDT`;
  
  // Get current price
  const price = await getSpotPrice(symbol);
  if (!price) return null;
  
  // Precision map for spot
  const precisionMap = { 
    BTC: 5, ETH: 4, BNB: 3, SOL: 2, 
    XRP: 1, DOGE: 0, AVAX: 2, LINK: 2 
  };
  const precision = precisionMap[coin] ?? 2;
  const quantity = parseFloat((usdtAmount / price).toFixed(precision));
  
  const order = await binanceSpotRequest('POST', '/api/v3/order', {
    symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity
  });
  
  if (order?.orderId) {
    console.log(`✅ Spot BUY: ${quantity} ${coin} at ~$${price} (order ${order.orderId})`);
    return { ...order, coin, quantity, price, usdtAmount };
  }
  console.error('Spot buy failed:', JSON.stringify(order)?.slice(0,100));
  return null;
}

// Place spot market sell order
async function spotSell(coin, quantity, percent = 100) {
  const symbol = `${coin}USDT`;
  
  // Get balance if selling by percent
  if (percent < 100) {
    const balances = await getSpotBalances();
    const bal = balances.find(b => b.coin === coin);
    if (!bal) return null;
    const precisionMap = { BTC: 5, ETH: 4, BNB: 3, SOL: 2, XRP: 1, DOGE: 0, AVAX: 2 };
    const precision = precisionMap[coin] ?? 2;
    quantity = parseFloat((bal.free * percent / 100).toFixed(precision));
  }
  
  if (!quantity || quantity <= 0) return null;
  
  const price = await getSpotPrice(symbol);
  
  const order = await binanceSpotRequest('POST', '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity
  });
  
  if (order?.orderId) {
    console.log(`✅ Spot SELL: ${quantity} ${coin} at ~$${price} (order ${order.orderId})`);
    return { ...order, coin, quantity, price };
  }
  console.error('Spot sell failed:', JSON.stringify(order)?.slice(0,100));
  return null;
}

// Place spot limit buy order
async function spotLimitBuy(coin, usdtAmount, limitPrice) {
  const symbol = `${coin}USDT`;
  const precisionMap = { BTC: 5, ETH: 4, BNB: 3, SOL: 2, XRP: 1, DOGE: 0 };
  const precision = precisionMap[coin] ?? 2;
  const quantity = parseFloat((usdtAmount / limitPrice).toFixed(precision));
  
  const order = await binanceSpotRequest('POST', '/api/v3/order', {
    symbol,
    side: 'BUY',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity,
    price: limitPrice.toFixed(2)
  });
  
  if (order?.orderId) {
    console.log(`✅ Spot LIMIT BUY: ${quantity} ${coin} at $${limitPrice} (order ${order.orderId})`);
    return { ...order, coin, quantity, limitPrice };
  }
  return null;
}

// Place spot limit sell order  
async function spotLimitSell(coin, quantity, limitPrice) {
  const symbol = `${coin}USDT`;
  
  const order = await binanceSpotRequest('POST', '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'LIMIT',
    timeInForce: 'GTC',
    quantity,
    price: limitPrice.toFixed(2)
  });
  
  if (order?.orderId) {
    console.log(`✅ Spot LIMIT SELL: ${quantity} ${coin} at $${limitPrice} (order ${order.orderId})`);
    return { ...order, coin, quantity, limitPrice };
  }
  return null;
}

// Cancel spot order
async function cancelSpotOrder(symbol, orderId) {
  const res = await binanceSpotRequest('DELETE', '/api/v3/order', { symbol, orderId });
  return res?.status === 'CANCELED';
}

// Get open spot orders
async function getOpenSpotOrders(symbol = null) {
  const params = symbol ? { symbol } : {};
  const res = await binanceSpotRequest('GET', '/api/v3/openOrders', params);
  return Array.isArray(res) ? res : [];
}

// Save spot trade to local history
const SPOT_TRADES_FILE = path.join(DATA_DIR, 'spot-trades.json');
function loadSpotTrades() {
  return loadJSON(SPOT_TRADES_FILE, { trades: [], totalPnl: 0 });
}
function saveSpotTrade(trade) {
  const data = loadSpotTrades();
  data.trades.push({ ...trade, timestamp: Date.now() });
  saveJSON(SPOT_TRADES_FILE, data);
}

// IPC handlers for spot trading
ipcMain.handle('spot-buy', async (e, { coin, amount }) => {
  try {
    const order = await spotBuy(coin, amount);
    if (order) {
      saveSpotTrade({ type: 'buy', coin, amount, price: order.price, qty: order.quantity });
      sendTelegramNotification(`🟢 Spot Buy\n${order.quantity} ${coin}\nAmount: $${amount}\nPrice: ~$${order.price?.toLocaleString()}`);
    }
    return order;
  } catch(e) { return null; }
});

ipcMain.handle('spot-sell', async (e, { coin, quantity, percent }) => {
  try {
    const order = await spotSell(coin, quantity, percent);
    if (order) {
      sendTelegramNotification(`🔴 Spot Sell\n${order.quantity} ${coin}\nPrice: ~$${order.price?.toLocaleString()}`);
    }
    return order;
  } catch(e) { return null; }
});

ipcMain.handle('spot-limit-buy', async (e, { coin, amount, price }) => {
  return await spotLimitBuy(coin, amount, price);
});

ipcMain.handle('spot-limit-sell', async (e, { coin, quantity, price }) => {
  return await spotLimitSell(coin, quantity, price);
});

ipcMain.handle('get-spot-balances', async () => {
  return await getSpotBalances();
});

ipcMain.handle('get-open-spot-orders', async () => {
  return await getOpenSpotOrders();
});

ipcMain.handle('cancel-spot-order', async (e, { symbol, orderId }) => {
  return await cancelSpotOrder(symbol, orderId);
});

ipcMain.handle('get-spot-trades', () => loadSpotTrades());

// Voice commands for spot trading in routeCommand

// ─── RAGE TRADE LOCK ──────────────────────────────────────────────────────
let rageLockActive = false;
let rageLockTimer = null;
let consecutiveLosses = 0;

function checkRageLock() {
  const settings = loadSettings();
  if (!settings.rageLockEnabled) return false;
  if (rageLockActive) return true;
  return false;
}

function activateRageLock(reason = 'consecutive losses') {
  const settings = loadSettings();
  const lockMinutes = settings.rageLockMinutes || 30;
  rageLockActive = true;
  consecutiveLosses = 0;

  console.log(`🔒 Rage lock activated for ${lockMinutes} min — ${reason}`);

  const msg = `🔒 Trading Locked — Cool Down Time\n\nReason: ${reason}\nDuration: ${lockMinutes} minutes\n\nStep away, drink water, breathe.\nI'll unlock trading when you're ready 💙`;
  sendTelegramNotification(msg);

  if (mainWindow) {
    mainWindow.webContents.send('rage-lock-activated', { 
      reason, 
      minutes: lockMinutes,
      unlockAt: Date.now() + (lockMinutes * 60 * 1000)
    });
  }

  if (rageLockTimer) clearTimeout(rageLockTimer);
  rageLockTimer = setTimeout(() => {
    rageLockActive = false;
    console.log('🔓 Rage lock deactivated — trading resumed');
    sendTelegramNotification('🔓 Trading Unlocked\nCool down complete. Trade wisely 💙');
    if (mainWindow) mainWindow.webContents.send('rage-lock-deactivated');
  }, lockMinutes * 60 * 1000);
}

// Track consecutive losses
function trackTradeLoss(trade) {
  const settings = loadSettings();
  if (!settings.rageLockEnabled) return;
  
  consecutiveLosses++;
  const threshold = settings.rageLockThreshold || 3;
  
  console.log(`📉 Consecutive losses: ${consecutiveLosses}/${threshold}`);
  
  if (consecutiveLosses >= threshold) {
    activateRageLock(`${consecutiveLosses} consecutive losses`);
  }
}

function trackTradeWin() {
  consecutiveLosses = 0; // Reset on win
}

// IPC handlers for rage lock
ipcMain.handle('get-rage-lock-status', () => ({
  active: rageLockActive,
  consecutiveLosses
}));

ipcMain.on('manual-rage-lock', (e, minutes) => {
  const lockMin = minutes || 30;
  activateRageLock('Manual lock activated');
});

ipcMain.on('unlock-rage-lock', () => {
  rageLockActive = false;
  consecutiveLosses = 0;
  if (rageLockTimer) clearTimeout(rageLockTimer);
  console.log('🔓 Rage lock manually deactivated');
  if (mainWindow) mainWindow.webContents.send('rage-lock-deactivated');
});

// ─── SECOND BRAIN ─────────────────────────────────────────────────────────
const BRAIN_FILE = path.join(DATA_DIR, 'second-brain.json');

function loadBrain() {
  try {
    if (fs.existsSync(BRAIN_FILE)) return JSON.parse(fs.readFileSync(BRAIN_FILE));
  } catch(e) {}
  return { memories: [] };
}

function saveBrain(brain) {
  fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
}

function addMemory(text, category = 'general') {
  const brain = loadBrain();
  const memory = {
    id: Date.now(),
    text,
    category,
    date: new Date().toISOString().split('T')[0],
    timestamp: Date.now()
  };
  brain.memories.push(memory);
  saveBrain(brain);
  console.log(`🧠 Memory saved: ${text.slice(0, 50)}`);
  return memory;
}

function searchMemories(query) {
  const brain = loadBrain();
  const lower = query.toLowerCase();
  return brain.memories.filter(m => 
    m.text.toLowerCase().includes(lower) ||
    m.category.toLowerCase().includes(lower)
  ).slice(-10);
}

function buildBrainContext() {
  const brain = loadBrain();
  if (!brain.memories.length) return '';
  const recent = brain.memories.slice(-20);
  return `\n\nUSER'S SAVED MEMORIES:\n${recent.map(m => `[${m.date}] ${m.text}`).join('\n')}`;
}

ipcMain.handle('get-trusted-callers', () => {
  const settings = loadSettings();
  return settings.trustedCallers || [];
});

ipcMain.on('toggle-trusted-caller', (e, caller) => {
  const settings = loadSettings();
  const trusted = settings.trustedCallers || [];
  if (trusted.includes(caller)) {
    settings.trustedCallers = trusted.filter(c => c !== caller);
    console.log(`⭐ Removed trusted caller: @${caller}`);
  } else {
    settings.trustedCallers = [...trusted, caller];
    console.log(`⭐ Added trusted caller: @${caller}`);
  }
  saveJSON(SETTINGS_FILE, settings);
});

ipcMain.handle('add-memory-ipc', (e, text) => addMemory(text));
ipcMain.handle('get-memories', () => loadBrain().memories);
ipcMain.handle('delete-memory', (e, id) => {
  const brain = loadBrain();
  brain.memories = brain.memories.filter(m => m.id !== id);
  saveBrain(brain);
  return true;
});

// ─── WHALE ALERTS ─────────────────────────────────────────────────────────
let lastWhaleCheck = 0;

async function checkWhaleAlerts() {
  try {
    const now = Date.now();
    if (now - lastWhaleCheck < 5 * 60 * 1000) return; // Max every 5 min
    lastWhaleCheck = now;

    const res = await fetchT(
      'https://api.whale-alert.io/v1/transactions?api_key=demo&min_value=1000000&limit=5',
      {}, 10000
    );
    const data = await res.json();
    if (!data.transactions?.length) return;

    const settings = loadSettings();
    const watchedCoins = (settings.tradingCoins || ['BTC', 'ETH']).map(c => c.toLowerCase());

    for (const tx of data.transactions) {
      const symbol = tx.symbol?.toLowerCase();
      if (!watchedCoins.includes(symbol)) continue;

      const amount = tx.amount_usd ? `$${(tx.amount_usd / 1e6).toFixed(1)}M` : '';
      const from = tx.from?.owner_type === 'exchange' ? `${tx.from.owner} exchange` : 'unknown wallet';
      const to = tx.to?.owner_type === 'exchange' ? `${tx.to.owner} exchange` : 'unknown wallet';
      const direction = tx.to?.owner_type === 'exchange' ? '→ exchange (potential sell)' : '← from exchange (potential buy)';

      const msg = `🐳 Whale Alert\n${amount} ${symbol?.toUpperCase()} moved\n${from} → ${to}\n${direction}`;
      
      console.log(`🐳 ${msg}`);
      sendIntelEvent({
        type: 'signal',
        source: '🐳 Whale Alert',
        body: `${amount} ${symbol?.toUpperCase()} ${direction}`,
        note: `From: ${from} | To: ${to}`,
        notify: true
      });
      sendTelegramNotification(msg);
    }
  } catch(e) {
    // Demo key has limits — fail silently
  }
}

// ─── MORNING BRIEFING ─────────────────────────────────────────────────────
async function sendMorningBriefing() {
  const now = new Date();
  const hour = now.getHours();
  if (hour !== 8) return; // Only at 8am

  const settings = loadSettings();
  if (!settings.morningBriefing) return;

  try {
    const [btcPrice, ethPrice, fearGreed, dominance] = await Promise.all([
      getCryptoPrice('bitcoin'),
      getCryptoPrice('ethereum'),
      getFearGreed(),
      getDominance()
    ]);

    const pd = loadPaperTrades();
    const openTrades = pd.trades.filter(t => t.status === 'open');
    const todayPnl = pd.trades
      .filter(t => t.status !== 'open' && new Date(t.closeTime).toDateString() === now.toDateString())
      .reduce((s, t) => s + (t.pnl || 0), 0);

    const briefingPrompt = `You are Asuka giving a morning briefing. Be warm, concise, and helpful.

Market data:
BTC: ${btcPrice}
ETH: ${ethPrice}
Fear & Greed: ${fearGreed}
${dominance}

Open trades: ${openTrades.length}
${openTrades.map(t => `${t.direction?.toUpperCase()} ${t.coin} ${t.leverage}x`).join(', ')}

Today's P&L so far: $${todayPnl.toFixed(2)}

Give a friendly 3-4 sentence morning briefing covering:
1. Market mood
2. Key thing to watch today
3. Open positions status
4. One actionable suggestion

Keep it conversational and warm.`;

    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: briefingPrompt }]
    });

    const briefing = res.content[0].text;
    console.log('🌅 Morning briefing sent');
    sendTelegramNotification(`🌅 Good Morning!\n\n${briefing}`);

    if (mainWindow) {
      mainWindow.webContents.send('morning-briefing', { briefing });
    }
  } catch(e) {
    console.error('Morning briefing error:', e.message);
  }
}

// ─── TRADING PSYCHOLOGY SCORE ──────────────────────────────────────────────
async function calculatePsychologyScore() {
  const pd = loadPaperTrades();
  const settings = loadSettings();
  const recentTrades = pd.trades.filter(t => t.status !== 'open').slice(-20);
  
  if (recentTrades.length < 3) return null;

  let score = 100;
  const issues = [];
  const wins = [];

  // Check for revenge trading (3+ trades in 1 hour after loss)
  const tradesByHour = {};
  recentTrades.forEach(t => {
    const hour = Math.floor(t.openTime / 3600000);
    tradesByHour[hour] = (tradesByHour[hour] || 0) + 1;
  });
  const maxTradesPerHour = Math.max(...Object.values(tradesByHour));
  if (maxTradesPerHour >= 4) {
    score -= 20;
    issues.push('Revenge trading detected — too many trades in 1 hour');
  }

  // Check win rate
  const winRate = pd.stats.wins / (pd.stats.wins + pd.stats.losses) * 100;
  if (winRate < 40) { score -= 15; issues.push('Win rate below 40% — review strategy'); }
  else if (winRate > 60) { score += 10; wins.push('Strong win rate above 60%'); }

  // Check consecutive losses
  if (consecutiveLosses >= 3) {
    score -= 25;
    issues.push(`${consecutiveLosses} consecutive losses — take a break`);
  }

  // Check position sizing consistency
  const sizes = recentTrades.map(t => t.size);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const sizeVariance = sizes.some(s => s > avgSize * 2);
  if (sizeVariance) {
    score -= 10;
    issues.push('Inconsistent position sizing detected');
  }

  // Check if following confidence threshold
  const lowConfTrades = recentTrades.filter(t => t.confidence < 60);
  if (lowConfTrades.length > recentTrades.length * 0.3) {
    score -= 15;
    issues.push('Taking too many low confidence trades');
  }

  score = Math.max(0, Math.min(100, score));

  const scoreData = {
    score,
    grade: score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
    issues,
    wins,
    winRate: winRate.toFixed(1),
    consecutiveLosses,
    timestamp: Date.now()
  };

  console.log(`🧠 Psychology score: ${score}/100 (${scoreData.grade})`);
  return scoreData;
}

ipcMain.handle('get-psychology-score', calculatePsychologyScore);

// ─── START ALL NEW FEATURES ────────────────────────────────────────────────
function startNewFeatures() {
  // Whale alerts every 10 min
  setInterval(checkWhaleAlerts, 10 * 60 * 1000);
  setTimeout(checkWhaleAlerts, 30000); // First check after 30s

  // Morning briefing check every hour
  setInterval(sendMorningBriefing, 60 * 60 * 1000);
}

// ─── RAGE TRADE CHECK IN PAPER TRADES ─────────────────────────────────────
const PAPER_TRADES_FILE = path.join(DATA_DIR, 'paper-trades.json');
const PAPER_BALANCE = 100000; // Starting fake balance

function loadPaperTrades() {
  return loadJSON(PAPER_TRADES_FILE, {
    balance: PAPER_BALANCE,
    trades: [],
    stats: { wins: 0, losses: 0, totalPnl: 0 }
  });
}
function savePaperTrades(d) { saveJSON(PAPER_TRADES_FILE, d); }

// Open a new paper trade
async function openPaperTrade(signal) {
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
  const pd = loadPaperTrades();
  // settings already declared
  // Use signal leverage if provided (scalp trades), otherwise use settings
  const leverage = signal.leverage || settings.paperLeverage || 1;
  const size = signal.size || settings.paperTradeSize || (pd.balance * 0.05);
  const positionSize = size * leverage;
  const liquidationPct = 1 / leverage * 0.8;
  const liquidationPrice = signal.direction === 'long'
    ? signal.entry * (1 - liquidationPct)
    : signal.entry * (1 + liquidationPct);

  const trade = {
    id: Date.now(),
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

// Close a paper trade
async function closePaperTrade(tradeId, closePrice, reason) {
  const pd = loadPaperTrades();
  const trade = pd.trades.find(t => t.id === tradeId);
  if (!trade || trade.status !== 'open') return;

  const leverage = trade.leverage || 1;
  const priceDiff = trade.direction === 'long'
    ? closePrice - trade.entry
    : trade.entry - closePrice;
  const pnlPct = priceDiff / trade.entry;
  const pnl = trade.size * pnlPct * leverage;
  const actualPnl = Math.max(pnl, -trade.size); // can't lose more than margin

  trade.status = actualPnl > 0 ? 'win' : 'loss';
  trade.closePrice = closePrice;
  trade.closeTime = Date.now();
  trade.pnl = parseFloat(actualPnl.toFixed(2));
  trade.closeReason = reason;

  pd.balance = Math.max(0, pd.balance + actualPnl);
  if (actualPnl > 0) pd.stats.wins++;
  else pd.stats.losses++;
  pd.stats.totalPnl = parseFloat((pd.stats.totalPnl + actualPnl).toFixed(2));

  savePaperTrades(pd);

  if (trade.caller) updateCallerStats(trade.caller, actualPnl > 0);

  // Close on Binance testnet if linked
  if (trade.useBinance && trade.binanceSymbol) {
    try {
      await closeBinancePosition(trade.binanceSymbol, trade.binanceSide, trade.binanceQty);
    } catch(e) { console.error('Binance close error:', e.message); }
  }

  const pnlStr = `${actualPnl >= 0 ? '+' : ''}$${actualPnl.toFixed(2)} (${(pnlPct * leverage * 100).toFixed(1)}% at ${leverage}x)`;
  console.log(`${actualPnl > 0 ? '✅' : '❌'} Paper trade closed: ${trade.direction} ${trade.coin} — P&L: ${pnlStr} (${reason})${trade.useBinance ? ' [Binance Testnet]' : ''}`);

  // Set cooldown after loss
  if (actualPnl < 0) {
    const lossSettings = loadSettings();
    const cooldownMin = lossSettings.lossCooldownMinutes || 0;
    if (cooldownMin > 0) setCoinCooldown(trade.coin, cooldownMin);
  }

  // Track for rage lock
  if (actualPnl > 0) trackTradeWin();
  else trackTradeLoss(trade);

  // Learn from this trade
  // Queue learning to prevent concurrent rate limit hits
  queueLearnFromTrade(trade, actualPnl, reason);

  // Learn from chat patterns if TG signal
  if (trade.originalMessage && trade.caller) {
    learnFromChatPattern(trade, actualPnl).catch(e => console.error('Chat learn error:', e.message));
  }

  // Send TG notification
  const emoji = actualPnl > 0 ? '✅' : '❌';
  const msg = `${emoji} Paper Trade Closed\n${trade.direction?.toUpperCase()} ${trade.coin} ${leverage}x\nEntry: $${trade.entry} → Exit: $${closePrice}\nP&L: ${pnlStr}\nReason: ${reason}\nNew Balance: $${pd.balance.toFixed(2)}`;
  sendTelegramNotification(msg);

  if (mainWindow) mainWindow.webContents.send('paper-trade-closed', trade);
  return trade;
}

// Check open trades against current prices
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

      // Auto close after 7 days
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - trade.openTime > sevenDays) {
        closePaperTrade(trade.id, currentPrice, 'expired');
      }
    } catch(e) { console.error('Paper trade check error:', e.message); }
  }
}

// Run market scan for new signals
async function runMarketScan() {
  const settings = loadSettings();
  if (!settings.autoPaperTrade) return;
  const td = loadTelegramData();
  if (!td.signals?.length) return;

  const pd = loadPaperTrades();
  const threshold = settings.paperTradeThreshold || 20;

  // Check recent untraded signals
  const recentSignals = td.signals.filter(s => {
    const age = Date.now() - s.timestamp;
    const alreadyTraded = pd.trades.some(t => t.signalId === s.messageId);
    return age < 3600000 && !alreadyTraded && s.confidence >= threshold && s.coin && s.direction;
  });

  for (const signal of recentSignals) {
    try {
      // Get current price if entry not specified
      if (!signal.entry) {
        const priceStr = await getCryptoPrice(signal.coin.toLowerCase());
        const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
        if (priceMatch) signal.entry = parseFloat(priceMatch[1].replace(',', ''));
      }
      if (!signal.entry) continue;

      // Set default target and SL if missing
      if (!signal.target) {
        signal.target = signal.direction === 'long'
          ? parseFloat((signal.entry * 1.05).toFixed(2))
          : parseFloat((signal.entry * 0.95).toFixed(2));
      }
      if (!signal.stopLoss) {
        signal.stopLoss = signal.direction === 'long'
          ? parseFloat((signal.entry * 0.98).toFixed(2))
          : parseFloat((signal.entry * 1.02).toFixed(2));
      }

      // ── Run TG signal through full Claude→MiroFish→Claude pipeline ──
      console.log(`📡 Running TG signal through full pipeline: ${signal.direction} ${signal.coin} from @${signal.caller}`);

      // Get caller stats for context
      const callerStats = td.callerStats?.[signal.caller] || { wins: 0, losses: 0 };
      const callerWinRate = callerStats.wins + callerStats.losses > 0
        ? Math.round(callerStats.wins / (callerStats.wins + callerStats.losses) * 100)
        : 50;

      // ── Check if trusted caller — skip MiroFish debate ──────────────
      const settings3 = loadSettings();
      const trustedCallers = settings3.trustedCallers || [];
      const isTrusted = trustedCallers.includes(signal.caller);

      if (isTrusted && signal.entry && signal.target && signal.stopLoss) {
        console.log(`⭐ Trusted caller @${signal.caller} (${callerWinRate}% WR) — skipping analysis, auto-copying`);
        
        const tradeSignal = {
          ...signal,
          confidence: callerWinRate,
          groupName: `⭐ Trusted Caller | ${callerWinRate}% win rate | Auto-copied`
        };

        const trade = await openPaperTrade(tradeSignal);
        if (trade) {
          trade.signalId = signal.messageId;
          const pd2 = loadPaperTrades();
          const t = pd2.trades.find(tr => tr.id === trade.id);
          if (t) { t.signalId = signal.messageId; savePaperTrades(pd2); }
        }

        sendIntelEvent({
          type: 'signal',
          source: `⭐ @${signal.caller} (Trusted)`,
          body: `Auto-copied: ${signal.direction?.toUpperCase()} ${signal.coin}`,
          note: `Win rate: ${callerWinRate}% | Skipped analysis — trusted caller`,
          notify: true
        });
        continue;
      }
      // ────────────────────────────────────────────────────────────────

      // Load chat patterns for this caller
      const lessons = loadTradingLessons();
      const callerPatterns = lessons.chatPatterns?.[signal.caller] || [];

      // Get market data
      const [coinPrice, funding, fearGreed] = await Promise.all([
        getCryptoPrice(signal.coin.toLowerCase()).catch(() => null),
        getFundingRate(signal.coin).catch(() => null),
        getFearGreed().catch(() => null)
      ]);

      // Claude 1 — analyze TG signal with full context
      const tgAnalysis = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 250,
        messages: [{ role: 'user', content: `Analyze this Telegram trading signal and market conditions.

SIGNAL FROM @${signal.caller}:
"${signal.originalMessage || signal.direction + ' ' + signal.coin}"
Direction: ${signal.direction?.toUpperCase()} ${signal.coin}
Entry: $${signal.entry} | Target: $${signal.target} | SL: $${signal.stopLoss}

CALLER STATS:
Win rate: ${callerWinRate}% (${callerStats.wins}W/${callerStats.losses}L)
${callerPatterns.length > 0 ? `Known patterns: ${callerPatterns.slice(-3).map(p => p.pattern).join(', ')}` : 'No patterns yet'}

MARKET CONDITIONS:
${signal.coin} price: ${coinPrice}
Funding: ${funding}
Fear & Greed: ${fearGreed}

Should we trade this signal? Consider caller track record AND market conditions.

Respond ONLY with JSON:
{
  "shouldTrade": true/false,
  "direction": "${signal.direction}",
  "entry": ${signal.entry},
  "target": ${signal.target},
  "stopLoss": ${signal.stopLoss},
  "confidence": 0-100,
  "reason": "under 20 words",
  "marketBias": "bullish/bearish/neutral"
}` }]
      });

      const tgText = tgAnalysis.content[0].text.trim().replace(/```json|```/g,'').trim();
      const tgDecision = JSON.parse(tgText);

      console.log(`🤖 TG Claude 1: ${tgDecision.shouldTrade ? tgDecision.direction?.toUpperCase() : 'SKIP'} — ${tgDecision.confidence}% — ${tgDecision.reason}`);

      if (!tgDecision.shouldTrade || tgDecision.confidence < threshold) {
        console.log(`⏭️ TG signal rejected by Claude 1 — skipping`);
        continue;
      }

      // MiroFish validation for TG signals
      const tgMarketSummary = `${signal.coin} at ${coinPrice}, Funding: ${funding}, FG: ${fearGreed}. @${signal.caller} (${callerWinRate}% win rate) says ${signal.direction?.toUpperCase()}. Claude agrees with ${tgDecision.confidence}% confidence.`;

      console.log(`🐟 Running MiroFish for TG signal...`);

      // Quick 3-round debate (40 agents for speed)
      const TG_AGENTS = 40;
      const tgRoles = ['technical analyst','sentiment trader','whale watcher','macro analyst','contrarian trader','momentum trader','risk manager','news trader','funding specialist','pattern trader'];

      async function callTGAgent(role, prompt) {
        try {
          const res = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            messages: [{ role: 'user', content: prompt }]
          });
          const t = res.content[0].text.trim().replace(/```json|```/g,'').trim();
          return JSON.parse(t);
        } catch(e) { return null; }
      }

      // Round 1
      const tgR1 = await Promise.all(
        Array(TG_AGENTS).fill(0).map((_, i) => {
          const role = tgRoles[i % tgRoles.length];
          return callTGAgent(role,
            `You are a crypto ${role}. Market: ${tgMarketSummary}. AGREE with ${signal.direction?.toUpperCase()} ${signal.coin}? JSON: {"agree":true/false,"confidence":0-100,"reason":"5 words"}`,
            ).then(r => r || { agree: false, confidence: 50, reason: 'error' });
        })
      );

      const tgR1Agree = tgR1.filter(a => a.agree).length;
      const tgR1Pct = Math.round(tgR1Agree / TG_AGENTS * 100);
      const tgBullReasons = tgR1.filter(a => a.agree).map(a => a.reason).slice(0,2).join('; ');
      const tgBearReasons = tgR1.filter(a => !a.agree).map(a => a.reason).slice(0,2).join('; ');

      // Round 2
      const tgR1Summary = `${tgR1Agree}/${TG_AGENTS} support ${signal.direction?.toUpperCase()}. Bulls: ${tgBullReasons}. Bears: ${tgBearReasons}`;
      const tgR2 = await Promise.all(
        Array(TG_AGENTS).fill(0).map((_, i) => {
          const role = tgRoles[i % tgRoles.length];
          return callTGAgent(role,
            `You are a crypto ${role}. Debate: ${tgR1Summary}. Market: ${tgMarketSummary}. FINAL vote on ${signal.direction?.toUpperCase()} ${signal.coin}? JSON: {"agree":true/false,"confidence":0-100,"changed":true/false}`,
            ).then(r => r || tgR1[i] || { agree: false, confidence: 50 });
        })
      );

      const tgR2Agree = tgR2.filter(a => a.agree).length;
      const tgR2Pct = Math.round(tgR2Agree / TG_AGENTS * 100);
      const tgChanged = tgR2.filter(a => a.changed).length;

      console.log(`🐟 TG MiroFish: R1=${tgR1Pct}% → R2=${tgR2Pct}% | ${tgChanged} changed mind`);

      // Claude 2 — final decision with full story
      const tgFinalRes = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: `Final decision on TG trading signal.

SIGNAL: @${signal.caller} says ${signal.direction?.toUpperCase()} ${signal.coin}
Caller win rate: ${callerWinRate}%

CLAUDE 1 ANALYSIS:
${tgDecision.reason} — ${tgDecision.confidence}% confidence

MIROFISH DEBATE (40 agents, 2 rounds):
Round 1: ${tgR1Agree}/${TG_AGENTS} agree (${tgR1Pct}%)
Round 2: ${tgR2Agree}/${TG_AGENTS} agree (${tgR2Pct}%) | ${tgChanged} changed mind
Conviction: ${tgR2Pct > tgR1Pct ? '📈 Growing' : tgR2Pct < tgR1Pct ? '📉 Weakening' : '➡️ Stable'}

MARKET: ${signal.coin} at ${coinPrice}, FG: ${fearGreed}, Funding: ${funding}

Should we trade this signal? Consider caller track record + swarm + market.

JSON only:
{
  "shouldTrade": true/false,
  "direction": "${signal.direction}",
  "entry": ${signal.entry},
  "target": ${signal.target},
  "stopLoss": ${signal.stopLoss},
  "confidence": 0-100,
  "reason": "under 20 words"
}` }]
      });

      const tgFinalText = tgFinalRes.content[0].text.trim().replace(/```json|```/g,'').trim();
      const tgFinal = JSON.parse(tgFinalText);

      console.log(`🧠 TG Claude Final: ${tgFinal.shouldTrade ? 'TRADE' : 'SKIP'} — ${tgFinal.confidence}% — ${tgFinal.reason}`);

      if (!tgFinal.shouldTrade || tgFinal.confidence < threshold) {
        console.log(`❌ TG signal rejected by Claude 2`);
        return; // return instead of continue — we're in async function not loop
      }

      // Open the trade
      const tradeSignal = {
        ...signal,
        confidence: tgFinal.confidence,
        groupName: `${signal.groupName} | MiroFish ${tgR2Pct}% agree`
      };

      const trade = await openPaperTrade(tradeSignal);
      trade.signalId = signal.messageId;
      trade.originalMessage = signal.originalMessage || signal.direction + ' ' + signal.coin;

      const pd2 = loadPaperTrades();
      const t = pd2.trades.find(tr => tr.id === trade.id);
      if (t) { t.signalId = signal.messageId; t.originalMessage = trade.originalMessage; savePaperTrades(pd2); }

      console.log(`✅ TG signal traded after full pipeline: ${signal.direction} ${signal.coin}`);

      sendIntelEvent({
        type: 'signal',
        source: `@${signal.caller} → Full Pipeline`,
        body: `${signal.direction?.toUpperCase()} ${signal.coin} — ${tgFinal.confidence}% final confidence`,
        note: `Caller: ${callerWinRate}% WR | Swarm: ${tgR2Pct}% agree | ${tgChanged} changed mind`,
        action: 'Paper Trade Opened via Full Pipeline 🚀',
        notify: true
      });

    } catch(e) { console.error('Signal trade error:', e.message); }
  }
}

// ─── SMART PROFIT RECOMMENDATIONS ─────────────────────────────────────────
// Called in paper trading monitor
async function runPeriodicChecks() {
  await checkDCAPlans();
  await checkSmartPriceAlerts();
}

async function checkSmartProfitAlerts() {
  const pd = loadPaperTrades();
  const open = pd.trades.filter(t => t.status === 'open');
  if (!open.length) return;

  for (const trade of open) {
    try {
      const priceStr = await getCryptoPrice(trade.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (!priceMatch) continue;
      const currentPrice = parseFloat(priceMatch[1].replace(',', ''));
      if (isNaN(currentPrice)) continue;

      const leverage = trade.leverage || 1;
      const priceDiff = trade.direction === 'long'
        ? currentPrice - trade.entry
        : trade.entry - currentPrice;
      const pnlPct = priceDiff / trade.entry * leverage * 100;
      const pnlDollar = trade.size * priceDiff / trade.entry * leverage;

      // Smart recommendations at key levels
      const recommendations = [
        { pct: 5, msg: `up 5% — consider taking 25% profit and moving SL to breakeven` },
        { pct: 10, msg: `up 10% — strong move! Take 50% profit, let rest run` },
        { pct: 15, msg: `up 15% — take 75% profit, trail remaining with tight SL` },
        { pct: 20, msg: `up 20% 🔥 — consider full close, exceptional move` },
        { pct: 25, msg: `up 25% 🚀 — CLOSE IT. Don't get greedy!` },
        { pct: 50, msg: `up 50% 💰 — CLOSE EVERYTHING NOW. This is a gift.` },
      ];

      const lastRecommend = trade.lastRecommend || 0;

      for (const rec of recommendations) {
        if (pnlPct >= rec.pct && lastRecommend < rec.pct) {
          const msg = `💡 Trade Advice\n${trade.direction?.toUpperCase()} ${trade.coin} ${leverage}x\n${rec.msg}\nCurrent P&L: +$${pnlDollar.toFixed(2)} (+${pnlPct.toFixed(1)}%)\nEntry: $${trade.entry} | Current: $${currentPrice}`;
          
          console.log(`💡 Profit recommendation: ${trade.coin} ${rec.pct}%`);
          sendTelegramNotification(msg);
          
          sendIntelEvent({
            type: 'signal',
            source: '💡 Profit Advisor',
            body: `${trade.direction?.toUpperCase()} ${trade.coin} ${rec.msg}`,
            note: `P&L: +$${pnlDollar.toFixed(2)} (+${pnlPct.toFixed(1)}%) | Current: $${currentPrice}`,
            action: 'Take Profit Recommendation',
            notify: true
          });

          // Save recommendation level
          const pd2 = loadPaperTrades();
          const t = pd2.trades.find(tr => tr.id === trade.id);
          if (t) { t.lastRecommend = rec.pct; savePaperTrades(pd2); }
          break;
        }
      }
    } catch(e) {}
  }
}

// ─── TELEGRAM BOT ──────────────────────────────────────────────────────────
let tgBot = null;

async function startTelegramBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('ℹ️ No TELEGRAM_BOT_TOKEN — bot disabled. Add to .env to enable.');
    return;
  }

  const { Api } = require('telegram');
  let lastUpdateId = 0;

  async function pollBot() {
    try {
      const res = await fetchT(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
        {}, 15000
      );
      const data = await res.json();
      
      if (!data.ok || !data.result?.length) return;

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = msg.chat.id;
        const text = msg.text;
        console.log(`🤖 Bot message from ${chatId}: ${text}`);

        // Process through routeCommand
        try {
          const reply = await routeCommand(text);
          await fetchT(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: reply || "I'm here! 💙" })
          }, 8000);
        } catch(e) {
          console.error('Bot reply error:', e.message);
        }
      }
    } catch(e) {}
    
    // Poll every 2 seconds
    setTimeout(pollBot, 2000);
  }

  console.log('🤖 Telegram bot started — send messages to your bot!');
  pollBot();
}

// ─── CHAT PATTERN LEARNING ────────────────────────────────────────────────
async function learnFromChatPattern(trade, pnl) {
  try {
    const lessons = loadTradingLessons();
    if (!lessons.chatPatterns) lessons.chatPatterns = {};
    if (!lessons.chatPatterns[trade.caller]) lessons.chatPatterns[trade.caller] = [];

    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [{ role: 'user', content: `Analyze this Telegram trading message outcome.

CALLER: @${trade.caller}
MESSAGE: "${trade.originalMessage}"
RESULT: ${pnl >= 0 ? 'WIN' : 'LOSS'} — ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}
TRADE: ${trade.direction?.toUpperCase()} ${trade.coin} at $${trade.entry}

Extract key pattern from this message that predicted the ${pnl >= 0 ? 'win' : 'loss'}.
JSON only:
{
  "pattern": "key phrase or signal from message",
  "sentiment": "bullish/bearish",
  "reliability": "high/medium/low",
  "lesson": "one sentence about this caller's style"
}` }]
    });

    const text = res.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g,'').trim();
    const pattern = JSON.parse(text);

    lessons.chatPatterns[trade.caller].push({
      ...pattern,
      won: pnl >= 0,
      pnl: pnl.toFixed(2),
      message: trade.originalMessage?.slice(0, 100),
      timestamp: Date.now()
    });

    if (lessons.chatPatterns[trade.caller].length > 20) {
      lessons.chatPatterns[trade.caller] = lessons.chatPatterns[trade.caller].slice(-20);
    }

    saveTradingLessons(lessons);
    console.log(`📚 Chat pattern learned from @${trade.caller}: ${pattern.pattern} (${pnl >= 0 ? 'WIN' : 'LOSS'})`);
  } catch(e) { console.error('Chat pattern error:', e.message); }
}

// ─── TELEGRAM BOT ──────────────────────────────────────────────────────────
const botAuthCodes = new Map(); // code → chatId
const botAuthUsers = new Map(); // chatId → authenticated

async function startTelegramBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.log('ℹ️ No TELEGRAM_BOT_TOKEN — bot disabled');
    return;
  }

  let lastUpdateId = 0;

  async function sendBotMessage(chatId, text) {
    try {
      await fetchT(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      }, 8000);
    } catch(e) { console.error('Bot send error:', e.message); }
  }

  async function pollBot() {
    try {
      const res = await fetchT(
        `https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`,
        {}, 15000
      );
      const data = await res.json();
      if (!data.ok || !data.result?.length) { setTimeout(pollBot, 2000); return; }

      for (const update of data.result) {
        lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const settings = loadSettings();

        // ── /start command ──
        if (text === '/start') {
          // Generate 4-digit auth code
          const code = `ASK-${Math.floor(1000 + Math.random() * 9000)}`;
          botAuthCodes.set(code, chatId);
          // Auto expire code after 10 minutes
          setTimeout(() => botAuthCodes.delete(code), 10 * 60 * 1000);

          await sendBotMessage(chatId, `👋 <b>Welcome to Asuka AI!</b>\n\nYour connection code is:\n\n<b>${code}</b>\n\nEnter this code in the Asuka app under Settings → Telegram Bot.\n\nCode expires in 10 minutes.`);
          continue;
        }

        // ── Check if already authenticated ──
        const isAuth = settings.telegramBotChatId === chatId;

        if (!isAuth) {
          await sendBotMessage(chatId, `⚠️ Not connected. Send /start to get your connection code, then enter it in the Asuka app.`);
          continue;
        }

        // ── Authenticated user commands ──
        console.log(`🤖 Bot from authenticated user: ${text}`);

        // Special bot commands
        if (text === '/positions' || text.toLowerCase().includes('open positions') || text.toLowerCase().includes('my trades')) {
          const pd = loadPaperTrades();
          const open = pd.trades.filter(t => t.status === 'open');
          if (!open.length) {
            await sendBotMessage(chatId, '📊 No open positions right now.');
          } else {
            let msg = '📊 <b>Open Positions:</b>\n\n';
            for (const t of open) {
              try {
                const priceStr = await getCryptoPrice(t.coin.toLowerCase());
                const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
                const currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;
                
                let pnlStr = '';
                if (currentPrice) {
                  const leverage = t.leverage || 1;
                  const priceDiff = t.direction === 'long'
                    ? currentPrice - t.entry
                    : t.entry - currentPrice;
                  const pnlPct = (priceDiff / t.entry * leverage * 100).toFixed(1);
                  const pnlDollar = (t.size * priceDiff / t.entry * leverage).toFixed(2);
                  const isProfit = parseFloat(pnlDollar) >= 0;
                  pnlStr = `\nP&L: ${isProfit ? '+' : ''}$${pnlDollar} (${isProfit ? '+' : ''}${pnlPct}%)\nCurrent: $${currentPrice}`
                }

                msg += `<b>${t.direction?.toUpperCase()} ${t.coin} ${t.leverage}x</b>\nEntry: $${t.entry} | Target: $${t.target}\nSL: $${t.stopLoss} | Confidence: ${t.confidence}%${pnlStr}\n\n`;
              } catch(e) {
                msg += `<b>${t.direction?.toUpperCase()} ${t.coin} ${t.leverage}x</b>\nEntry: $${t.entry} | Target: $${t.target}\nSL: $${t.stopLoss}\n\n`;
              }
            }
            await sendBotMessage(chatId, msg);
          }
          continue;
        }

        if (text === '/balance' || text.toLowerCase().includes('my balance')) {
          const pd = loadPaperTrades();
          const closed = pd.trades.filter(t => t.status !== 'open');
          const winRate = closed.length ? Math.round(pd.stats.wins / closed.length * 100) : 0;
          await sendBotMessage(chatId, `💰 <b>Paper Trading Stats:</b>\nBalance: $${pd.balance.toFixed(2)}\nWin Rate: ${winRate}%\nTotal P&L: ${pd.stats.totalPnl >= 0 ? '+' : ''}$${pd.stats.totalPnl.toFixed(2)}\nTrades: ${closed.length}`);
          continue;
        }

        if (text === '/pause' || text.toLowerCase() === 'pause trading') {
          const s = loadSettings();
          s.autoPaperTrade = false;
          saveJSON(SETTINGS_FILE, s);
          await sendBotMessage(chatId, '⏸️ Auto trading paused.');
          continue;
        }

        if (text === '/resume' || text.toLowerCase() === 'resume trading') {
          const s = loadSettings();
          s.autoPaperTrade = true;
          saveJSON(SETTINGS_FILE, s);
          await sendBotMessage(chatId, '▶️ Auto trading resumed.');
          continue;
        }

        if (text === '/help') {
          await sendBotMessage(chatId, `<b>Asuka Commands:</b>\n\n/positions — Open trades with live P&L\n/close BTC — Close specific trade\n/closeall — Close all trades\n/leverage 10 — Set leverage (1-150)\n/alert BTC 80000 — Set price alert\n/balance — Paper trading stats\n/pause — Pause auto trading\n/resume — Resume auto trading`);
          continue;
        }

        // Set leverage
        if (text.toLowerCase().startsWith('/leverage')) {
          const lev = parseInt(text.split(' ')[1]);
          if (!lev || lev < 1 || lev > 150) {
            await sendBotMessage(chatId, '⚡ Usage: /leverage 10\nRange: 1-150');
            continue;
          }
          const s = loadSettings();
          s.paperLeverage = lev;
          saveJSON(SETTINGS_FILE, s);
          await sendBotMessage(chatId, `⚡ Leverage set to ${lev}x${lev >= 50 ? ' ⚠️ High risk!' : lev >= 20 ? ' — be careful' : ' ✅'}`);
          continue;
        }

        // Set price alert
        if (text.toLowerCase().startsWith('/alert')) {
          const parts = text.split(' ');
          const coin = parts[1]?.toUpperCase();
          const price = parseFloat(parts[2]);
          if (!coin || !price) {
            await sendBotMessage(chatId, '🔔 Usage: /alert BTC 80000');
            continue;
          }
          const s = loadSettings();
          s.alerts = s.alerts || [];
          const priceStr = await getCryptoPrice(coin.toLowerCase());
          const currentMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
          const current = currentMatch ? parseFloat(currentMatch[1].replace(',', '')) : null;
          const direction = current ? (price > current ? 'above' : 'below') : 'above';
          s.alerts.push({ id: Date.now().toString(), coin, target: price, direction, triggered: false });
          saveJSON(SETTINGS_FILE, s);
          await sendBotMessage(chatId, `🔔 Alert set: notify when ${coin} goes ${direction} $${price.toLocaleString()}${current ? `\nCurrent: $${current.toLocaleString()}` : ''}`);
          continue;
        }

        // Close specific trade
        if (text.toLowerCase().startsWith('/close')) {
          const parts = text.split(' ');
          const coin = parts[1]?.toUpperCase();
          const pd = loadPaperTrades();
          
          if (text.toLowerCase() === '/closeall') {
            const open = pd.trades.filter(t => t.status === 'open');
            let closed = 0;
            for (const t of open) {
              try {
                const priceStr = await getCryptoPrice(t.coin.toLowerCase());
                const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
                const currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : t.entry;
                closePaperTrade(t.id, currentPrice, 'manual close via bot');
                closed++;
              } catch(e) {}
            }
            await sendBotMessage(chatId, `✅ Closed ${closed} trades.`);
            continue;
          }
          
          if (coin) {
            const trade = pd.trades.find(t => t.status === 'open' && t.coin === coin);
            if (trade) {
              try {
                const priceStr = await getCryptoPrice(trade.coin.toLowerCase());
                const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
                const currentPrice = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : trade.entry;
                const closed = closePaperTrade(trade.id, currentPrice, 'manual close via bot');
                await sendBotMessage(chatId, `${closed?.status === 'win' ? '✅' : '❌'} ${coin} trade closed\nP&L: ${closed?.pnl >= 0 ? '+' : ''}$${closed?.pnl}`);
              } catch(e) {
                await sendBotMessage(chatId, `Error closing ${coin} trade`);
              }
            } else {
              await sendBotMessage(chatId, `No open ${coin} trade found.`);
            }
            continue;
          }
        }

        // Route through Asuka's brain
        try {
          const reply = await routeCommand(text);
          await sendBotMessage(chatId, reply || "I'm here! 💙");
        } catch(e) {
          await sendBotMessage(chatId, 'Having a moment — try again! 💙');
        }
      }
    } catch(e) {}
    setTimeout(pollBot, 2000);
  }

  console.log('🤖 Telegram bot started');
  pollBot();

  // Override sendTelegramNotification to use bot if authenticated
  const originalSendTG = sendTelegramNotification;
  global.sendTelegramNotificationBot = async (message) => {
    const settings = loadSettings();
    const chatId = settings.telegramBotChatId;
    if (chatId && botToken) {
      await sendBotMessage(chatId, message);
    } else {
      await originalSendTG(message);
    }
  };
}

// IPC handler for bot authentication
ipcMain.handle('authenticate-bot', async (e, code) => {
  const chatId = botAuthCodes.get(code);
  if (!chatId) return { success: false, error: 'Invalid or expired code' };
  
  const settings = loadSettings();
  settings.telegramBotChatId = chatId;
  saveJSON(SETTINGS_FILE, settings);
  botAuthCodes.delete(code);
  
  console.log(`✅ Bot authenticated for chatId: ${chatId}`);
  return { success: true, chatId };
});

// Add smart profit check to paper trading monitor
let paperTradeInterval = null;


// ─── MARKET REGIME DETECTION ──────────────────────────────────────────────
let _cachedMarketRegime = null;
let _regimeLastUpdated = 0;

async function detectMarketRegime() {
  // Cache for 30 min
  if (_cachedMarketRegime && Date.now() - _regimeLastUpdated < 30 * 60 * 1000) {
    return _cachedMarketRegime;
  }
  try {
    const [btcCandles, fg, btcDom] = await Promise.all([
      getCandles('BTC', '1d', 30).catch(() => null),
      getFearGreed().catch(() => null),
      getBTCDominanceTrend().catch(() => null)
    ]);
    if (!btcCandles) return 'unknown';

    const closes = btcCandles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / 20;
    const sma7 = closes.slice(-7).reduce((s, v) => s + v, 0) / 7;
    const priceChange30d = ((currentPrice - closes[0]) / closes[0] * 100).toFixed(1);
    const fgNum = parseInt(fg?.match(/\d+/)?.[0] || 50);
    const rsi = calcRSI(btcCandles, 14);

    let regime = 'sideways';
    let bias = 'neutral';
    let strength = 'weak';

    // Determine regime
    if (currentPrice > sma20 && sma7 > sma20 && parseFloat(priceChange30d) > 5) {
      regime = 'bull';
      bias = 'long';
      strength = parseFloat(priceChange30d) > 15 ? 'strong' : 'moderate';
    } else if (currentPrice < sma20 && sma7 < sma20 && parseFloat(priceChange30d) < -5) {
      regime = 'bear';
      bias = 'short';
      strength = parseFloat(priceChange30d) < -15 ? 'strong' : 'moderate';
    } else {
      regime = 'sideways';
      bias = 'neutral';
      strength = 'weak';
    }

    // Override with extreme FG
    if (fgNum < 15) { regime = 'bear'; bias = 'short'; }
    if (fgNum > 85) { regime = 'bull'; bias = 'long'; }

    const result = {
      regime,
      bias,
      strength,
      fgNum,
      priceChange30d,
      rsi,
      summary: `Market Regime: ${regime.toUpperCase()} (${strength}) | Bias: ${bias.toUpperCase()} | 30d: ${priceChange30d}% | FG: ${fgNum}`
    };

    _cachedMarketRegime = result;
    _regimeLastUpdated = Date.now();
    console.log(`🌍 Market regime: ${regime} (${strength}) — bias: ${bias}`);
    return result;
  } catch(e) {
    return { regime: 'unknown', bias: 'neutral', strength: 'weak', summary: 'Regime unknown' };
  }
}

// ─── MULTI-TIMEFRAME CONFIRMATION ─────────────────────────────────────────
async function getMultiTimeframeSignal(coin, direction) {
  try {
    const [candles1h, candles4h, candles1d] = await Promise.all([
      getCandles(coin, '1h', 20).catch(() => null),
      getCandles(coin, '4h', 20).catch(() => null),
      getCandles(coin, '1d', 20).catch(() => null)
    ]);

    const rsi1h = candles1h ? calcRSI(candles1h, 14) : null;
    const rsi4h = candles4h ? calcRSI(candles4h, 14) : null;
    const rsi1d = candles1d ? calcRSI(candles1d, 14) : null;

    let aligned = 0;
    let total = 0;

    const checkRSI = (rsi, tf) => {
      if (!rsi) return;
      total++;
      if (direction === 'long' && rsi < 50) aligned++;
      else if (direction === 'short' && rsi > 50) aligned++;
    };

    checkRSI(rsi1h, '1h');
    checkRSI(rsi4h, '4h');
    checkRSI(rsi1d, '1d');

    const alignmentPct = total > 0 ? Math.round(aligned / total * 100) : 0;
    const isAligned = alignmentPct >= 67; // at least 2/3 timeframes agree

    return {
      rsi1h, rsi4h, rsi1d,
      aligned, total, alignmentPct, isAligned,
      summary: `MTF Confirmation: ${aligned}/${total} timeframes agree (1h:${rsi1h?.toFixed(0)} 4h:${rsi4h?.toFixed(0)} 1d:${rsi1d?.toFixed(0)}) — ${isAligned ? '✅ ALIGNED' : '⚠️ MIXED'}`
    };
  } catch(e) { return null; }
}

// ─── NEWS SENTIMENT SCORING ────────────────────────────────────────────────
let _cachedNewsSentiment = null;
let _newsLastUpdated = 0;

async function getNewsSentiment(coin = 'BTC') {
  // Cache 1 hour
  if (_cachedNewsSentiment?.[coin] && Date.now() - _newsLastUpdated < 60 * 60 * 1000) {
    return _cachedNewsSentiment[coin];
  }
  try {
    const news = await getCryptoNews();
    if (!news) return null;

    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: `Rate the sentiment of these crypto news headlines for ${coin} trading.
Headlines: ${news.slice(0, 300)}
Score from -10 (very bearish) to +10 (very bullish). 
JSON only: {"score": number, "label": "very bearish/bearish/neutral/bullish/very bullish", "key_event": "one key event in 5 words"}` }]
    });

    const text = res.content[0].text.replace(/\`\`\`json|\`\`\`/g, '').trim();
    const sentiment = JSON.parse(text);

    if (!_cachedNewsSentiment) _cachedNewsSentiment = {};
    _cachedNewsSentiment[coin] = sentiment;
    _newsLastUpdated = Date.now();

    return sentiment;
  } catch(e) { return null; }
}

// ─── WHALE ALERT TRADE SIGNAL ─────────────────────────────────────────────
function getWhaleSignalForTrade(coin) {
  try {
    const pd = loadPaperTrades();
    const whaleAlerts = pd.whaleAlerts || [];
    const recentWhales = whaleAlerts.filter(w =>
      w.coin?.toUpperCase() === coin.toUpperCase() &&
      Date.now() - w.timestamp < 30 * 60 * 1000 // last 30 min
    );

    if (!recentWhales.length) return null;

    let bullishSignals = 0;
    let bearishSignals = 0;

    recentWhales.forEach(w => {
      if (w.to === 'unknown' || w.to?.includes('wallet')) bullishSignals++; // moved off exchange
      if (w.to?.includes('exchange') || w.to?.includes('binance') || w.to?.includes('coinbase')) bearishSignals++; // moved to exchange
    });

    if (bullishSignals > bearishSignals) {
      return `🐋 Whale activity: ${bullishSignals} large transfers OFF exchange — accumulation signal (bullish)`;
    } else if (bearishSignals > bullishSignals) {
      return `🐋 Whale activity: ${bearishSignals} large transfers TO exchange — distribution signal (bearish)`;
    }
    return `🐋 ${recentWhales.length} whale transactions in last 30min — high activity`;
  } catch(e) { return null; }
}

// ─── COOLDOWN AFTER LOSS ───────────────────────────────────────────────────
const COIN_COOLDOWNS = {};

function setCoinCooldown(coin, minutes = 30) {
  COIN_COOLDOWNS[coin] = Date.now() + minutes * 60 * 1000;
  console.log(`⏰ Cooldown set for ${coin}: ${minutes} min`);
}

function isCoinOnCooldown(coin) {
  const cooldownUntil = COIN_COOLDOWNS[coin];
  if (!cooldownUntil) return false;
  if (Date.now() > cooldownUntil) {
    delete COIN_COOLDOWNS[coin];
    return false;
  }
  const remaining = Math.round((cooldownUntil - Date.now()) / 60000);
  return remaining;
}

// ─── KELLY CRITERION POSITION SIZING ──────────────────────────────────────
function calcKellySize(coin, baseSize) {
  try {
    const pd = loadPaperTrades();
    const coinTrades = pd.trades.filter(t =>
      t.coin === coin && t.status !== 'open' && t.pnl !== undefined
    ).slice(-20); // last 20 trades

    if (coinTrades.length < 5) return baseSize; // not enough data

    const wins = coinTrades.filter(t => t.pnl > 0);
    const losses = coinTrades.filter(t => t.pnl <= 0);

    if (!wins.length || !losses.length) return baseSize;

    const winRate = wins.length / coinTrades.length;
    const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);

    if (avgLoss === 0) return baseSize;

    const winLossRatio = avgWin / avgLoss;
    // Kelly formula: f = W - (1-W)/R where W=winRate, R=win/loss ratio
    const kelly = winRate - (1 - winRate) / winLossRatio;
    const halfKelly = Math.max(0.1, Math.min(0.5, kelly / 2)); // Half-Kelly, capped 10-50%

    const kellySize = Math.round(baseSize * (halfKelly / 0.1)); // scale to base
    console.log(`📐 Kelly ${coin}: W=${(winRate*100).toFixed(0)}% R=${winLossRatio.toFixed(1)} → ${(halfKelly*100).toFixed(0)}% → $${kellySize}`);
    return kellySize;
  } catch(e) { return baseSize; }
}

// ─── CORRELATION MATRIX ────────────────────────────────────────────────────
const CORRELATED_PAIRS = {
  'BTC': ['ETH'],
  'ETH': ['BTC'],
  'SOL': ['ETH', 'BTC'],
  'DOGE': ['SHIB'],
  'BNB': ['BTC'],
};

function checkCorrelationConflict(coin, direction) {
  try {
    const pd = loadPaperTrades();
    const openTrades = pd.trades.filter(t => t.status === 'open');
    const correlated = CORRELATED_PAIRS[coin] || [];

    for (const corr of correlated) {
      const existingTrade = openTrades.find(t => t.coin === corr);
      if (existingTrade && existingTrade.direction === direction) {
        return `⚠️ Correlation risk: Already ${direction} ${corr} — ${coin}/${corr} are correlated, double exposure`;
      }
    }
    return null;
  } catch(e) { return null; }
}

// ─── TRADE PERFORMANCE ANALYTICS ─────────────────────────────────────────
function getTradeAnalytics() {
  try {
    const pd = loadPaperTrades();
    const closed = pd.trades.filter(t => t.status !== 'open' && t.pnl !== undefined);
    if (closed.length < 3) return null;

    // Best coin
    const coinStats = {};
    closed.forEach(t => {
      if (!coinStats[t.coin]) coinStats[t.coin] = { wins: 0, losses: 0, pnl: 0, count: 0 };
      coinStats[t.coin].count++;
      coinStats[t.coin].pnl += t.pnl;
      if (t.pnl > 0) coinStats[t.coin].wins++;
      else coinStats[t.coin].losses++;
    });

    const bestCoin = Object.entries(coinStats)
      .sort((a, b) => b[1].pnl - a[1].pnl)[0];
    const worstCoin = Object.entries(coinStats)
      .sort((a, b) => a[1].pnl - b[1].pnl)[0];

    // Best time of day
    const hourStats = {};
    closed.forEach(t => {
      const hour = new Date(t.openTime).getUTCHours();
      if (!hourStats[hour]) hourStats[hour] = { wins: 0, losses: 0, pnl: 0 };
      hourStats[hour].pnl += t.pnl;
      if (t.pnl > 0) hourStats[hour].wins++;
      else hourStats[hour].losses++;
    });

    const bestHour = Object.entries(hourStats)
      .sort((a, b) => b[1].pnl - a[1].pnl)[0];

    // Avg hold time
    const closedWithTime = closed.filter(t => t.closeTime && t.openTime);
    const avgHoldMs = closedWithTime.reduce((s, t) => s + (t.closeTime - t.openTime), 0) / (closedWithTime.length || 1);
    const avgHoldMin = Math.round(avgHoldMs / 60000);

    // Best signal type
    const callerStats = {};
    closed.forEach(t => {
      const caller = t.caller || 'unknown';
      if (!callerStats[caller]) callerStats[caller] = { wins: 0, total: 0, pnl: 0 };
      callerStats[caller].total++;
      callerStats[caller].pnl += t.pnl;
      if (t.pnl > 0) callerStats[caller].wins++;
    });

    return {
      bestCoin: bestCoin ? { coin: bestCoin[0], ...bestCoin[1] } : null,
      worstCoin: worstCoin ? { coin: worstCoin[0], ...worstCoin[1] } : null,
      bestHour: bestHour ? { hour: parseInt(bestHour[0]), ...bestHour[1] } : null,
      avgHoldMin,
      coinStats,
      callerStats,
      totalTrades: closed.length,
      totalPnl: closed.reduce((s, t) => s + t.pnl, 0)
    };
  } catch(e) { return null; }
}

// IPC handlers for new features
ipcMain.handle('get-market-regime', async () => detectMarketRegime());
ipcMain.handle('get-trade-analytics', () => getTradeAnalytics());
ipcMain.handle('get-coin-cooldowns', () => COIN_COOLDOWNS);



// ─── DAILY P&L HARD STOP ──────────────────────────────────────────────────
let _tradingPausedUntil = 0;
let _dailyPnlTracker = { date: null, pnl: 0 };

function checkDailyPnlLimit() {
  const settings = loadSettings();
  const limit = settings.dailyLossLimit;
  if (!limit || limit <= 0) return false;

  const today = new Date().toDateString();
  if (_dailyPnlTracker.date !== today) {
    _dailyPnlTracker = { date: today, pnl: 0 };
  }

  // Calculate today's closed P&L
  const pd = loadPaperTrades();
  const todayTrades = pd.trades.filter(t => {
    if (!t.closeTime) return false;
    return new Date(t.closeTime).toDateString() === today;
  });
  const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);

  if (todayPnl <= -Math.abs(limit)) {
    console.log(`🛑 Daily loss limit hit: $${todayPnl.toFixed(2)} (limit: -$${limit})`);
    sendTelegramNotification(`🛑 DAILY LOSS LIMIT HIT
Loss: $${Math.abs(todayPnl).toFixed(2)}
Limit: $${limit}
All trading paused until midnight UTC`);
    sendIntelEvent({
      type: 'alert',
      source: '🛑 Risk Management',
      body: `Daily loss limit hit — $${Math.abs(todayPnl).toFixed(2)} lost today`,
      note: `Trading paused. Limit: $${limit}. Resets at midnight UTC.`,
      notify: true
    });
    return true;
  }
  return false;
}

function isTradingPaused() {
  if (checkDailyPnlLimit()) return true;
  if (_tradingPausedUntil > Date.now()) return true;
  return false;
}

// ─── MAX CONCURRENT POSITIONS ─────────────────────────────────────────────
function checkMaxPositions() {
  const settings = loadSettings();
  const maxPositions = settings.maxOpenPositions;
  if (!maxPositions || maxPositions <= 0) return false;

  const pd = loadPaperTrades();
  const openCount = pd.trades.filter(t => t.status === 'open').length;

  if (openCount >= maxPositions) {
    console.log(`⚠️ Max positions reached: ${openCount}/${maxPositions}`);
    return true;
  }
  return false;
}

// ─── RSI DIVERGENCE DETECTION ─────────────────────────────────────────────
async function detectRSIDivergence(coin) {
  try {
    const candles = await getCandles(coin, '1h', 50);
    if (!candles || candles.length < 20) return null;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    // Calculate RSI for last 20 candles
    const rsiValues = [];
    for (let i = candles.length - 20; i < candles.length; i++) {
      const slice = candles.slice(Math.max(0, i - 14), i + 1);
      rsiValues.push(calcRSI(slice, 14) || 50);
    }

    const recentCloses = closes.slice(-20);
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);

    // Find recent swing highs/lows
    const findPeaks = (arr) => {
      const peaks = [];
      for (let i = 1; i < arr.length - 1; i++) {
        if (arr[i] > arr[i-1] && arr[i] > arr[i+1]) peaks.push({ idx: i, val: arr[i] });
      }
      return peaks.slice(-3);
    };

    const pricePeaks = findPeaks(recentHighs);
    const rsiPeaks = findPeaks(rsiValues);
    const priceTroughs = findPeaks(recentLows.map(v => -v)).map(p => ({ idx: p.idx, val: -p.val }));
    const rsiTroughs = findPeaks(rsiValues.map(v => -v)).map(p => ({ idx: p.idx, val: -p.val }));

    let divergence = null;

    // Bearish divergence: price higher high, RSI lower high
    if (pricePeaks.length >= 2 && rsiPeaks.length >= 2) {
      const lastPrice = pricePeaks[pricePeaks.length-1];
      const prevPrice = pricePeaks[pricePeaks.length-2];
      const lastRSI = rsiPeaks[rsiPeaks.length-1];
      const prevRSI = rsiPeaks[rsiPeaks.length-2];

      if (lastPrice.val > prevPrice.val && lastRSI.val < prevRSI.val) {
        divergence = {
          type: 'bearish',
          signal: `🔴 BEARISH DIVERGENCE: Price made higher high ($${lastPrice.val.toFixed(2)}) but RSI made lower high (${lastRSI.val.toFixed(0)}) — reversal warning`,
          strength: 'strong'
        };
      }
    }

    // Bullish divergence: price lower low, RSI higher low
    if (!divergence && priceTroughs.length >= 2 && rsiTroughs.length >= 2) {
      const lastPrice = priceTroughs[priceTroughs.length-1];
      const prevPrice = priceTroughs[priceTroughs.length-2];
      const lastRSI = rsiTroughs[rsiTroughs.length-1];
      const prevRSI = rsiTroughs[rsiTroughs.length-2];

      if (lastPrice.val < prevPrice.val && lastRSI.val > prevRSI.val) {
        divergence = {
          type: 'bullish',
          signal: `🟢 BULLISH DIVERGENCE: Price made lower low ($${lastPrice.val.toFixed(2)}) but RSI made higher low (${lastRSI.val.toFixed(0)}) — reversal opportunity`,
          strength: 'strong'
        };
      }
    }

    return divergence;
  } catch(e) { return null; }
}

// ─── TG GROUP SENTIMENT ────────────────────────────────────────────────────
async function getTelegramGroupSentiment(coin) {
  try {
    const td = loadTelegramData();
    if (!td.signals?.length) return null;

    // Get last 2 hours of signals
    const recent = td.signals.filter(s =>
      Date.now() - s.timestamp < 2 * 60 * 60 * 1000 &&
      s.coin?.toUpperCase() === coin.toUpperCase()
    );

    if (recent.length < 2) return null;

    const longs = recent.filter(s => s.direction === 'long').length;
    const shorts = recent.filter(s => s.direction === 'short').length;
    const total = longs + shorts;
    const longPct = Math.round(longs / total * 100);

    let signal = '';
    if (longPct > 70) signal = `⚠️ TG groups ${longPct}% bullish on ${coin} — contrarian SHORT signal (crowded longs)`;
    else if (longPct < 30) signal = `⚠️ TG groups ${100-longPct}% bearish on ${coin} — contrarian LONG signal (crowded shorts)`;
    else signal = `TG sentiment balanced: ${longPct}% long / ${100-longPct}% short`;

    return { longPct, total, signal };
  } catch(e) { return null; }
}

// ─── SIGNAL QUALITY SCORING ────────────────────────────────────────────────
function scoreSignalQuality(signal, callerStats, marketData) {
  let score = 50; // base score
  const reasons = [];

  // Caller track record
  if (callerStats) {
    const wr = callerStats.winRate || 50;
    if (wr >= 70) { score += 20; reasons.push(`Caller ${wr}% WR`); }
    else if (wr >= 55) { score += 10; reasons.push(`Caller ${wr}% WR`); }
    else if (wr < 40) { score -= 15; reasons.push(`Caller low ${wr}% WR`); }
  }

  // Confidence level
  if (signal.confidence >= 80) { score += 15; reasons.push('High confidence'); }
  else if (signal.confidence < 50) { score -= 10; reasons.push('Low confidence'); }

  // Has TP and SL
  if (signal.target && signal.stopLoss) { score += 5; reasons.push('Has TP+SL'); }
  else { score -= 10; reasons.push('Missing TP or SL'); }

  // Market alignment
  const fg = global._cachedFearGreed || 50;
  if (signal.direction === 'short' && fg < 30) { score += 10; reasons.push('Aligned with fear'); }
  if (signal.direction === 'long' && fg > 70) { score += 10; reasons.push('Aligned with greed'); }

  // Regime alignment
  if (global._cachedMarketRegime) {
    const regime = global._cachedMarketRegime;
    if (signal.direction === regime.bias) { score += 10; reasons.push('With regime'); }
    else if (regime.bias !== 'neutral') { score -= 10; reasons.push('Against regime'); }
  }

  score = Math.max(0, Math.min(100, score));
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D';

  return { score, grade, reasons, label: `Signal Quality: ${score}/100 (Grade ${grade})` };
}

// ─── DAILY TRADE SUMMARY REPORT ───────────────────────────────────────────
async function sendDailyTradeSummary() {
  try {
    const pd = loadPaperTrades();
    const today = new Date().toDateString();
    const todayTrades = pd.trades.filter(t =>
      t.closeTime && new Date(t.closeTime).toDateString() === today
    );

    if (!todayTrades.length) return;

    const wins = todayTrades.filter(t => t.pnl > 0);
    const losses = todayTrades.filter(t => t.pnl <= 0);
    const totalPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const winRate = Math.round(wins.length / todayTrades.length * 100);

    const bestTrade = wins.sort((a, b) => b.pnl - a.pnl)[0];
    const worstTrade = losses.sort((a, b) => a.pnl - b.pnl)[0];

    // Get AI lesson from today
    const lessonsCtx = buildLessonsContext();

    const summary = `📊 DAILY TRADE SUMMARY
Date: ${new Date().toLocaleDateString()}

Results:
✅ Wins: ${wins.length} | ❌ Losses: ${losses.length}
📈 Win Rate: ${winRate}%
💰 Total P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}
💼 Balance: $${pd.balance.toFixed(2)}

${bestTrade ? `🏆 Best: ${bestTrade.coin} ${bestTrade.direction?.toUpperCase()} +$${bestTrade.pnl.toFixed(2)}` : ''}
${worstTrade ? `💀 Worst: ${worstTrade.coin} ${worstTrade.direction?.toUpperCase()} $${worstTrade.pnl.toFixed(2)}` : ''}

${totalPnl > 0 ? '🌟 Profitable day!' : totalPnl < -100 ? '⚠️ Rough day — review your settings' : '📝 Break-even day'}`;

    await sendTelegramNotification(summary);
    console.log('📊 Daily summary sent via TG');
  } catch(e) { console.error('Daily summary error:', e.message); }
}

// Schedule daily summary at 23:55 UTC
function scheduleDailySummary() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(23, 55, 0, 0);
  if (nextRun <= now) nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  const ms = nextRun - now;
  setTimeout(() => {
    sendDailyTradeSummary();
    setInterval(sendDailyTradeSummary, 24 * 60 * 60 * 1000);
  }, ms);
  console.log(`📊 Daily summary scheduled — next in ${Math.round(ms/3600000)}h`);
}

// ─── SMART PRICE ALERTS ────────────────────────────────────────────────────
const PRICE_ALERTS = [];

async function checkSmartPriceAlerts() {
  if (!PRICE_ALERTS.length) return;
  for (let i = PRICE_ALERTS.length - 1; i >= 0; i--) {
    const alert = PRICE_ALERTS[i];
    try {
      const priceStr = await getCryptoPrice(alert.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (!priceMatch) continue;
      const currentPrice = parseFloat(priceMatch[1].replace(',', ''));

      const triggered = (alert.direction === 'above' && currentPrice >= alert.price) ||
                       (alert.direction === 'below' && currentPrice <= alert.price);

      if (triggered) {
        // Get AI context
        const rsi = await getCandles(alert.coin, '1h', 20).then(c => c ? calcRSI(c, 14) : null).catch(() => null);
        const fg = global._cachedFearGreed || 50;
        const regime = _cachedMarketRegime;

        const context = `RSI: ${rsi?.toFixed(0) || '?'} | FG: ${fg} | Regime: ${regime?.regime || '?'}`;
        const suggestion = rsi < 30 ? '📈 Oversold — potential long' :
                          rsi > 70 ? '📉 Overbought — potential short' :
                          'Neutral zone — wait for confirmation';

        await sendTelegramNotification(
          `🎯 PRICE ALERT: ${alert.coin}
` +
          `Price hit $${currentPrice.toLocaleString()} (target: $${alert.price.toLocaleString()})

` +
          `Market Context:
${context}
${suggestion}

` +
          `Set by you at: ${new Date(alert.setAt).toLocaleTimeString()}`
        );

        PRICE_ALERTS.splice(i, 1); // Remove triggered alert
        console.log(`🎯 Smart price alert triggered: ${alert.coin} at $${currentPrice}`);
      }
    } catch(e) {}
  }
}

ipcMain.on('set-price-alert', (e, { coin, price, direction }) => {
  PRICE_ALERTS.push({ coin, price, direction, setAt: Date.now() });
  console.log(`🎯 Price alert set: ${coin} ${direction} $${price}`);
});

ipcMain.handle('get-price-alerts', () => PRICE_ALERTS);
ipcMain.on('remove-price-alert', (e, idx) => PRICE_ALERTS.splice(idx, 1));

// ─── DCA AUTOMATION ────────────────────────────────────────────────────────
const DCA_FILE = path.join(DATA_DIR, 'dca-settings.json');
function loadDCASettings() { return loadJSON(DCA_FILE, { plans: [] }); }
function saveDCASettings(d) { saveJSON(DCA_FILE, d); }

async function checkDCAPlans() {
  const dca = loadDCASettings();
  if (!dca.plans?.length) return;

  const now = Date.now();
  for (const plan of dca.plans) {
    if (!plan.enabled) continue;
    if (!plan.nextRun || now >= plan.nextRun) {
      try {
        // Execute DCA buy
        const priceStr = await getCryptoPrice(plan.coin.toLowerCase());
        const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
        if (!priceMatch) continue;
        const price = parseFloat(priceMatch[1].replace(',', ''));

        console.log(`💰 DCA: Buying $${plan.amount} ${plan.coin} at $${price}`);

        // Open as spot trade or paper trade
        const dcaSignal = {
          coin: plan.coin,
          direction: 'long',
          entry: price,
          target: price * 1.1, // 10% TP
          stopLoss: price * 0.9, // 10% SL
          confidence: 60,
          leverage: 1,
          size: plan.amount,
          caller: 'DCA Bot',
          groupName: `DCA | $${plan.amount} every ${plan.interval}`,
          isDCA: true
        };

        await openPaperTrade(dcaSignal);
        await sendTelegramNotification(`💰 DCA Executed
${plan.coin}: Bought $${plan.amount} at $${price.toLocaleString()}
Next: ${new Date(plan.nextRun + getIntervalMs(plan.interval)).toLocaleDateString()}`);

        // Set next run
        plan.nextRun = now + getIntervalMs(plan.interval);
        plan.lastRun = now;
        plan.totalInvested = (plan.totalInvested || 0) + plan.amount;
      } catch(e) { console.error('DCA error:', e.message); }
    }
  }
  saveDCASettings(dca);
}

function getIntervalMs(interval) {
  const map = { daily: 86400000, weekly: 604800000, biweekly: 1209600000, monthly: 2592000000 };
  return map[interval] || 604800000;
}

ipcMain.handle('get-dca-plans', () => loadDCASettings());
ipcMain.on('save-dca-plan', (e, plan) => {
  const dca = loadDCASettings();
  const idx = dca.plans.findIndex(p => p.id === plan.id);
  if (idx >= 0) dca.plans[idx] = plan;
  else dca.plans.push({ ...plan, id: Date.now(), nextRun: Date.now() });
  saveDCASettings(dca);
});
ipcMain.on('delete-dca-plan', (e, id) => {
  const dca = loadDCASettings();
  dca.plans = dca.plans.filter(p => p.id !== id);
  saveDCASettings(dca);
});

// IPC handlers
ipcMain.handle('get-signal-quality', (e, signal, callerStats) => scoreSignalQuality(signal, callerStats, {}));
ipcMain.on('pause-trading', (e, minutes) => {
  _tradingPausedUntil = Date.now() + minutes * 60 * 1000;
  console.log(`⏸️ Trading paused for ${minutes} min`);
});
ipcMain.on('resume-trading', () => { _tradingPausedUntil = 0; });
ipcMain.handle('is-trading-paused', () => isTradingPaused());


// ─── DAILY TRADE BOT ──────────────────────────────────────────────────────────

// Daily RSI signal storage
const DAILY_SIGNALS_FILE = path.join(DATA_DIR, 'daily-signals.json');
function loadDailySignals() { return loadJSON(DAILY_SIGNALS_FILE, { signals: {}, lastUpdated: null, date: null }); }
function saveDailySignals(d) { saveJSON(DAILY_SIGNALS_FILE, d); }

// Calculate daily RSI from daily candles
async function getDailyRSI(coin, period = 14) {
  try {
    const candles = await getCandles(coin, '1d', period + 5);
    if (!candles || candles.length < period) return null;
    const rsi = calcRSI(candles, period);
    return rsi;
  } catch(e) {
    console.error(`Daily RSI error for ${coin}:`, e.message?.slice(0, 50));
    return null;
  }
}

// Get signal tier based on RSI and user settings
function getDailySignalTier(rsi, settings) {
  if (rsi === null) return 'unknown';
  const powerBuy = settings.dailyPowerBuyRSI || 20;
  const buy = settings.dailyBuyRSI || 30;
  const sell = settings.dailySellRSI || 70;
  const powerSell = settings.dailyPowerSellRSI || 80;

  if (rsi <= powerBuy) return 'Power Buy';
  if (rsi <= buy) return 'Buy';
  if (rsi >= powerSell) return 'Power Sell';
  if (rsi >= sell) return 'Sell';
  return 'Neutral';
}

// Get direction from signal tier
function getSignalDirection(tier) {
  if (tier === 'Power Buy' || tier === 'Buy') return 'long';
  if (tier === 'Power Sell' || tier === 'Sell') return 'short';
  return null;
}

// Main daily trade bot scanner
async function runDailyTradeBot() {
  const settings = loadSettings();
  if (!settings.dailyTradeEnabled) return;
  if (!settings.autoPaperTrade) return;

  console.log('📅 Running Daily Trade Bot...');

  const coins = settings.tradingCoins || ['BTC', 'ETH', 'SOL', 'DOGE', 'BNB'];
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

// Schedule daily bot at 00:05 UTC
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

// IPC handlers for daily trade bot
ipcMain.handle('get-daily-signals', () => loadDailySignals());

ipcMain.on('trigger-daily-scan', () => {
  console.log('📅 Daily trade scan triggered manually');
  runDailyTradeBot();
});

ipcMain.handle('trigger-daily-scan-wait', async () => {
  console.log('📅 Daily trade scan triggered (waiting)');
  await runDailyTradeBot();
  return loadDailySignals();
});

ipcMain.on('set-daily-setting', (e, key, val) => {
  const s = loadSettings();
  s[key] = val;
  saveJSON(SETTINGS_FILE, s);
});


function startPaperTradingMonitor() {
  if (paperTradeInterval) clearInterval(paperTradeInterval);
  paperTradeInterval = setInterval(async () => {
    await checkPaperTrades();
    await runMarketScan();
    await checkSmartProfitAlerts();
    await checkScalpExpiry();
    await checkDCAPlans();
    await checkSmartPriceAlerts(); // Auto-close expired scalps
  }, 15 * 60 * 1000); // Every 15 minutes
  console.log('📊 Paper trading monitor started');
}

// IPC handlers for paper trading
ipcMain.on('set-max-scalps', (e, val) => {
  const s = loadSettings();
  s.maxScalpTrades = val;
  saveJSON(SETTINGS_FILE, s);
});

ipcMain.on('trigger-scalp-scan', () => {
  console.log('⚡ Scalp scan triggered manually');
  runIndependentScalpScan();
});

ipcMain.on('restart-scanner', () => {
  startIndependentScanner();
  console.log('🔄 Scanner restarted with new interval');
});

ipcMain.on('start-independent-scanner', () => {
  const settings = loadSettings();
  settings.independentScanner = true;
  saveJSON(SETTINGS_FILE, settings);
  runIndependentScan(); // Run immediately when toggled on
});

ipcMain.handle('get-auto-threshold', async () => {
  try {
    const pd = loadPaperTrades();
    const winRate = pd.stats.wins + pd.stats.losses > 0
      ? Math.round(pd.stats.wins / (pd.stats.wins + pd.stats.losses) * 100)
      : 50;
    const fearGreed = await getFearGreed().catch(() => '50');
    const fgMatch = fearGreed?.match(/\d+/);
    const fg = fgMatch ? parseInt(fgMatch[0]) : 50;

    // Auto threshold logic:
    // High fear + low win rate = be more selective (higher threshold)
    // Low fear + high win rate = be more aggressive (lower threshold)
    let threshold = 50; // base
    if (fg < 25) threshold += 20; // extreme fear — be selective
    else if (fg > 75) threshold -= 15; // extreme greed — be aggressive
    if (winRate < 40) threshold += 15; // losing — be more selective
    else if (winRate > 65) threshold -= 10; // winning — be more aggressive
    threshold = Math.max(20, Math.min(80, threshold));

    console.log(`🎯 Auto threshold calculated: ${threshold}% (FG: ${fg}, WR: ${winRate}%)`);
    return threshold;
  } catch(e) { return 50; }
});

ipcMain.handle('close-paper-trade', async (e, tradeId, currentPrice) => {
  return closePaperTrade(tradeId, currentPrice, 'manual close');
});

ipcMain.handle('get-binance-status', async () => {
  if (!isBinanceTestnet()) return { connected: false };
  try {
    const balance = await getBinanceBalance();
    const positions = await getBinancePositions();
    return { 
      connected: true, 
      balance: balance?.toFixed(2) || '0',
      openPositions: positions.length
    };
  } catch(e) { return { connected: false, error: e.message }; }
});

ipcMain.handle('get-paper-trades', async () => {
  return loadPaperTrades();
});

ipcMain.handle('reset-paper-trades', async () => {
  savePaperTrades({ balance: PAPER_BALANCE, trades: [], stats: { wins: 0, losses: 0, totalPnl: 0 } });
  return true;
});

ipcMain.handle('get-paper-stats', async () => {
  // If Binance testnet configured — try to read from there with timeout
  if (isBinanceTestnet()) {
    try {
      const binancePromise = Promise.all([
        getBinancePositions(),
        binanceTestnetRequest('GET', '/fapi/v2/account', {})
      ]);
      
      // 4 second timeout — if Binance slow, fall back to local
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Binance timeout')), 4000)
      );
      
      const [positions, account] = await Promise.race([binancePromise, timeoutPromise]);

      const balance = parseFloat(account?.totalWalletBalance || 0);
      const unrealizedPnl = parseFloat(account?.totalUnrealizedProfit || 0);
      const totalPnl = balance - 100000; // vs starting balance

      // Get trade history from our local JSON for win/loss stats
      const pd = loadPaperTrades();
      const closed = pd.trades.filter(t => t.status !== 'open');
      const winRate = closed.length ? Math.round(pd.stats.wins / closed.length * 100) : 0;

      // Format open positions from Binance
      const openTrades = await Promise.all(positions.map(async p => {
        const coin = p.symbol.replace('USDT', '');
        const direction = parseFloat(p.positionAmt) > 0 ? 'long' : 'short';
        const entryPrice = parseFloat(p.entryPrice);
        const currentPrice = parseFloat(p.markPrice);
        const leverage = parseInt(p.leverage);
        const unrealized = parseFloat(p.unRealizedProfit);
        const size = Math.abs(parseFloat(p.positionAmt)) * entryPrice / leverage;
        const priceDiff = direction === 'long' ? currentPrice - entryPrice : entryPrice - currentPrice;
        const pnlPct = (priceDiff / entryPrice * leverage * 100);

        // Find matching local trade for extra info
        const localTrade = pd.trades.find(t => 
          t.status === 'open' && t.coin === coin && t.direction === direction
        );

        return {
          id: p.symbol + Date.now(),
          coin,
          direction,
          entry: entryPrice,
          currentPrice,
          target: localTrade?.target || null,
          stopLoss: localTrade?.stopLoss || null,
          leverage,
          size,
          unrealizedPnl: parseFloat(unrealized.toFixed(2)),
          unrealizedPct: parseFloat(pnlPct.toFixed(2)),
          liquidationPrice: parseFloat(p.liquidationPrice),
          confidence: localTrade?.confidence || 0,
          caller: localTrade?.caller || 'Binance Testnet',
          groupName: localTrade?.groupName || '',
          openTime: localTrade?.openTime || Date.now(),
          status: 'open',
          source: 'binance'
        };
      }));

      return {
        balance: parseFloat(balance.toFixed(2)),
        startBalance: 100000,
        totalPnl: parseFloat(totalPnl.toFixed(2)),
        unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
        wins: pd.stats.wins,
        losses: pd.stats.losses,
        winRate,
        totalTrades: closed.length,
        openTrades: openTrades.length,
        trades: [...openTrades, ...closed.slice(-20).reverse()],
        leverage: loadSettings().paperLeverage || 1,
        tradeSize: loadSettings().paperTradeSize || null,
        source: 'binance'
      };
    } catch(e) {
      console.error('Binance stats error:', e.message);
    }
  }

  // Fallback to local paper trading
  const pd = loadPaperTrades();
  const settings = loadSettings();
  const closed = pd.trades.filter(t => t.status !== 'open');
  const open = pd.trades.filter(t => t.status === 'open');
  const winRate = closed.length ? Math.round(pd.stats.wins / closed.length * 100) : 0;

  for (const trade of open) {
    try {
      const priceStr = await getCryptoPrice(trade.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (priceMatch) {
        const currentPrice = parseFloat(priceMatch[1].replace(',', ''));
        
        // Sanity check — reject prices that differ too much from entry
        const diffPct = Math.abs(currentPrice - trade.entry) / trade.entry * 100;
        const maxDiff = trade.entry < 0.001 ? 90 : 50;
        if (diffPct > maxDiff) {
          console.log(`⚠️ P&L sanity skip ${trade.coin}: ${diffPct.toFixed(0)}% price diff`);
          trade.currentPrice = trade.entry; // Show entry as current
          trade.unrealizedPnl = 0;
          trade.unrealizedPct = 0;
          continue;
        }
        
        const leverage = trade.leverage || 1;
        const priceDiff = trade.direction === 'long'
          ? currentPrice - trade.entry
          : trade.entry - currentPrice;
        const pnlPct = priceDiff / trade.entry;
        const unrealizedPnl = trade.size * pnlPct * leverage;
        trade.currentPrice = currentPrice;
        trade.unrealizedPnl = parseFloat(Math.max(unrealizedPnl, -trade.size).toFixed(2));
        trade.unrealizedPct = parseFloat((pnlPct * leverage * 100).toFixed(2));
      }
    } catch(e) {}
  }

  return {
    balance: pd.balance,
    startBalance: 100000,
    totalPnl: pd.stats.totalPnl,
    wins: pd.stats.wins,
    losses: pd.stats.losses,
    winRate,
    totalTrades: closed.length,
    openTrades: open.length,
    trades: [...open, ...closed.slice(-20).reverse()],
    leverage: settings.paperLeverage || 1,
    tradeSize: settings.paperTradeSize || null,
    source: 'local'
  };
});

// Extract trading signal from image using Claude Vision
async function extractSignalFromImage(imageBuffer, sender, groupName) {
  try {
    const settings = loadSettings();
    if (!settings.chartAnalysis) return null;

    const base64Image = imageBuffer.toString('base64');
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image }
          },
          {
            type: 'text',
            text: `Analyze this crypto chart image shared by @${sender} in ${groupName}. Is this a trading signal or chart analysis? 
If yes, extract: coin, direction (long/short), key price levels.
Respond ONLY with JSON:
{"isSignal":true,"coin":"BTC","direction":"long","entry":104000,"target":108000,"stopLoss":102000,"confidence":65,"chartNote":"brief description"}
If not a trading chart: {"isSignal":false}`
          }
        ]
      }]
    });
    const text = res.content[0].text.trim().replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) { 
    console.error('Image analysis error:', e.message);
    return null; 
  }
}

// ─── TELEGRAM INTEGRATION ──────────────────────────────────────────────────
const TELEGRAM_SESSION_FILE = path.join(DATA_DIR, 'telegram-session.json');
const TELEGRAM_DATA_FILE    = path.join(DATA_DIR, 'telegram-data.json');

function loadTelegramData() {
  return loadJSON(TELEGRAM_DATA_FILE, {
    connected: false,
    sessionString: null,
    monitoredGroups: [],
    trackedCallers: [],
    signals: [],
    callerStats: {}
  });
}
function saveTelegramData(d) { saveJSON(TELEGRAM_DATA_FILE, d); }

let tgClient = null;

// Connect to Telegram using MTProto
async function connectTelegram(phoneNumber, code = null, password = null) {
  try {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const td = loadTelegramData();
    const sessionString = td.sessionString || '';
    const session = new StringSession(sessionString);

    tgClient = new TelegramClient(session, parseInt(process.env.TELEGRAM_API_ID), process.env.TELEGRAM_API_HASH, {
      connectionRetries: 5,
    });

    await tgClient.start({
      phoneNumber: async () => phoneNumber,
      password: async () => password || '',
      phoneCode: async () => {
        // Send code to renderer to ask user
        if (mainWindow) mainWindow.webContents.send('telegram-needs-code');
        return new Promise((resolve) => {
          ipcMain.once('telegram-code', (e, c) => resolve(c));
        });
      },
      onError: (err) => console.error('Telegram error:', err),
    });

    // Save session
    const newSession = tgClient.session.save();
    td.sessionString = newSession;
    td.connected = true;
    saveTelegramData(td);
    console.log('✅ Telegram connected');
    startTelegramMonitor();
    setTimeout(readPastMessages, 2000);
    return { success: true };
  } catch(e) {
    console.error('Telegram connect error:', e.message);
    return { success: false, error: e.message };
  }
}

// Get all groups user is in
async function getTelegramGroups() {
  if (!tgClient) { console.log('TG: no client'); return []; }
  try {
    await tgClient.connect();
    const dialogs = await tgClient.getDialogs({ limit: 100 });
    console.log('TG: found', dialogs.length, 'dialogs');
    const groups = dialogs
      .filter(d => d.isGroup || d.isChannel || d.entity?.className === 'Chat' || d.entity?.className === 'Channel')
      .map(d => ({ 
        id: d.id?.toString() || d.entity?.id?.toString(), 
        name: d.title || d.entity?.title || 'Unknown',
        type: d.isChannel ? 'channel' : 'group' 
      }))
      .filter(g => g.name && g.id);
    console.log('TG: filtered groups:', groups.length);
    return groups;
  } catch(e) { 
    console.error('TG getGroups error:', e.message); 
    return []; 
  }
}

// Read recent messages from a group (including images)
async function readGroupMessages(groupId, limit = 20) {
  if (!tgClient) return [];
  try {
    const messages = await tgClient.getMessages(groupId, { limit });
    const result = [];
    for (const m of messages) {
      const item = {
        id: m.id,
        text: m.message,
        sender: m.senderId?.toString(),
        timestamp: m.date * 1000,
        hasImage: false,
        imageBuffer: null
      };
      // Check for photo
      if (m.photo) {
        // Skip if already processed this message
        if (processedMessageIds.has(m.id)) {
          item.hasImage = true;
          item.imageBuffer = null; // Already analyzed
        } else {
          try {
            const buffer = await tgClient.downloadMedia(m.photo, { 
              progressCallback: () => {}
            });
            if (buffer && buffer.length > 0) {
              item.hasImage = true;
              item.imageBuffer = Buffer.from(buffer);
              console.log(`🖼️ Image downloaded: ${item.imageBuffer.length} bytes from @${item.sender}`);
            }
          } catch(e) { 
            try {
              const bytes = await tgClient.downloadFile(
                new (require('telegram').Api.InputPhotoFileLocation)({
                  id: m.photo.id,
                  accessHash: m.photo.accessHash,
                  fileReference: m.photo.fileReference,
                  thumbSize: 'y'
                }),
                { dcId: m.photo.dcId, fileSize: 1024 * 1024 }
              );
              if (bytes) {
                item.hasImage = true;
                item.imageBuffer = Buffer.from(bytes);
              }
            } catch(e2) {
              console.log(`🖼️ Image skip: ${e.message}`);
            }
          }
        }
        processedMessageIds.add(m.id);
      }
      if (item.text || item.hasImage) result.push(item);
    }
    return result;
  } catch(e) { return []; }
}

// Extract trading signal from message using Claude
async function extractTradingSignal(message, caller) {
  if (!message || message.length < 5) return { isSignal: false };
  try {
    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Analyze this Telegram crypto message. Is it a trading signal or recommendation?
Examples of signals: "long BTC", "buy ETH here", "hold to 77K", "short SOL", "BTC going to 80k", "sell now", "ape in"
Examples of non-signals: "gm", "nice", "thanks", "what do you think", general news

If it IS a signal return JSON (use null for unknown values):
{"isSignal":true,"coin":"BTC","direction":"long","entry":null,"target":77000,"stopLoss":null,"confidence":60}

If NOT a signal return: {"isSignal":false}

Message: "${message.slice(0, 300)}"`
      }]
    });
    const text = res.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    // Fill in missing values with estimates if we have a direction and coin
    if (result.isSignal && result.coin) {
      result.entry = result.entry || null;
      result.target = result.target || null;
      result.stopLoss = result.stopLoss || null;
    }
    return result;
  } catch(e) { return { isSignal: false }; }
}

// Update caller stats when trade closes
function updateCallerStats(caller, won) {
  const td = loadTelegramData();
  if (!td.callerStats[caller]) {
    td.callerStats[caller] = { wins: 0, losses: 0, total: 0 };
  }
  td.callerStats[caller].total++;
  if (won) td.callerStats[caller].wins++;
  else td.callerStats[caller].losses++;
  td.callerStats[caller].winRate = Math.round(td.callerStats[caller].wins / td.callerStats[caller].total * 100);
  saveTelegramData(td);
}

// Queue for intel events before dashboard is ready
const intelQueue = [];
function sendIntelEvent(item) {
  if (dashboardWindow?.webContents && !dashboardWindow.isDestroyed()) {
    // Send queued items first
    while (intelQueue.length > 0) {
      dashboardWindow.webContents.send('intel-event', intelQueue.shift());
    }
    dashboardWindow.webContents.send('intel-event', item);
  } else {
    // Queue it — will be flushed when dashboard opens
    intelQueue.push(item);
    if (intelQueue.length > 200) intelQueue.shift(); // Keep max 200
  }
}

// Cache of processed message IDs to prevent re-downloading images
const processedMessageIds = new Set();

// Read past messages from monitored groups on startup
async function readPastMessages() {
  const td = loadTelegramData();
  if (!td.connected || !td.monitoredGroups.length) return;
  console.log('📖 Reading past messages from monitored groups...');
  
  for (const group of td.monitoredGroups) {
    try {
      const messages = await readGroupMessages(group.id, 50); // Last 50 messages
      let signalCount = 0;
      
      for (const msg of messages.reverse()) { // oldest first
        if (!msg.text || msg.text.length < 10) continue;
        
        // Check if already processed in the last hour only
        const td2 = loadTelegramData();
        const alreadyProcessed = td2.signals.some(s => s.messageId === msg.id && Date.now() - s.timestamp < 3600000);
        if (alreadyProcessed) continue;
        
        // Try text signal first, then image if available
        let signal = await extractTradingSignal(msg.text || '', msg.sender);
        if (!signal.isSignal && msg.hasImage && msg.imageBuffer) {
          const imgSignal = await extractSignalFromImage(msg.imageBuffer, msg.sender, group.name);
          if (imgSignal?.isSignal) { signal = imgSignal; console.log(`🖼️ Image signal found from @${msg.sender}`); }
        }
        
        if (signal.isSignal) {
          signal.caller = msg.sender;
          signal.messageId = msg.id;
          signal.groupId = group.id;
          signal.groupName = group.name;
          signal.timestamp = msg.timestamp;
          signal.status = 'open';
          td2.signals.push(signal);
          saveTelegramData(td2);
          signalCount++;
          sendIntelEvent({
            type: 'signal',
            source: `@${msg.sender} in ${group.name}`,
            body: msg.text?.slice(0, 150) || '📊 Chart image signal',
            note: `${signal.direction?.toUpperCase()} ${signal.coin} | ${signal.confidence}% confidence`,
            action: 'Signal found',
            notify: true // Notify even for recent past messages
          });
        } else if (msg.hasImage) {
          sendIntelEvent({ type: 'note', source: `@${msg.sender} in ${group.name}`, body: '📊 Chart image shared', notify: false });
        } else if (msg.text?.length > 20) {
          sendIntelEvent({ type: 'note', source: `@${msg.sender} in ${group.name}`, body: msg.text?.slice(0, 100), notify: false });
        }
      }
      console.log(`📖 Read ${messages.length} past messages from ${group.name} — found ${signalCount} signals`);
    } catch(e) { console.error(`Past message read error for ${group.name}:`, e.message); }
  }
}

// Monitor groups for signals
let tgMonitorInterval = null;
async function startTelegramMonitor() {
  if (tgMonitorInterval) clearInterval(tgMonitorInterval);
  const td = loadTelegramData();
  if (!td.connected || !td.monitoredGroups.length) return;

  tgMonitorInterval = setInterval(async () => {
    for (const group of td.monitoredGroups) {
      const messages = await readGroupMessages(group.id, 20);
      for (const msg of messages) {
        // Skip already processed messages (within last hour)
        const td2 = loadTelegramData();
        const alreadyDone = td2.signals.some(s => s.messageId === msg.id && Date.now() - s.timestamp < 3600000);
        if (alreadyDone) continue;

        // Check if caller is tracked
        const trackedCallers = td2.trackedCallers;
        if (trackedCallers.length > 0 && !trackedCallers.includes(msg.sender)) continue;

        const signal = await extractTradingSignal(msg.text, msg.sender);
        if (signal.isSignal) {
          signal.caller = msg.sender;
          signal.messageId = msg.id;
          signal.groupId = group.id;
          signal.groupName = group.name;
          signal.timestamp = msg.timestamp;
          signal.status = 'open';
          td2.signals.push(signal);
          saveTelegramData(td2);

          // Alert user
          if (mainWindow) {
            mainWindow.webContents.send('telegram-signal', signal);
            sendIntelEvent({
              type: 'signal',
              source: `@${msg.sender} in ${group.name}`,
              body: msg.text?.slice(0, 150),
              note: `${signal.direction?.toUpperCase()} ${signal.coin} | Entry: $${signal.entry} | ${signal.confidence}% confidence`,
              action: 'Signal logged',
              notify: true
            });
            console.log(`📡 Signal from ${msg.sender}: ${signal.direction} ${signal.coin} at ${signal.entry}`);
          }
        } else if (msg.text?.length > 20 && mainWindow) {
          sendIntelEvent({
            type: 'note',
            source: `@${msg.sender} in ${group.name}`,
            body: msg.text?.slice(0, 100),
            notify: false
          });
        }
      }
    }
  }, 60000); // Check every minute
}

// IPC handlers for Telegram
ipcMain.handle('telegram-connect', async (e, phone) => {
  return await connectTelegram(phone);
});

ipcMain.on('telegram-code', (e, code) => {
  // Handled in connectTelegram promise
});

ipcMain.handle('telegram-get-groups', async () => {
  return await getTelegramGroups();
});

ipcMain.handle('telegram-add-group', async (e, group) => {
  const td = loadTelegramData();
  if (!td.monitoredGroups.some(g => g.id === group.id)) {
    td.monitoredGroups.push(group);
    saveTelegramData(td);
    startTelegramMonitor();
  }
  return true;
});

ipcMain.handle('telegram-remove-group', async (e, groupId) => {
  const td = loadTelegramData();
  td.monitoredGroups = td.monitoredGroups.filter(g => g.id !== groupId);
  saveTelegramData(td);
  return true;
});

ipcMain.handle('telegram-add-caller', async (e, caller) => {
  const td = loadTelegramData();
  if (!td.trackedCallers.includes(caller)) td.trackedCallers.push(caller);
  saveTelegramData(td);
  return true;
});

ipcMain.handle('telegram-get-stats', async () => {
  const td = loadTelegramData();
  return { connected: td.connected, groups: td.monitoredGroups, callers: td.trackedCallers, stats: td.callerStats, signals: td.signals.slice(-20) };
});

ipcMain.handle('telegram-disconnect', async () => {
  if (tgClient) { try { await tgClient.disconnect(); } catch(e) {} tgClient = null; }
  if (tgMonitorInterval) { clearInterval(tgMonitorInterval); tgMonitorInterval = null; }
  const td = loadTelegramData();
  td.connected = false; td.sessionString = null;
  saveTelegramData(td);
  return true;
});

ipcMain.handle('telegram-status', async () => {
  const td = loadTelegramData();
  return td.connected;
});

// ─── APP INIT ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  ensureDataDir();
  createWaifuWindow();
  startAlertMonitor();
  startPaperTradingMonitor();
  scheduleDailyTradeBot();
  scheduleDailySummary();
  // Check scalps every 5 minutes
  setInterval(checkScalpExpiry, 5 * 60 * 1000);
  // Independent scalp scanner every 5 minutes
  setInterval(runIndependentScalpScan, 5 * 60 * 1000);
  // Run immediately
  setTimeout(runIndependentScalpScan, 10000);
  startIndependentScanner();
  startTelegramBot(); // Started once here only
  startNewFeatures(); // Whale alerts, morning briefing

  // Auto reconnect Telegram if previously connected
  const td = loadTelegramData();
  if (td.connected && td.sessionString) {
    setTimeout(async () => {
      try {
        const { TelegramClient } = require('telegram');
        const { StringSession } = require('telegram/sessions');
        const session = new StringSession(td.sessionString);
        tgClient = new TelegramClient(session, parseInt(process.env.TELEGRAM_API_ID), process.env.TELEGRAM_API_HASH, { connectionRetries: 3 });
        await tgClient.connect();
        console.log('✅ Telegram reconnected');
        startTelegramMonitor();
        setTimeout(readPastMessages, 3000); // Read past messages after connect
      } catch(e) { console.error('Telegram reconnect failed:', e.message); }
    }, 3000);
  }

  const mem = loadMemory();
  setTimeout(async () => {
    const name = mem.name;
    const greetings = name
      ? [`Hey ${name}!`, `${name}! What's up?`, `Hey ${name}, you're back!`, `What's good ${name}?`]
      : ["Hey! I'm Asuka. What's your name?"];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const audio = await getVoiceAudio(greeting);
    if (mainWindow) mainWindow.webContents.send('play-audio', { audio, text: greeting });
  }, 2000);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
