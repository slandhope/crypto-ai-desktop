// ─── CRYPTO.AI DEV PANEL SERVER ───────────────────────────────────────────
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3001;
// DATA_DIR: use the local ./asuka-data folder (shared with scanner-server on EC2).
// Falls back to the Mac app-support path if that's where the data lives (desktop use).
const DATA_DIR = (() => {
  const local = path.join(__dirname, 'asuka-data');
  const mac = path.join(os.homedir(), 'Library', 'Application Support', 'crypto-ai-desktop', 'asuka-data');
  try { if (require('fs').existsSync(local)) return local; } catch (e) {}
  try { if (require('fs').existsSync(mac)) return mac; } catch (e) {}
  return local; // default: create/use local on the server
})();
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TRADES_FILE = path.join(DATA_DIR, 'paper-trades.json');
const LESSONS_FILE = path.join(DATA_DIR, 'trading-lessons.json');
const DAILY_SIGNALS_FILE = path.join(DATA_DIR, 'daily-signals.json');
const DEV_STATE_FILE = path.join(DATA_DIR, 'dev-state.json');
const COST_LOG_FILE = path.join(DATA_DIR, 'api-cost-log.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'coin-analytics.json');
const MASTER_COINS_FILE = path.join(DATA_DIR, 'master-coins.json');
const TIERS_FILE = path.join(DATA_DIR, 'tiers-config.json');
const ADVISORS_FILE = path.join(DATA_DIR, 'advisors.json');
const CUSTOM_COSMETICS_FILE = path.join(DATA_DIR, 'custom-cosmetics.json');
const DEFAULT_TIERS = [
  { level: 1, name: 'Acquaintance', xp: 0,    emoji: '🌱', unlocks: [] },
  { level: 2, name: 'Friend',       xp: 100,  emoji: '🌸', unlocks: ['outfit:casual'] },
  { level: 3, name: 'Close',        xp: 300,  emoji: '💛', unlocks: ['hair:long', 'accessory:flower'] },
  { level: 4, name: 'Trusted',      xp: 600,  emoji: '💗', unlocks: ['outfit:kimono', 'hair:twintails'] },
  { level: 5, name: 'Cherished',    xp: 1000, emoji: '💖', unlocks: ['accessory:catears', 'outfit:gothic'] },
  { level: 6, name: 'Devoted',      xp: 1600, emoji: '💝', unlocks: ['hair:silver', 'accessory:crown'] },
  { level: 7, name: 'Soulbound',    xp: 2500, emoji: '👑', unlocks: ['outfit:santa', 'special:poses'] }
];

const ALL_COINS = ['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','ARB','PEPE','BONK','TRUMP','WIF','SUI','APT'];
const COST_PER_COIN_MAIN = 1.79;  // $/day per coin in main scanner
const COST_PER_COIN_SCALP = 0.21; // $/day per coin in scalp scanner
const DEFAULT_PASSWORD = 'Asuka2026!';

function loadJSON(file, def = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch(e) { return def; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('Save error:', e.message); }
}

function getDevState() {
  try {
    // Try dev-state.json
    const state = loadJSON(DEV_STATE_FILE, null);
    if (state && state.password) {
      return { ...state };
    }
  } catch(e) {}
  
  try {
    // Try settings.json
    const settings = loadJSON(SETTINGS_FILE, null);
    if (settings && settings.devPassword) {
      return {
        password: settings.devPassword,
        coinOverride: null,
        intervalOverride: null,
        pauseAll: false,
        pauseScalp: false,
        pauseMain: false
      };
    }
  } catch(e) {}
  
  // Always fallback to default
  return {
    password: DEFAULT_PASSWORD,
    coinOverride: null,
    intervalOverride: null,
    pauseAll: false,
    pauseScalp: false,
    pauseMain: false
  };
}
function saveDevState(s) { saveJSON(DEV_STATE_FILE, s); }

function getMasterCoins() {
  return loadJSON(MASTER_COINS_FILE, {
    main: ['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','ARB','PEPE'],
    scalp: ['BTC','ETH','SOL','BNB','XRP','DOGE'],
    day: ['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX'],
    disabled: { main: [], scalp: [], day: [] }
  });
}

function getCostEstimate(master) {
  const mainActive = (master.main||[]).filter(c => !(master.disabled?.main||[]).includes(c));
  const scalpActive = (master.scalp||[]).filter(c => !(master.disabled?.scalp||[]).includes(c));
  const mainCost = mainActive.length * COST_PER_COIN_MAIN;
  const scalpCost = scalpActive.length * COST_PER_COIN_SCALP;
  return {
    mainCoins: mainActive.length,
    scalpCoins: scalpActive.length,
    mainCostDay: mainCost,
    scalpCostDay: scalpCost,
    totalDay: mainCost + scalpCost,
    totalMonth: (mainCost + scalpCost) * 30
  };
}

function getStats() {
  const settings = loadJSON(SETTINGS_FILE, {});
  const trades = loadJSON(TRADES_FILE, { trades: [], balance: 100000 });
  const lessons = loadJSON(LESSONS_FILE, []);
  const signals = loadJSON(DAILY_SIGNALS_FILE, { signals: {} });
  const costLog = loadJSON(COST_LOG_FILE, { today: 0, month: 0, calls: { haiku: 0, sonnet: 0 } });
  const analytics = loadJSON(ANALYTICS_FILE, { users: {}, coinStats: {}, totalUsers: 0 });
  const master = getMasterCoins();
  const devState = getDevState();

  const openTrades = trades.trades?.filter(t => t.status === 'open') || [];
  const today = new Date().toDateString();
  const todayTrades = trades.trades?.filter(t => t.closeTime && new Date(t.closeTime).toDateString() === today) || [];
  const allClosed = trades.trades?.filter(t => t.status !== 'open') || [];
  const wins = todayTrades.filter(t => t.pnl > 0);
  const allWins = allClosed.filter(t => t.pnl > 0);
  const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl||0), 0);

  return {
    costToday: costLog.today || 0,
    costMonth: costLog.month || 0,
    haikuCalls: costLog.calls?.haiku || 0,
    sonnetCalls: costLog.calls?.sonnet || 0,
    projectedMonthly: (costLog.today || 0) * 30,
    openTrades: openTrades.length,
    openTradesList: openTrades.slice(0, 20),
    todayTrades: todayTrades.length,
    todayPnl, todayWins: wins.length,
    balance: trades.balance || 100000,
    totalTrades: allClosed.length,
    totalWins: allWins.length,
    winRate: allClosed.length > 0 ? Math.round(allWins.length / allClosed.length * 100) : 0,
    totalPnl: allClosed.reduce((s, t) => s + (t.pnl||0), 0),
    tradingCoins: settings.tradingCoins || [],
    scalpCoins: settings.scalpCoins || [],
    dayTradeCoins: settings.dayTradeCoins || [],
    scanInterval: settings.scanInterval || 30,
    autoPaperTrade: settings.autoPaperTrade || false,
    scalpTrading: settings.scalpTrading || false,
    dailyTradeEnabled: settings.dailyTradeEnabled || false,
    dailySignals: signals.signals || {},
    signalDate: signals.date || 'N/A',
    lessonCount: Array.isArray(lessons) ? lessons.length : 0,
    recentLessons: Array.isArray(lessons) ? lessons.slice(-5).reverse() : [],
    analytics, master,
    costEstimate: getCostEstimate(master),
    ...devState,
    timestamp: new Date().toISOString(),
  };
}

// Auto-optimize: disable coins below threshold
function autoOptimize(threshold, type) {
  const analytics = loadJSON(ANALYTICS_FILE, { coinStats: {} });
  const master = getMasterCoins();
  const stats = analytics.coinStats?.[type] || {};
  const toDisable = [];

  ALL_COINS.forEach(coin => {
    const coinData = stats[coin];
    const pct = coinData?.pct || 0;
    if (pct < threshold && pct > 0) toDisable.push(coin);
    if (pct === 0 && master[type]?.includes(coin)) toDisable.push(coin);
  });

  master.disabled = master.disabled || { main: [], scalp: [], day: [] };
  master.disabled[type] = [...new Set([...(master.disabled[type]||[]), ...toDisable])];
  saveJSON(MASTER_COINS_FILE, master);
  return { disabled: toDisable, master };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const devState = getDevState();
  const isAuthed = token === devState.password || pathname === '/auth' || pathname === '/';

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {

    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(getHTML());
      return;
    }

    if (pathname === '/auth' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      try {
        const parsed = JSON.parse(body);
        const password = (parsed.password || '').trim();
        const state = getDevState();
        const stored = (state.password || DEFAULT_PASSWORD).trim();
        if (password === stored) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, token: stored }));
          console.log('✅ Auth successful');
        } else {
          res.writeHead(200); // 200 so browser gets the response
          res.end(JSON.stringify({ success: false, error: 'Wrong password' }));
          console.log('❌ Auth failed');
        }
      } catch(e) { 
        console.error('Auth parse error:', e.message, 'body:', body);
        res.writeHead(200);
        res.end(JSON.stringify({ success: false, error: 'Parse error: ' + e.message }));
      }
      return;
    }

    if (!isAuthed) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

    if (pathname === '/api/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(getStats()));
      return;
    }

    if (pathname === '/api/publish-config' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      (async () => {
        try {
          const { config } = JSON.parse(body);
          const ghToken = process.env.GITHUB_TOKEN;
          const repo = process.env.GITHUB_CONFIG_REPO || 'slandhop/crypto-ai-config';
          if (!ghToken) { res.writeHead(200); res.end(JSON.stringify({ success: false, error: 'NO_TOKEN' })); return; }
          const apiUrl = `https://api.github.com/repos/${repo}/contents/sponsored.json`;
          const headers = { 'Authorization': `Bearer ${ghToken}`, 'User-Agent': 'crypto-ai-dev', 'Accept': 'application/vnd.github+json' };
          let sha = null;
          try { const cur = await fetch(apiUrl, { headers }); if (cur.ok) sha = (await cur.json()).sha; } catch(e) {}
          const put = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify({
            message: 'Broadcast update from dev panel',
            content: Buffer.from(JSON.stringify(config, null, 2)).toString('base64'),
            ...(sha ? { sha } : {}) }) });
          const ok = put.ok;
          console.log(ok ? '📡 Config published to GitHub' : '❌ Publish failed');
          res.writeHead(200); res.end(JSON.stringify({ success: ok, error: ok ? null : (await put.text()).slice(0,150) }));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({ success: false, error: e.message })); }
      })();
      return;
    }

    if (pathname === '/api/control' && req.method === 'POST') {
      try {
        const cmd = JSON.parse(body);
        const state = getDevState();
        const master = getMasterCoins();
        master.disabled = master.disabled || { main: [], scalp: [], day: [] };
        let result = {};

        if (cmd.action === 'pauseAll') { state.pauseAll = true; state.pauseScalp = true; state.pauseMain = true; }
        if (cmd.action === 'resumeAll') { state.pauseAll = false; state.pauseScalp = false; state.pauseMain = false; }
        if (cmd.action === 'toggleScalp') state.pauseScalp = !state.pauseScalp;
        if (cmd.action === 'toggleMain') state.pauseMain = !state.pauseMain;
        if (cmd.action === 'setInterval') {
          state.intervalOverride = cmd.value || null;
          const settings = loadJSON(SETTINGS_FILE, {});
          if (cmd.value) settings.scanInterval = cmd.value;
          saveJSON(SETTINGS_FILE, settings);
        }
        if (cmd.action === 'toggleCoin') {
          const { type, coin } = cmd;
          const disabled = master.disabled[type] || [];
          if (disabled.includes(coin)) {
            master.disabled[type] = disabled.filter(c => c !== coin);
          } else {
            master.disabled[type] = [...disabled, coin];
          }
          saveJSON(MASTER_COINS_FILE, master);

          // Also update settings.json active coins
          const settings = loadJSON(SETTINGS_FILE, {});
          const activeCoins = (master[type]||[]).filter(c => !master.disabled[type].includes(c));
          const key = type === 'main' ? 'tradingCoins' : type === 'scalp' ? 'scalpCoins' : 'dayTradeCoins';
          settings[key] = activeCoins;
          saveJSON(SETTINGS_FILE, settings);
          result.activeCoins = activeCoins;
        }
        if (cmd.action === 'addCoin') {
          const type = cmd.type || 'main';
          const coin = String(cmd.coin || '').toUpperCase().trim();
          if (!/^[A-Z0-9]{2,10}$/.test(coin)) {
            result.error = 'Invalid coin symbol';
          } else {
            master[type] = master[type] || [];
            if (!master[type].includes(coin)) master[type].push(coin);
            // Make sure it's not in disabled
            master.disabled[type] = (master.disabled[type] || []).filter(c => c !== coin);
            saveJSON(MASTER_COINS_FILE, master);
            const settings = loadJSON(SETTINGS_FILE, {});
            const key = type === 'main' ? 'tradingCoins' : type === 'scalp' ? 'scalpCoins' : 'dayTradeCoins';
            settings[key] = (master[type]).filter(c => !master.disabled[type].includes(c));
            saveJSON(SETTINGS_FILE, settings);
            result.added = coin;
            result.activeCoins = settings[key];
            console.log('🪙 Dev added coin: ' + coin + ' to ' + type);
          }
        }
        if (cmd.action === 'autoOptimize') {
          result = autoOptimize(cmd.threshold || 20, cmd.type || 'main');
        }
        if (cmd.action === 'changePassword') {
          if (cmd.value && cmd.value.length >= 8) state.password = cmd.value;
        }
        if (cmd.action === 'resetDisabled') {
          master.disabled = { main: [], scalp: [], day: [] };
          saveJSON(MASTER_COINS_FILE, master);
        }

        saveDevState(state);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, ...result }));
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return;
    }

    // ── Progression tiers ──
    // ── Advisor management (dev-only: tokens are secrets) ──
    if (pathname === '/api/advisors' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      let d = loadJSON(ADVISORS_FILE, { advisors: [] });
      // Seed a default advisor if none exist yet (so the panel is never empty)
      if (!d.advisors || !d.advisors.length) {
        d = { advisors: [{ id: 'main', name: 'Your Guy', handle: '@youradvisor', avatar: '',
          botToken: '', followMode: 'notify', riskUsd: 50, maxPerDay: 200, wins: 0, losses: 0, active: true }] };
        saveJSON(ADVISORS_FILE, d);
      }
      res.writeHead(200); res.end(JSON.stringify(d));
      return;
    }
    if (pathname === '/api/advisors' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const d = loadJSON(ADVISORS_FILE, { advisors: [] });
        d.advisors = JSON.parse(body).advisors || [];
        saveJSON(ADVISORS_FILE, d);
        res.writeHead(200); res.end(JSON.stringify({ success:true, advisors:d.advisors }));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:e.message })); }
      return;
    }
    if (pathname === '/api/advisor-add' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const a = JSON.parse(body);
        const d = loadJSON(ADVISORS_FILE, { advisors: [] });
        d.advisors.push({ id:'adv_'+Date.now(), name:a.name||'Advisor', handle:a.handle||'', avatar:'',
          botToken:a.botToken||'', followMode:'notify', riskUsd:50, maxPerDay:200, wins:0, losses:0, active:true });
        saveJSON(ADVISORS_FILE, d);
        res.writeHead(200); res.end(JSON.stringify({ success:true, advisors:d.advisors }));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:e.message })); }
      return;
    }
    if (pathname === '/api/advisor-delete' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const { id } = JSON.parse(body);
        const d = loadJSON(ADVISORS_FILE, { advisors: [] });
        d.advisors = d.advisors.filter(x => x.id !== id);
        saveJSON(ADVISORS_FILE, d);
        res.writeHead(200); res.end(JSON.stringify({ success:true, advisors:d.advisors }));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:e.message })); }
      return;
    }

    if (pathname === '/api/tiers' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      const tiers = loadJSON(TIERS_FILE, null);
      res.writeHead(200);
      res.end(JSON.stringify({ tiers: (Array.isArray(tiers)&&tiers.length)?tiers:DEFAULT_TIERS }));
      return;
    }
    if (pathname === '/api/tiers' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const parsed = JSON.parse(body);
        let tiers = parsed.tiers;
        if (!Array.isArray(tiers)) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:'tiers must be array' })); return; }
        tiers.sort((a,b)=>a.xp-b.xp).forEach((t,i)=>t.level=i+1);
        saveJSON(TIERS_FILE, tiers);
        res.writeHead(200); res.end(JSON.stringify({ success:true, tiers }));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:e.message })); }
      return;
    }
    if (pathname === '/api/tiers-reset' && req.method === 'POST') {
      saveJSON(TIERS_FILE, DEFAULT_TIERS);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200); res.end(JSON.stringify({ success:true, tiers:DEFAULT_TIERS }));
      return;
    }
    if (pathname === '/api/add-cosmetic' && req.method === 'POST') {
      res.setHeader('Content-Type', 'application/json');
      try {
        const { category, item } = JSON.parse(body);
        if (!['outfit','hair','accessory'].includes(category) || !item?.id || !item?.name) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:'need category + id + name' })); return; }
        const c = loadJSON(CUSTOM_COSMETICS_FILE, { outfit:[], hair:[], accessory:[] });
        c[category] = c[category] || [];
        if (c[category].some(i=>i.id===item.id)) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:'id exists' })); return; }
        c[category].push({ id:item.id, name:item.name, price:item.price||0, asset:item.asset||null, limited:!!item.limited, seasonal:item.seasonal||null });
        saveJSON(CUSTOM_COSMETICS_FILE, c);
        res.writeHead(200); res.end(JSON.stringify({ success:true }));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({ success:false, error:e.message })); }
      return;
    }

    res.writeHead(404); res.end('Not found');
  });
});

function getHTML() { return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚙️ CRYPTO.AI Dev</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#060812;color:#e2e8f0;min-height:100vh}
#lock{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}
#lock .logo{font-size:64px;margin-bottom:16px}
#lock h2{font-size:22px;font-weight:800;margin-bottom:6px}
#lock p{color:#475569;margin-bottom:28px;font-size:13px}
#pwd{width:280px;padding:14px;border-radius:12px;border:1px solid #1e293b;background:#0f172a;color:#e2e8f0;font-size:16px;text-align:center;margin-bottom:10px;outline:none;transition:.2s}
#pwd:focus{border-color:#00d4ff}
#unlock-btn{width:280px;padding:14px;border-radius:12px;border:none;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;font-size:15px;font-weight:700;cursor:pointer;transition:.2s}
#unlock-btn:hover{opacity:.9;transform:translateY(-1px)}
#lock-err{color:#ef4444;font-size:12px;margin-top:8px;min-height:18px}

#app{display:none;min-height:100vh}
nav{background:#0a0f1e;border-bottom:1px solid #1e293b;padding:0 20px;display:flex;justify-content:space-between;align-items:center;height:52px;position:sticky;top:0;z-index:100}
.nav-title{font-size:15px;font-weight:800;background:linear-gradient(135deg,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-tabs{display:flex;gap:2px}
.nav-tab{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;color:#64748b;cursor:pointer;border:none;background:none;transition:.15s}
.nav-tab.active{background:#1e293b;color:#e2e8f0}
.nav-right{display:flex;gap:8px;align-items:center}
#refresh-time{font-size:10px;color:#475569}

main{padding:16px 20px;max-width:1400px;margin:0 auto}
.tab-content{display:none}
.tab-content.active{display:block}

.grid{display:grid;gap:12px}
.g2{grid-template-columns:1fr 1fr}
.g3{grid-template-columns:1fr 1fr 1fr}
.g4{grid-template-columns:1fr 1fr 1fr 1fr}

.card{background:#0a0f1e;border:1px solid #1e293b;border-radius:14px;padding:16px}
.card-title{font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}

.stat-box{background:#0f172a;border-radius:10px;padding:12px;text-align:center}
.stat-label{font-size:10px;color:#475569;margin-bottom:4px}
.stat-val{font-size:22px;font-weight:800}
.stat-sub{font-size:10px;color:#475569;margin-top:2px}

.green{color:#34d399}.red{color:#ef4444}.yellow{color:#fbbf24}.blue{color:#00d4ff}.purple{color:#a78bfa}.orange{color:#fb923c}

.row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #0f172a}
.row:last-child{border:none}
.row-label{font-size:12px;font-weight:600}
.row-sub{font-size:10px;color:#475569}

.pill{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700}
.pill-green{background:rgba(52,211,153,.15);color:#34d399}
.pill-red{background:rgba(239,68,68,.15);color:#ef4444}
.pill-yellow{background:rgba(251,191,36,.15);color:#fbbf24}
.pill-blue{background:rgba(0,212,255,.15);color:#00d4ff}

btn,button{cursor:pointer;border-radius:8px;font-weight:600;font-size:12px;padding:8px 14px;border:none;transition:.15s}
button:hover{opacity:.85;transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff}
.btn-danger{background:rgba(239,68,68,.2);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.btn-success{background:rgba(52,211,153,.2);color:#34d399;border:1px solid rgba(52,211,153,.3)}
.btn-warning{background:rgba(251,191,36,.2);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.btn-ghost{background:#1e293b;color:#e2e8f0}
.btn-sm{padding:5px 10px;font-size:11px}

.bar-wrap{background:#1e293b;border-radius:4px;height:8px;overflow:hidden;margin-top:4px}
.bar{height:8px;border-radius:4px;transition:width .5s}

/* Coin grid */
.coin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:10px}
.coin-card{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:10px;cursor:pointer;transition:.15s;position:relative}
.coin-card:hover{border-color:#00d4ff;transform:translateY(-1px)}
.coin-card.disabled{opacity:.4;border-style:dashed}
.coin-card.disabled .coin-toggle{background:#1e293b;color:#475569}
.coin-name{font-size:13px;font-weight:700;margin-bottom:4px}
.coin-pct{font-size:11px;color:#475569;margin-bottom:6px}
.coin-cost{font-size:10px;color:#fbbf24}
.coin-bar{height:4px;background:#1e293b;border-radius:2px;margin:6px 0}
.coin-bar-fill{height:4px;border-radius:2px;transition:width .5s}
.coin-toggle{position:absolute;top:8px;right:8px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:#34d399;color:#000}
.coin-users{font-size:10px;color:#475569}

.type-tabs{display:flex;gap:6px;margin-bottom:12px}
.type-tab{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;background:#0f172a;color:#64748b;cursor:pointer;border:1px solid #1e293b;transition:.15s}
.type-tab.active{background:#1e293b;color:#e2e8f0;border-color:#334155}

.trade-row{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0f172a;border-radius:8px;margin-bottom:4px;font-size:12px}

input[type=text],input[type=password],input[type=number]{background:#0f172a;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;padding:8px 12px;font-size:13px;width:100%;outline:none;transition:.15s}
input:focus{border-color:#00d4ff}

.emergency-banner{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:10px;padding:12px;text-align:center;margin-bottom:12px;display:none}

@media(max-width:768px){.g4,.g3,.g2{grid-template-columns:1fr}.coin-grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>

<!-- Lock -->
<div id="lock">
  <div class="logo">🔒</div>
  <h2>CRYPTO.AI Dev Panel</h2>
  <p>Secure developer access only</p>
  <input type="password" id="pwd" placeholder="Developer password">
  <button id="unlock-btn" style="cursor:pointer;" onclick="(function(){var p=document.getElementById('pwd');if(!p)return;var pwd=p.value.trim();if(!pwd){document.getElementById('lock-err').textContent='Enter password';return;}fetch('/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})}).then(function(r){return r.json()}).then(function(d){if(d.success){localStorage.setItem('dev_token',d.token);window._token=d.token;document.getElementById('lock').style.display='none';document.getElementById('app').style.display='block';if(typeof refresh==='function')refresh();}else{document.getElementById('lock-err').textContent='Wrong password — try Asuka2026!';p.value='';p.focus();}}).catch(function(e){document.getElementById('lock-err').textContent='Error: '+e.message;})})()">Unlock</button>
  <div id="lock-err"></div>
</div>

<!-- App -->
<div id="app">
  <nav>
    <div class="nav-title">⚙️ CRYPTO.AI Dev</div>
    <div class="nav-tabs">
      <button class="nav-tab active" data-tab="overview">Overview</button>
      <button class="nav-tab" data-tab="coins">Coin Control</button>
      <button class="nav-tab" data-tab="trades">Trades</button>
      <button class="nav-tab" data-tab="broadcast">📡 Broadcast</button>
        <button class="nav-tab" data-tab="settings">Settings</button>
    </div>
    <div class="nav-right">
      <span id="refresh-time"></span>
      <button class="btn-ghost btn-sm" id="refresh-btn">🔄</button>
      <button class="btn-danger btn-sm" id="lock-btn">🔒 Lock</button>
    </div>
  </nav>

  <main>

    <!-- Emergency Banner -->
    <div class="emergency-banner" id="emergency-banner">
      ⏸️ TRADING PAUSED BY DEV — Click Resume to restore
      <button class="btn-success btn-sm" style="margin-left:10px" id="resume-all-btn">▶️ Resume All</button>
    </div>

    <!-- ══ OVERVIEW TAB ══ -->
    <div class="tab-content active" id="tab-overview">

      <!-- Cost Monitor -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">💰 API Cost Monitor</div>
        <div class="grid g4" style="margin-bottom:12px;">
          <div class="stat-box">
            <div class="stat-label">Today</div>
            <div class="stat-val blue" id="c-today">$0.00</div>
            <div class="stat-sub" id="c-today-calls">0 calls</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">This Month</div>
            <div class="stat-val" id="c-month">$0.00</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Projected/Month</div>
            <div class="stat-val red" id="c-projected">$0.00</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Active Cost/Day</div>
            <div class="stat-val yellow" id="c-active">$0.00</div>
            <div class="stat-sub" id="c-active-coins">based on active coins</div>
          </div>
        </div>
        <div class="grid g2">
          <div>
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
              <span style="color:#475569;">Haiku calls</span>
              <span class="blue" id="haiku-n">0</span>
            </div>
            <div class="bar-wrap"><div class="bar" id="haiku-bar" style="background:#00d4ff;width:0%"></div></div>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
              <span style="color:#475569;">Sonnet calls</span>
              <span class="purple" id="sonnet-n">0</span>
            </div>
            <div class="bar-wrap"><div class="bar" id="sonnet-bar" style="background:#a78bfa;width:0%"></div></div>
          </div>
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:12px;">
        <!-- Trade Stats -->
        <div class="card">
          <div class="card-title">📊 Trade Performance</div>
          <div class="grid g3" style="margin-bottom:10px;">
            <div class="stat-box">
              <div class="stat-label">Open</div>
              <div class="stat-val yellow" id="s-open">0</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Win Rate</div>
              <div class="stat-val green" id="s-wr">0%</div>
            </div>
            <div class="stat-box">
              <div class="stat-label">Today P&L</div>
              <div class="stat-val" id="s-pnl">$0</div>
            </div>
          </div>
          <div class="row"><span class="row-label">Total Trades</span><span class="blue" id="s-total">0</span></div>
          <div class="row"><span class="row-label">All-time P&L</span><span id="s-allpnl" class="green">$0</span></div>
          <div class="row"><span class="row-label">Balance</span><span class="blue" id="s-bal">$0</span></div>
          <div class="row"><span class="row-label">Lessons Learned</span><span class="purple" id="s-lessons">0</span></div>
        </div>

        <!-- System Status -->
        <div class="card">
          <div class="card-title">🔧 System Status</div>
          <div class="row"><span class="row-label">Auto Trading</span><span id="st-auto" class="pill pill-red">OFF</span></div>
          <div class="row"><span class="row-label">Main Scanner</span><span id="st-main" class="pill pill-green">RUNNING</span></div>
          <div class="row"><span class="row-label">Scalp Scanner</span><span id="st-scalp" class="pill pill-green">RUNNING</span></div>
          <div class="row"><span class="row-label">Daily Bot</span><span id="st-daily" class="pill pill-red">OFF</span></div>
          <div class="row"><span class="row-label">Scan Interval</span><span class="yellow" id="st-interval">30min</span></div>
          <div class="row"><span class="row-label">Total Users</span><span class="blue" id="st-users">0</span></div>
        </div>
      </div>

      <!-- Emergency Controls -->
      <div class="card" style="margin-bottom:12px;border-color:rgba(239,68,68,.3);">
        <div class="card-title">🚨 Emergency Controls</div>
        <div class="grid g4" style="margin-bottom:10px;">
          <button class="btn-danger" id="pause-all-btn" style="padding:14px;">⏸️ Pause ALL</button>
          <button class="btn-success" id="resume-all-btn" style="padding:14px;">▶️ Resume ALL</button>
          <button class="btn-warning" id="toggle-scalp-btn">⚡ Toggle Scalp</button>
          <button class="btn-warning" id="toggle-main-btn">📈 Toggle Main</button>
        </div>
        <div id="emergency-status" style="font-size:12px;text-align:center;padding:8px;background:#0f172a;border-radius:8px;color:#34d399;">✅ All systems running normally</div>
      </div>

      <!-- Coin Override -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">🪙 Global Coin Override</div>
        <p style="font-size:12px;color:#64748b;margin-bottom:10px;">Limit coins scanned — instant cost reduction</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn-ghost btn-sm active-btn" data-coins="all">All Coins</button>
          <button class="btn-ghost btn-sm" data-coins="5">Max 5</button>
          <button class="btn-ghost btn-sm" data-coins="3">BTC/ETH/SOL</button>
          <button class="btn-ghost btn-sm" data-coins="2">BTC/ETH</button>
          <button class="btn-ghost btn-sm" data-coins="1">BTC Only</button>
        </div>
        <div id="coin-override-hint" style="font-size:11px;color:#64748b;margin-top:6px;"></div>
      </div>

      <!-- Scan Interval Override -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">⏱️ Scan Interval Override</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;" id="interval-btns">
          <button class="btn-ghost btn-sm active-btn" data-interval="0">User Setting</button>
          <button class="btn-ghost btn-sm" data-interval="30">30 min</button>
          <button class="btn-ghost btn-sm" data-interval="60">1 hour</button>
          <button class="btn-ghost btn-sm" data-interval="120">2 hours</button>
          <button class="btn-ghost btn-sm" data-interval="240">4 hours</button>
        </div>
      </div>

      <!-- Daily Signals -->
      <div class="card">
        <div class="card-title">📅 Daily RSI Signals</div>
        <div id="daily-sigs">Loading...</div>
      </div>

      <!-- Advisor Manager (dev-only — tokens are secrets) -->
      <div class="card" style="margin-top:12px;">
        <div class="card-title">📣 Advisor Manager</div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">Set advisor bot tokens + add advisors. Tokens live only on this machine. Users follow these advisors in the app (notify/auto), but never see or set tokens.</div>
        <div id="adv-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px;">Loading...</div>
        <div style="font-size:13px;font-weight:700;margin:12px 0 6px;color:#e8edf4;">➕ Add Advisor</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
          <input id="nadv-name" placeholder="Name" style="padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;">
          <input id="nadv-handle" placeholder="@handle (optional)" style="padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;">
        </div>
        <input id="nadv-token" placeholder="Bot token from @BotFather" style="width:100%;padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;margin-bottom:6px;">
        <button class="btn-ghost btn-sm" onclick="addAdvisor()" style="background:rgba(52,211,153,.15);">➕ Add Advisor</button>
        <div id="adv-msg" style="font-size:12px;color:#94a3b8;margin-top:6px;"></div>
      </div>

      <!-- Progression Editor -->
      <div class="card" style="margin-top:12px;">
        <div class="card-title">🎀 Progression Editor (Levels & Cosmetics)</div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">Edit relationship tiers — name, XP, emoji, unlocks. Applies live.</div>
        <div id="tier-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px;">Loading...</div>
        <div style="display:flex;gap:6px;margin-bottom:6px;">
          <button class="btn-ghost btn-sm" onclick="addTier()">➕ Add Tier</button>
          <button class="btn-ghost btn-sm" onclick="saveTiers()" style="background:rgba(52,211,153,.15);">💾 Save</button>
          <button class="btn-ghost btn-sm" onclick="resetTiers()" style="background:rgba(239,68,68,.1);">Reset</button>
        </div>
        <div id="tier-msg" style="font-size:12px;color:#94a3b8;"></div>

        <div style="font-size:13px;font-weight:700;margin:14px 0 6px;color:#e8edf4;">➕ Add Cosmetic to Shop</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
          <select id="cos-cat" style="padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;"><option value="outfit">Outfit</option><option value="hair">Hair</option><option value="accessory">Accessory</option></select>
          <input id="cos-id" placeholder="id (ninja)" style="padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
          <input id="cos-name" placeholder="Display name" style="padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;">
          <input id="cos-price" type="number" placeholder="Price (coins)" style="padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;">
        </div>
        <input id="cos-asset" placeholder="asset path (outfits/ninja.png)" style="width:100%;padding:7px;border-radius:7px;background:#1e293b;border:1px solid #334155;color:#fff;margin-bottom:6px;">
        <label style="font-size:12px;display:block;margin-bottom:6px;color:#94a3b8;"><input type="checkbox" id="cos-limited"> Limited edition</label>
        <button class="btn-ghost btn-sm" onclick="addCosmetic()">➕ Add to Shop</button>
        <div id="cos-msg" style="font-size:12px;color:#94a3b8;margin-top:5px;"></div>
      </div>
    </div>

    <!-- ══ COIN CONTROL TAB ══ -->
    <div class="tab-content" id="tab-coins">

      <!-- Cost Summary -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">💰 Cost by Scanner Type</div>
        <div class="grid g3">
          <div class="stat-box">
            <div class="stat-label">Main Trade</div>
            <div class="stat-val red" id="cc-main-cost">$0/day</div>
            <div class="stat-sub" id="cc-main-coins">0 coins active</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Scalp</div>
            <div class="stat-val yellow" id="cc-scalp-cost">$0/day</div>
            <div class="stat-sub" id="cc-scalp-coins">0 coins active</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">Total Monthly</div>
            <div class="stat-val green" id="cc-total">$0/mo</div>
            <div class="stat-sub">all scanners</div>
          </div>
        </div>
      </div>

      <!-- Coin Type Selector -->
      <div class="type-tabs">
        <button class="type-tab active" data-cointype="main">📈 Main Trade</button>
        <button class="type-tab" data-cointype="scalp">⚡ Scalp</button>
        <button class="type-tab" data-cointype="day">📅 Day Trade</button>
      </div>

      <!-- Auto Optimize -->
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">🤖 Auto Optimize</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span style="font-size:12px;color:#475569;">Disable coins used by less than</span>
          <select id="threshold-select" style="background:#0f172a;border:1px solid #1e293b;color:#e2e8f0;padding:6px;border-radius:6px;font-size:12px;">
            <option value="10">10%</option>
            <option value="20" selected>20%</option>
            <option value="30">30%</option>
            <option value="50">50%</option>
          </select>
          <span style="font-size:12px;color:#475569;">of users</span>
          <button class="btn-primary btn-sm" id="auto-optimize-btn">🤖 Auto Optimize</button>
          <button class="btn-ghost btn-sm" id="reset-all-btn">Reset All ON</button>
        </div>
        <div id="optimize-result" style="font-size:11px;color:#475569;margin-top:8px;"></div>
      </div>

      <!-- Coin Grid -->
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <div class="card-title" style="margin:0;" id="coin-grid-title">📈 Main Trade Coins</div>
        <div style="display:flex;gap:6px;margin:8px 0;">
          <input id="cc-add-input" placeholder="Add coin (must exist on Binance Futures, e.g. WIF)" style="flex:1;padding:8px;border-radius:8px;border:1px solid #1e293b;background:#0f172a;color:#e2e8f0;text-transform:uppercase;">
          <button class="btn-ghost btn-sm" id="cc-add-btn">+ Add to this list</button>
        </div>
        <div id="cc-add-status" style="font-size:11px;color:#94a3b8;margin-bottom:6px;"></div>
          <span style="font-size:11px;color:#475569;" id="coin-grid-cost"></span>
        </div>
        <div class="coin-grid" id="coin-grid">Loading...</div>
      </div>
    </div>

    <!-- ══ TRADES TAB ══ -->
    <div class="tab-content" id="tab-trades">
      <div class="card">
        <div class="card-title">🟡 Open Trades</div>
        <div id="open-trades-list"><div style="color:#475569;font-size:12px;padding:12px 0;">No open trades</div></div>
      </div>
      <div class="card" style="margin-top:12px;">
        <div class="card-title">🧠 Recent Lessons</div>
        <div id="lessons-list"><div style="color:#475569;font-size:12px;padding:12px 0;">No lessons yet</div></div>
      </div>
    </div>

    <!-- ══ SETTINGS TAB ══ -->
    <div class="tab-content" id="tab-broadcast">
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">📢 Sponsored Campaign</div>
        <input id="bc-name" placeholder="Campaign name" class="bc-in">
        <input id="bc-banner" placeholder="Banner text users see" class="bc-in">
        <input id="bc-url" placeholder="Link URL" class="bc-in">
        <textarea id="bc-context" placeholder="What Asuka knows (she discloses it's sponsored)" class="bc-in" style="height:50px;resize:vertical;"></textarea>
        <div style="display:flex;gap:6px;">
          <input id="bc-start" type="date" class="bc-in" style="flex:1;margin:0;">
          <input id="bc-end" type="date" class="bc-in" style="flex:1;margin:0;">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" id="bc-active" checked> Active</label>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">🧠 Intelligence Push → ALL users</div>
        <input id="bc-lesson-coin" placeholder="Coin (or GLOBAL)" class="bc-in">
        <textarea id="bc-lesson-text" placeholder="Lesson: 'Avoid alt longs during FOMC week'" class="bc-in" style="height:44px;resize:vertical;"></textarea>
        <button class="btn-ghost btn-sm" id="bc-add-lesson">+ Add Lesson</button>
        <div id="bc-lessons-list" style="font-size:11px;color:#94a3b8;margin-top:6px;"></div>
      </div>
      <div class="card" style="margin-bottom:12px;">
        <div class="card-title">💬 Suggested Questions</div>
        <div style="display:flex;gap:6px;">
          <input id="bc-prompt" placeholder="'Ask me about today's regime'" class="bc-in" style="flex:1;margin:0;">
          <button class="btn-ghost btn-sm" id="bc-add-prompt">+ Add</button>
        </div>
        <div id="bc-prompts-list" style="font-size:11px;color:#94a3b8;margin-top:6px;"></div>
      </div>
      <div class="card">
        <div class="card-title">🚀 Publish</div>
        <pre id="bc-preview" style="font-size:10px;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:8px;max-height:160px;overflow:auto;color:#94a3b8;">{}</pre>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="btn-ghost btn-sm" id="bc-copy" style="flex:1;">📋 Copy JSON</button>
          <button class="btn-ghost btn-sm" id="bc-publish" style="flex:1;">📡 Publish to GitHub</button>
        </div>
        <div id="bc-status" style="font-size:11px;margin-top:6px;color:#94a3b8;"></div>
        <div style="font-size:10px;color:#64748b;margin-top:4px;">Users refresh within 6h. One-click needs GITHUB_TOKEN in .env — else Copy JSON → paste to github.com/slandhop/crypto-ai-config</div>
      </div>
      <style>.bc-in{width:100%;margin:0 0 6px;padding:8px;border-radius:8px;border:1px solid #1e293b;background:#0f172a;color:#e2e8f0;box-sizing:border-box;}</style>
    </div>
    <div class="tab-content" id="tab-settings">
      <div class="card">
        <div class="card-title">🔑 Change Dev Password</div>
        <div style="display:flex;gap:8px;">
          <input type="password" id="new-pwd" placeholder="New password (min 8 chars)" style="flex:1;">
          <button class="btn-primary" id="change-pwd-btn">Save</button>
        </div>
        <div id="pwd-msg" style="font-size:12px;margin-top:8px;"></div>
      </div>
    </div>

  </main>
</div>

<script>
let token = localStorage.getItem('dev_token') || window._token || '';
let stats = null;
let currentCoinType = 'main';
let refreshTimer = null;

// ── Auth ──

let bcLessons = [], bcPrompts = [];
function bcBuild() {
  const cfg = { updated: new Date().toISOString(), campaigns: [], globalLessons: bcLessons, suggestedPrompts: bcPrompts };
  const name = document.getElementById('bc-name')?.value.trim();
  if (name) cfg.campaigns.push({
    name, active: document.getElementById('bc-active').checked,
    banner: document.getElementById('bc-banner').value.trim(),
    url: document.getElementById('bc-url').value.trim(),
    asukaContext: document.getElementById('bc-context').value.trim(),
    start: document.getElementById('bc-start').value || undefined,
    end: document.getElementById('bc-end').value || undefined });
  const pv = document.getElementById('bc-preview');
  if (pv) pv.textContent = JSON.stringify(cfg, null, 2);
  return cfg;
}
function bcRenderLists() {
  const ll = document.getElementById('bc-lessons-list'), pl = document.getElementById('bc-prompts-list');
  if (ll) ll.innerHTML = bcLessons.map(function(l,i){ return (i+1) + '. [' + l.coin + '] ' + l.lesson.slice(0,70); }).join('<br>') || 'No lessons queued';
  if (pl) pl.innerHTML = bcPrompts.map(function(p,i){ return (i+1) + '. ' + p; }).join('<br>') || 'No prompts queued';
  bcBuild();
}
async function unlock() {
  const pwdEl = document.getElementById('pwd');
  const err = document.getElementById('lock-err');
  const pwd = pwdEl ? pwdEl.value.trim() : '';
  if (err) err.textContent = 'Checking...';
  
  if (!pwd) { 
    if (err) err.textContent = '❌ Enter password first'; 
    return; 
  }
  
  try {
    console.log('Attempting login with:', JSON.stringify(pwd));
    const r = await fetch('/auth', { 
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({ password: pwd }) 
    });
    console.log('Response status:', r.status);
    const text = await r.text();
    console.log('Response body:', text);
    const d = JSON.parse(text);
    
    if (d.success) {
      token = d.token;
      localStorage.setItem('dev_token', token);
      document.getElementById('lock').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      refresh();
      refreshTimer = setInterval(refresh, 8000);
    } else {
      if (err) err.textContent = '❌ ' + (d.error || 'Wrong password') + ' — default: Asuka2026!';
      if (pwdEl) { pwdEl.value = ''; pwdEl.focus(); }
    }
  } catch(e) { 
    console.error('Unlock error:', e);
    if (err) err.textContent = '❌ Error: ' + e.message; 
  }
}

function lock() {
  localStorage.removeItem('dev_token');
  clearInterval(refreshTimer);
  document.getElementById('app').style.display = 'none';
  document.getElementById('lock').style.display = 'flex';
  document.getElementById('pwd').value = '';
}

async function api(url, method='GET', body=null) {
  const opts = { method, headers: {'Content-Type':'application/json','Authorization':'Bearer '+token} };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (r.status === 401) { lock(); return null; }
  return r.json();
}

async function loadAdvisors() {
  const list = document.getElementById('adv-list'); if (!list) return;
  try {
    const r = await api('/api/advisors', 'GET');
    if (!r) { list.innerHTML = '<div style="color:#fbbf24;font-size:12px;">Not authorized — log in again.</div>'; return; }
    const advs = r.advisors || [];
    if (!advs.length) { list.innerHTML = '<div style="color:#64748b;font-size:12px;">No advisors yet. Add one below.</div>'; return; }
    list.innerHTML = advs.map(function(a){
      var connected = a.botToken ? '#34d399' : '#64748b';
      var status = a.botToken ? '● connected' : '○ no token';
      return '<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
        + '<span style="font-weight:700;font-size:13px;">' + a.name + ' <span style="color:#64748b;font-weight:400;">' + (a.handle||'') + '</span></span>'
        + '<span style="font-size:11px;color:' + connected + ';">' + status + ' · ' + (a.wins||0) + 'W/' + (a.losses||0) + 'L</span>'
        + '</div>'
        + '<div style="display:flex;gap:6px;">'
        + '<input id="tok-' + a.id + '" type="password" value="' + (a.botToken||'') + '" placeholder="Bot token" style="flex:1;padding:6px;border-radius:6px;background:#1e293b;border:1px solid #334155;color:#fff;font-size:11px;">'
        + '<button class="btn-ghost btn-sm adv-save" data-id="' + a.id + '">Save</button>'
        + '<button class="btn-ghost btn-sm adv-del" data-id="' + a.id + '" style="background:rgba(239,68,68,.12);">✕</button>'
        + '</div></div>';
    }).join('');
    list.querySelectorAll('.adv-save').forEach(function(b){ b.onclick = function(){ saveAdvToken(b.getAttribute('data-id')); }; });
    list.querySelectorAll('.adv-del').forEach(function(b){ b.onclick = function(){ delAdvisor(b.getAttribute('data-id')); }; });
  } catch(e) { const l = document.getElementById('adv-list'); if (l) l.innerHTML = '<div style="color:#ef4444;font-size:12px;">'+e.message+'</div>'; }
}
async function saveAdvToken(id) {
  const token2 = document.getElementById('tok-'+id).value.trim();
  const r = await api('/api/advisors', 'GET'); if (!r) return;
  const advs = r.advisors || [];
  const a = advs.find(x => x.id === id); if (a) a.botToken = token2;
  await api('/api/advisors', 'POST', { advisors: advs });
  const m = document.getElementById('adv-msg'); if (m) m.textContent = 'Saved ✓'; loadAdvisors();
}
async function addAdvisor() {
  const name = document.getElementById('nadv-name').value.trim();
  const handle = document.getElementById('nadv-handle').value.trim();
  const botToken = document.getElementById('nadv-token').value.trim();
  const m = document.getElementById('adv-msg');
  if (!name) { if (m) m.textContent = 'Name required'; return; }
  await api('/api/advisor-add', 'POST', { name, handle, botToken });
  document.getElementById('nadv-name').value=''; document.getElementById('nadv-handle').value=''; document.getElementById('nadv-token').value='';
  if (m) m.textContent = 'Added ✓'; loadAdvisors();
}
async function delAdvisor(id) {
  if (!confirm('Remove this advisor?')) return;
  await api('/api/advisor-delete', 'POST', { id });
  loadAdvisors();
}


// ── Tabs ──
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const content = document.getElementById('tab-'+name);
  if (content) content.classList.add('active');
  const btn = document.querySelector('.nav-tab[data-tab="'+name+'"]');
  if (btn) btn.classList.add('active');
  if (name === 'coins') renderCoinGrid();
}

function showCoinType(type) {
  currentCoinType = type;
  document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
  const tb = document.querySelector('.type-tab[data-cointype="'+type+'"]');
  if (tb) tb.classList.add('active');
  renderCoinGrid();
}

// ── Refresh ──
async function refresh() {
  try { if (typeof loadTiers === "function") loadTiers(); } catch(e){ console.error("loadTiers", e); }
  try { loadAdvisors(); } catch(e){ console.error("loadAdvisors", e); }
  stats = await api('/api/stats');
  if (!stats) return;
  document.getElementById('refresh-time').textContent = new Date().toLocaleTimeString();
  updateOverview();
  renderCoinGrid();
  updateTrades();
}

function updateOverview() {
  if (!stats) return;
  // Cost
  el('c-today').textContent = '$' + (stats.costToday||0).toFixed(4);
  el('c-today-calls').textContent = (stats.haikuCalls||0) + ' Haiku + ' + (stats.sonnetCalls||0) + ' Sonnet';
  el('c-month').textContent = '$' + (stats.costMonth||0).toFixed(2);
  el('c-projected').textContent = '$' + (stats.projectedMonthly||0).toFixed(0);
  const est = stats.costEstimate || {};
  el('c-active').textContent = '$' + (est.totalDay||0).toFixed(2);
  el('c-active-coins').textContent = (est.mainCoins||0) + ' main + ' + (est.scalpCoins||0) + ' scalp coins';
  el('haiku-n').textContent = stats.haikuCalls||0;
  el('sonnet-n').textContent = stats.sonnetCalls||0;
  el('haiku-bar').style.width = Math.min(100,(stats.haikuCalls||0)/200*100)+'%';
  el('sonnet-bar').style.width = Math.min(100,(stats.sonnetCalls||0)/100*100)+'%';

  // Trades
  el('s-open').textContent = stats.openTrades||0;
  el('s-wr').textContent = stats.winRate+'%';
  const pnl = stats.todayPnl||0;
  const pnlEl = el('s-pnl');
  pnlEl.textContent = (pnl>=0?'+':'')+'$'+pnl.toFixed(2);
  pnlEl.className = pnl>=0?'stat-val green':'stat-val red';
  el('s-total').textContent = stats.totalTrades||0;
  const tpnl = stats.totalPnl||0;
  el('s-allpnl').textContent = (tpnl>=0?'+':'')+'$'+tpnl.toFixed(2);
  el('s-allpnl').className = tpnl>=0?'green':'red';
  el('s-bal').textContent = '$'+(stats.balance||0).toFixed(0);
  el('s-lessons').textContent = stats.lessonCount||0;

  // System
  el('st-auto').textContent = stats.autoPaperTrade?'ON':'OFF';
  el('st-auto').className = 'pill '+(stats.autoPaperTrade?'pill-green':'pill-red');
  el('st-main').textContent = stats.pauseMain?'PAUSED':'RUNNING';
  el('st-main').className = 'pill '+(stats.pauseMain?'pill-red':'pill-green');
  el('st-scalp').textContent = stats.pauseScalp?'PAUSED':'RUNNING';
  el('st-scalp').className = 'pill '+(stats.pauseScalp?'pill-red':'pill-green');
  el('st-daily').textContent = stats.dailyTradeEnabled?'ON':'OFF';
  el('st-daily').className = 'pill '+(stats.dailyTradeEnabled?'pill-green':'pill-red');
  el('st-interval').textContent = (stats.intervalOverride||stats.scanInterval||30)+' min';
  el('st-users').textContent = stats.analytics?.totalUsers||1;

  // Emergency
  const estatus = el('emergency-status');
  const banner = el('emergency-banner');
  if (stats.pauseAll) {
    estatus.textContent = '⏸️ ALL TRADING PAUSED';
    estatus.style.color = '#ef4444';
    banner.style.display = 'block';
  } else if (stats.pauseMain||stats.pauseScalp) {
    estatus.textContent = '⚠️ PARTIAL: Main='+(stats.pauseMain?'PAUSED':'OK')+' Scalp='+(stats.pauseScalp?'PAUSED':'OK');
    estatus.style.color = '#fbbf24';
    banner.style.display = 'none';
  } else {
    estatus.textContent = '✅ All systems running normally';
    estatus.style.color = '#34d399';
    banner.style.display = 'none';
  }

  // Daily signals
  const sigs = stats.dailySignals||{};
  const keys = Object.keys(sigs);
  const sigColors = {'Power Buy':'#34d399','Buy':'#86efac','Neutral':'#475569','Sell':'#fca5a5','Power Sell':'#ef4444'};
  el('daily-sigs').innerHTML = keys.length
    ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;">'+
      keys.map(c=>{const s=sigs[c];return '<div style="padding:8px;background:#0f172a;border-radius:8px;text-align:center;"><div style="font-weight:700;font-size:12px;">'+c+'</div><div style="font-size:10px;color:'+(sigColors[s.tier]||'#475569')+';">'+s.tier+'</div><div style="font-size:10px;color:#475569;">RSI '+s.rsi+'</div></div>'}).join('')
      +'</div><div style="font-size:10px;color:#475569;margin-top:6px;">'+stats.signalDate+'</div>'
    : '<div style="color:#475569;font-size:12px;">No signals — run daily bot first</div>';

  // Coin cost summary
  const est2 = stats.costEstimate||{};
  el('cc-main-cost').textContent = '$'+(est2.mainCostDay||0).toFixed(2)+'/day';
  el('cc-main-coins').textContent = (est2.mainCoins||0)+' coins active';
  el('cc-scalp-cost').textContent = '$'+(est2.scalpCostDay||0).toFixed(2)+'/day';
  el('cc-scalp-coins').textContent = (est2.scalpCoins||0)+' coins active';
  el('cc-total').textContent = '$'+(est2.totalMonth||0).toFixed(0)+'/mo';
}

function renderCoinGrid() {
  if (!stats) return;
  const type = currentCoinType;
  const master = stats.master||{};
  const analytics = stats.analytics||{};
  const disabled = master.disabled?.[type]||[];
  const allCoins = master[type]||['BTC','ETH','SOL','BNB','XRP','DOGE','AVAX','LINK','ARB','PEPE'];
  const coinStats = analytics.coinStats?.[type]||{};
  const totalUsers = analytics.totalUsers||1;
  const costPerCoin = type==='main' ? 1.79 : type==='scalp' ? 0.21 : 0.003;
  const titleMap = {'main':'📈 Main Trade','scalp':'⚡ Scalp','day':'📅 Day Trade'};
  const activeCount = allCoins.filter(c=>!disabled.includes(c)).length;
  el('coin-grid-title').textContent = titleMap[type]+' Coins';
  el('coin-grid-cost').textContent = activeCount+' active → $'+(activeCount*costPerCoin).toFixed(2)+'/day';

  const sorted = [...allCoins].sort((a,b)=>(coinStats[b]?.pct||0)-(coinStats[a]?.pct||0));

  el('coin-grid').innerHTML = sorted.map(coin => {
    const isDisabled = disabled.includes(coin);
    const data = coinStats[coin]||{count:0,pct:0};
    const barColor = data.pct>=50?'#34d399':data.pct>=20?'#fbbf24':'#ef4444';
    return '<div class="coin-card'+(isDisabled?' disabled':'')+'" data-toggle-coin="'+coin+'" title="Click to '+(isDisabled?'enable':'disable')+'">'
      +'<div class="coin-toggle">'+(isDisabled?'✕':'✓')+'</div>'
      +'<div class="coin-name">'+coin+'</div>'
      +'<div class="coin-bar"><div class="coin-bar-fill" style="width:'+data.pct+'%;background:'+barColor+'"></div></div>'
      +'<div class="coin-users">'+data.count+' users ('+data.pct+'%)</div>'
      +'<div class="coin-cost">$'+(costPerCoin*30).toFixed(0)+'/mo</div>'
      +'</div>';
  }).join('');
}

function updateTrades() {
  if (!stats) return;
  const trades = stats.openTradesList||[];
  el('open-trades-list').innerHTML = trades.length
    ? trades.map(t=>'<div class="trade-row">'
        +'<div><strong>'+t.coin+'</strong> <span style="color:'+(t.direction==='long'?'#34d399':'#ef4444')+';">'+(t.direction||'').toUpperCase()+'</span> '+t.leverage+'x</div>'
        +'<div style="color:#475569;">$'+((t.entry||0)).toFixed(2)+'</div>'
        +'<div>'+(t.isScalp?'⚡':t.isDayTrade?'📅':'📈')+'</div>'
        +'</div>').join('')
    : '<div style="color:#475569;font-size:12px;padding:12px 0;">No open trades</div>';

  const lessons = stats.recentLessons||[];
  el('lessons-list').innerHTML = lessons.length
    ? lessons.map(l=>'<div style="padding:8px 0;border-bottom:1px solid #0f172a;font-size:12px;color:#94a3b8;">📋 '+(l.rule||l.lesson||'').slice(0,120)+'</div>').join('')
    : '<div style="color:#475569;font-size:12px;padding:12px 0;">No lessons yet</div>';
}

// ── Controls ──
async function ctrl(action) {
  await api('/api/control','POST',{action});
  refresh();
}

async function toggleCoin(coin) {
  await api('/api/control','POST',{action:'toggleCoin',type:currentCoinType,coin});
  refresh();
}

async function setCoinOverride(val) {
  document.querySelectorAll('[data-coins]').forEach(b => b.classList.remove('active-btn'));
  const btn = document.querySelector('[data-coins="'+val+'"]');
  if (btn) btn.classList.add('active-btn');
  const hints = {
    'all':'Scanning all coins',
    '5':'Max 5 coins → saves ~$60/mo',
    '3':'BTC/ETH/SOL → saves ~$100/mo',
    '2':'BTC/ETH only → saves ~$135/mo',
    '1':'BTC only → saves ~$155/mo'
  };
  const hint = document.getElementById('coin-override-hint');
  if (hint) hint.textContent = hints[val] || '';
  api('/api/control','POST',{action:'setCoinOverride',value:val}).then(() => refresh());
}

async function setInterval_(min) {
  document.querySelectorAll('#interval-btns button').forEach(b=>b.classList.remove('active-btn'));
  const b = document.querySelector('[data-interval="'+min+'"]');
  if (b) b.classList.add('active-btn');
  await api('/api/control','POST',{action:'setInterval',value:min||null});
  refresh();
}

async function autoOptimize() {
  const threshold = parseInt(document.getElementById('threshold-select').value);
  const result = await api('/api/control','POST',{action:'autoOptimize',threshold,type:currentCoinType});
  if (result?.disabled?.length) {
    el('optimize-result').textContent = '✅ Disabled '+result.disabled.length+' coins: '+result.disabled.join(', ');
    el('optimize-result').style.color = '#34d399';
  } else {
    el('optimize-result').textContent = 'No coins to disable at this threshold';
    el('optimize-result').style.color = '#475569';
  }
  refresh();
}

async function resetAll() {
  await api('/api/control','POST',{action:'resetDisabled'});
  el('optimize-result').textContent = 'All coins re-enabled';
  refresh();
}

async function changePwd() {
  const pwd = document.getElementById('new-pwd').value;
  const msg = el('pwd-msg');
  if (pwd.length < 8) { msg.textContent='❌ Min 8 characters'; msg.style.color='#ef4444'; return; }
  const r = await api('/api/control','POST',{action:'changePassword',value:pwd});
  if (r?.success) {
    token = pwd;
    localStorage.setItem('dev_token',token);
    msg.textContent = '✅ Password changed';
    msg.style.color = '#34d399';
    document.getElementById('new-pwd').value = '';
  }
}

function el(id) { return document.getElementById(id); }

// Auto-login if token saved
window.onload = () => {
  // Wire unlock
  document.getElementById('unlock-btn').addEventListener('click', unlock);
  document.getElementById('pwd').addEventListener('keydown', e => {
    if (e.key === 'Enter') unlock();
  });

  // Wire nav tabs
  document.querySelectorAll('.nav-tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  // Wire action buttons
  document.getElementById('refresh-btn')?.addEventListener('click', refresh);
  document.getElementById('lock-btn')?.addEventListener('click', lock);
  document.getElementById('pause-all-btn')?.addEventListener('click', () => ctrl('pauseAll'));
  document.getElementById('resume-all-btn')?.addEventListener('click', () => ctrl('resumeAll'));
  document.getElementById('toggle-scalp-btn')?.addEventListener('click', () => ctrl('toggleScalp'));
  document.getElementById('toggle-main-btn')?.addEventListener('click', () => ctrl('toggleMain'));
  document.getElementById('auto-optimize-btn')?.addEventListener('click', autoOptimize);
  document.getElementById('reset-all-btn')?.addEventListener('click', resetAll);
  document.getElementById('change-pwd-btn')?.addEventListener('click', changePwd);

  // Wire coin override buttons
  document.querySelectorAll('[data-coins]').forEach(btn => {
    btn.addEventListener('click', () => setCoinOverride(btn.dataset.coins));
  });

  // Wire interval buttons
  document.querySelectorAll('[data-interval]').forEach(btn => {
    btn.addEventListener('click', () => setInterval_(parseInt(btn.dataset.interval)));
  });

  // Wire coin type tabs
  document.querySelectorAll('[data-cointype]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-cointype]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      showCoinType(btn.dataset.cointype);
    });
  });

  // Wire coin grid toggle (delegated - since grid is dynamic)
  document.addEventListener('click', e => {
    const card = e.target.closest('[data-toggle-coin]');
    if (card) toggleCoin(card.dataset.toggleCoin);
  });


  ;['bc-name','bc-banner','bc-url','bc-context','bc-start','bc-end','bc-active'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('input', bcBuild); el?.addEventListener('change', bcBuild);
  });
  document.getElementById('bc-add-lesson')?.addEventListener('click', () => {
    const text = document.getElementById('bc-lesson-text').value.trim();
    if (!text) return;
    bcLessons.push({ id: 'bc-' + Date.now(), coin: (document.getElementById('bc-lesson-coin').value.trim().toUpperCase() || 'GLOBAL'), lesson: text, source: 'remote', timestamp: Date.now() });
    document.getElementById('bc-lesson-text').value = '';
    bcRenderLists();
  });
  document.getElementById('bc-add-prompt')?.addEventListener('click', () => {
    const p = document.getElementById('bc-prompt').value.trim();
    if (!p) return;
    bcPrompts.push(p); document.getElementById('bc-prompt').value = '';
    bcRenderLists();
  });
  document.getElementById('bc-copy')?.addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(bcBuild(), null, 2));
    document.getElementById('bc-status').textContent = '📋 Copied — paste into GitHub sponsored.json';
  });
  document.getElementById('bc-publish')?.addEventListener('click', async () => {
    const st = document.getElementById('bc-status');
    st.textContent = '⏳ Publishing...';
    const r = await api('/api/publish-config', 'POST', { config: bcBuild() }).catch(() => null);
    st.textContent = r?.success ? '✅ Live — all users update within 6h'
      : r?.error === 'NO_TOKEN' ? '⚠️ No GITHUB_TOKEN in .env — use Copy JSON'
      : '❌ ' + (r?.error || 'Failed');
  });
  bcRenderLists();


  document.getElementById('cc-add-btn')?.addEventListener('click', async () => {
    const inp = document.getElementById('cc-add-input');
    const st = document.getElementById('cc-add-status');
    const coin = (inp.value || '').toUpperCase().trim();
    if (!coin) return;
    st.textContent = 'Adding ' + coin + '...';
    const r = await api('/api/control', 'POST', { action: 'addCoin', type: currentCoinType, coin }).catch(() => null);
    if (r && r.added) {
      st.textContent = '✅ ' + coin + ' added to ' + currentCoinType + ' — scanner picks it up next run';
      inp.value = '';
      await refresh();
      renderCoinGrid();
    } else {
      st.textContent = '❌ ' + ((r && r.error) || 'Failed — 2-10 letters/numbers only');
    }
  });
  document.getElementById('cc-add-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('cc-add-btn').click(); });

  // Auto-login if valid token saved
  const saved = localStorage.getItem('dev_token') || window._token;
  if (saved) {
    token = saved;
    fetch('/api/stats', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => {
        if (r.ok) {
          document.getElementById('lock').style.display = 'none';
          document.getElementById('app').style.display = 'block';
          refresh();
          refreshTimer = setInterval(refresh, 8000);
        } else {
          // Bad token — clear it and show lock screen
          localStorage.removeItem('dev_token');
          token = '';
        }
      }).catch(() => {
        localStorage.removeItem('dev_token');
        token = '';
      });
  }
};
// button listeners now in window.onload
let _tiers = [];
async function loadTiers() {
  try {
    const r = await fetch('/api/tiers', { headers: {'Authorization':'Bearer '+token} });
    const d = await r.json();
    _tiers = d.tiers || [];
    renderTiers();
  } catch(e) {}
}
function renderTiers() {
  const el = document.getElementById('tier-list');
  if (!el) return;
  el.innerHTML = _tiers.map((t,i) => 
    '<div style="display:flex;gap:4px;align-items:center;background:rgba(15,23,42,.5);padding:5px;border-radius:7px;">' +
    '<input value="'+(t.emoji||'')+'" onchange="_tiers['+i+'].emoji=this.value" style="width:34px;text-align:center;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#fff;padding:5px;">' +
    '<input value="'+(t.name||'')+'" onchange="_tiers['+i+'].name=this.value" placeholder="Name" style="flex:1;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#fff;padding:5px;">' +
    '<input value="'+(t.xp||0)+'" type="number" onchange="_tiers['+i+'].xp=parseInt(this.value)||0" style="width:70px;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#fff;padding:5px;">' +
    '<input value="'+((t.unlocks||[]).join(','))+'" onchange="_tiers['+i+'].unlocks=this.value.split(\',\').map(s=>s.trim()).filter(Boolean)" placeholder="outfit:kimono,hair:long" style="flex:1.5;background:#1e293b;border:1px solid #334155;border-radius:5px;color:#fff;padding:5px;font-size:12px;">' +
    '<span onclick="_tiers.splice('+i+',1);renderTiers()" style="cursor:pointer;color:#ef4444;padding:0 5px;">✕</span></div>'
  ).join('');
}
function addTier() { _tiers.push({ level:_tiers.length+1, name:'New Tier', xp:(_tiers[_tiers.length-1]?.xp||0)+500, emoji:'⭐', unlocks:[] }); renderTiers(); }
async function saveTiers() {
  try {
    const r = await fetch('/api/tiers', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({ tiers:_tiers }) });
    const d = await r.json();
    document.getElementById('tier-msg').textContent = d.success ? '✅ Saved — applies live in the app' : '❌ '+(d.error||'failed');
    if (d.success) { _tiers = d.tiers; renderTiers(); }
  } catch(e) { document.getElementById('tier-msg').textContent = '❌ '+e.message; }
}
async function resetTiers() {
  const r = await fetch('/api/tiers-reset', { method:'POST', headers:{'Authorization':'Bearer '+token} });
  const d = await r.json();
  if (d.success) { _tiers = d.tiers; renderTiers(); document.getElementById('tier-msg').textContent = 'Reset to defaults'; }
}
async function addCosmetic() {
  const item = { id:document.getElementById('cos-id').value.trim(), name:document.getElementById('cos-name').value.trim(), price:parseInt(document.getElementById('cos-price').value)||0, asset:document.getElementById('cos-asset').value.trim()||null, limited:document.getElementById('cos-limited').checked };
  try {
    const r = await fetch('/api/add-cosmetic', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({ category:document.getElementById('cos-cat').value, item }) });
    const d = await r.json();
    document.getElementById('cos-msg').textContent = d.success ? '✅ Added to shop!' : '❌ '+(d.error||'failed');
  } catch(e) { document.getElementById('cos-msg').textContent = '❌ '+e.message; }
}

</script>
</body>
</html>`; }

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚙️  CRYPTO.AI Dev Panel');
  console.log('  → http://localhost:' + PORT);
  console.log('  → Password: Asuka2026!');
  console.log('');
});
process.on('uncaughtException', e => console.error('Dev server:', e.message));
