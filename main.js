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
    if (!coin) return null;
    const price  = coin.usd >= 1 ? coin.usd.toLocaleString() : coin.usd.toFixed(8);
    const change = coin.usd_24h_change?.toFixed(2);
    const dir    = change > 0 ? 'up' : 'down';
    return `${coinId} is at $${price}, ${dir} ${Math.abs(change)}% in 24h ${change > 0 ? '📈' : '📉'}`;
  } catch(e) {
    // Fallback to Binance for BTC/ETH/BNB
    try {
      const binanceMap = { bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', solana: 'SOLUSDT', binancecoin: 'BNBUSDT' };
      const symbol = binanceMap[coinId];
      if (symbol) {
        const res = await fetchT(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
        const data = await res.json();
        const price = parseFloat(data.lastPrice);
        const change = parseFloat(data.priceChangePercent).toFixed(2);
        return `${coinId} is at $${price.toLocaleString()}, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% in 24h ${change > 0 ? '📈' : '📉'}`;
      }
    } catch(e2) {}
    return null;
  }
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

  // ── 1. CASUAL FILTER — instant, no API ──────────────────────────────────
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

ipcMain.handle('process-voice-input-text', async (e, text) => {
  try {
    console.log('💬 Text:', text);
    const reply = await routeCommand(text);
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
  if (!tgClient) return;
  try {
    const settings = loadSettings();
    const contact = settings.tgNotifyContact || 'me';
    await tgClient.sendMessage(contact, { message });
    console.log('📱 TG notification sent:', message.slice(0, 50));
  } catch(e) { console.error('TG notify error:', e.message); }
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
    // Collect market data for specific coin
    const [coinPrice, funding, fearGreed, dominance, news] = await Promise.all([
      getCryptoPrice(scanCoin.toLowerCase()).catch(() => null),
      getFundingRate(scanCoin).catch(() => null),
      getFearGreed().catch(() => null),
      getDominance().catch(() => null),
      getCryptoNews().catch(() => null)
    ]);

    const pd = loadPaperTrades();
    const recentTrades = pd.trades.filter(t => t.coin === scanCoin).slice(-5);
    const winRate = pd.stats.wins + pd.stats.losses > 0
      ? Math.round(pd.stats.wins / (pd.stats.wins + pd.stats.losses) * 100)
      : 0;

    const lessonsContext = buildLessonsContext();

    // Ask Claude to analyze this specific coin
    const prompt = `You are an expert crypto trader. Analyze this market data for ${scanCoin} and decide if there is a trading opportunity.

MARKET DATA:
- ${scanCoin} Price: ${coinPrice}
- ${scanCoin} Funding Rate: ${funding}
- Fear & Greed Index: ${fearGreed}
- BTC Dominance: ${dominance}
- Latest News: ${news?.slice(0, 200)}

RECENT ${scanCoin} PAPER TRADES:
${recentTrades.length ? recentTrades.map(t => `${t.direction} at $${t.entry} → ${t.status} P&L: $${t.pnl}`).join('\n') : 'No recent trades'}

Current overall win rate: ${winRate}%

${lessonsContext}

Should we open a paper trade on ${scanCoin} right now?

Respond ONLY with JSON:
{
  "shouldTrade": true/false,
  "coin": "${scanCoin}",
  "direction": "long" or "short",
  "entry": current price number,
  "target": target price number,
  "stopLoss": stop loss price number,
  "confidence": 0-100,
  "reason": "brief reason under 20 words"
}

Suggest a trade if confidence is above 20%. Be willing to trade even with moderate signals.`;

    const res = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = res.content[0].text.trim();
    const clean = text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);

    console.log(`🤖 Independent scan result: shouldTrade=${analysis.shouldTrade}, confidence=${analysis.confidence}%, reason="${analysis.reason}"`);

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
      
      // Auto threshold mode
      if (settings2.autoThreshold) {
        threshold = await ipcMain.handle('get-auto-threshold') || 50;
      }
      
      if (analysis.confidence < threshold) {
        console.log(`⏭️ Confidence ${analysis.confidence}% below threshold ${threshold}% — skipping`);
        return;
      }
      // Check not already in this coin
      // Check if already have open trade on same coin
      const existingTrade = pd.trades.find(t => t.status === 'open' && t.coin === analysis.coin);
      if (existingTrade) {
        if (analysis.confidence > existingTrade.confidence + 15) {
          // New confidence is significantly higher — close old trade and open new one
          console.log(`🔄 Higher confidence signal for ${analysis.coin} (${analysis.confidence}% vs ${existingTrade.confidence}%) — replacing trade`);
          closePaperTrade(existingTrade.id, analysis.entry, 'replaced by higher confidence signal');
        } else {
          console.log(`⏭️ Already have ${analysis.coin} trade at ${existingTrade.confidence}% — new signal at ${analysis.confidence}% not high enough to replace`);
          return;
        }
      }

      const signal = {
        coin: analysis.coin,
        direction: analysis.direction,
        entry: analysis.entry,
        target: analysis.target,
        stopLoss: analysis.stopLoss,
        confidence: analysis.confidence,
        caller: 'Asuka (Independent)',
        groupName: 'Self Analysis',
        messageId: `scan_${Date.now()}`,
        timestamp: Date.now()
      };

      openPaperTrade(signal);

      // Notify user
      if (mainWindow) {
        mainWindow.webContents.send('independent-signal', {
          ...signal,
          reason: analysis.reason
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
  independentScanInterval = setInterval(runIndependentScan, 30 * 60 * 1000); // Every 30 minutes
  console.log('🔍 Independent market scanner started');
  // Run immediately only if enabled in settings
  const settings = loadSettings();
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
ipcMain.handle('get-trading-lessons', async () => {
  return loadTradingLessons();
});

// ─── PAPER TRADING ENGINE ─────────────────────────────────────────────────
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
function openPaperTrade(signal) {
  const pd = loadPaperTrades();
  const settings = loadSettings();
  const leverage = settings.paperLeverage || 1;
  // Use custom size if set, otherwise 5% of balance
  const size = settings.paperTradeSize || (pd.balance * 0.05);
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
    pnl: 0
  };
  pd.trades.push(trade);
  savePaperTrades(pd);
  console.log(`📝 Paper trade opened: ${signal.direction} ${signal.coin} at $${signal.entry} ${leverage}x | Liq: $${liquidationPrice.toFixed(2)}`);

  // Send TG notification
  const msg = `📝 Paper Trade Opened\n${signal.direction?.toUpperCase()} ${signal.coin} ${leverage}x\nEntry: $${signal.entry}\nTarget: $${signal.target}\nSL: $${signal.stopLoss}\nLiq: $${liquidationPrice.toFixed(2)}\nSize: $${size}\nConfidence: ${signal.confidence}%\nSource: ${signal.caller}`;
  sendTelegramNotification(msg);

  // Notify renderer
  if (mainWindow) mainWindow.webContents.send('trade-opened', trade);

  return trade;
}

// Close a paper trade
function closePaperTrade(tradeId, closePrice, reason) {
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

  const pnlStr = `${actualPnl >= 0 ? '+' : ''}$${actualPnl.toFixed(2)} (${(pnlPct * leverage * 100).toFixed(1)}% at ${leverage}x)`;
  console.log(`${actualPnl > 0 ? '✅' : '❌'} Paper trade closed: ${trade.direction} ${trade.coin} — P&L: ${pnlStr} (${reason})`);

  // Learn from this trade
  learnFromTrade(trade, actualPnl, reason).catch(e => console.error('Learn error:', e.message));

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
        if (priceMatch) {
          signal.entry = parseFloat(priceMatch[1].replace(',', ''));
        }
      }
      if (!signal.entry) continue;

      // Set default target and SL if missing (5% target, 2% SL)
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

      const trade = openPaperTrade(signal);
      trade.signalId = signal.messageId;
      // Update in pd
      const pd2 = loadPaperTrades();
      const t = pd2.trades.find(tr => tr.id === trade.id);
      if (t) { t.signalId = signal.messageId; savePaperTrades(pd2); }

      console.log(`📊 TG signal traded: ${signal.direction} ${signal.coin} at $${signal.entry}`);

      if (signal.confidence >= 80) {
        sendIntelEvent({
          type: 'signal',
          source: signal.caller ? `@${signal.caller}` : 'TG Signal',
          body: `${signal.direction?.toUpperCase()} ${signal.coin} at $${signal.entry}`,
          note: `${signal.confidence}% confidence | Target: $${signal.target} | SL: $${signal.stopLoss}`,
          action: 'Paper Trade Opened 🚀',
          notify: true
        });
      }
    } catch(e) { console.error('Signal trade error:', e.message); }
  }
}

// Start paper trading monitor
let paperTradeInterval = null;
function startPaperTradingMonitor() {
  if (paperTradeInterval) clearInterval(paperTradeInterval);
  paperTradeInterval = setInterval(async () => {
    await checkPaperTrades();
    await runMarketScan();
  }, 15 * 60 * 1000); // Every 15 minutes
  console.log('📊 Paper trading monitor started');
}

// IPC handlers for paper trading
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

ipcMain.handle('get-paper-trades', async () => {
  return loadPaperTrades();
});

ipcMain.handle('reset-paper-trades', async () => {
  savePaperTrades({ balance: PAPER_BALANCE, trades: [], stats: { wins: 0, losses: 0, totalPnl: 0 } });
  return true;
});

ipcMain.handle('get-paper-stats', async () => {
  const pd = loadPaperTrades();
  const settings = loadSettings();
  const closed = pd.trades.filter(t => t.status !== 'open');
  const open = pd.trades.filter(t => t.status === 'open');
  const winRate = closed.length ? Math.round(pd.stats.wins / closed.length * 100) : 0;

  // Get current prices for open trades
  for (const trade of open) {
    try {
      const priceStr = await getCryptoPrice(trade.coin.toLowerCase());
      const priceMatch = priceStr?.match(/[\$]?([\d,]+\.?\d*)/);
      if (priceMatch) {
        const currentPrice = parseFloat(priceMatch[1].replace(',', ''));
        const priceDiff = trade.direction === 'long'
          ? currentPrice - trade.entry
          : trade.entry - currentPrice;
        const pnlPct = priceDiff / trade.entry;
        const unrealizedPnl = trade.size * pnlPct * (trade.leverage || 1);
        trade.currentPrice = currentPrice;
        trade.unrealizedPnl = parseFloat(Math.max(unrealizedPnl, -trade.size).toFixed(2));
        trade.unrealizedPct = parseFloat((pnlPct * (trade.leverage || 1) * 100).toFixed(2));
      }
    } catch(e) {}
  }

  return {
    balance: pd.balance,
    startBalance: PAPER_BALANCE,
    totalPnl: pd.stats.totalPnl,
    wins: pd.stats.wins,
    losses: pd.stats.losses,
    winRate,
    totalTrades: closed.length,
    openTrades: open.length,
    trades: [...open, ...closed.slice(-20).reverse()],
    leverage: settings.paperLeverage || 1,
    tradeSize: settings.paperTradeSize || null
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
          // Try alternative method
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
              console.log(`🖼️ Image downloaded (alt): ${item.imageBuffer.length} bytes`);
            }
          } catch(e2) {
            console.log(`🖼️ Image skip: ${e.message}`);
          }
        }
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
  startIndependentScanner(); // Started once here only

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
