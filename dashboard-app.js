function setEl(id, prop, val){ const e=document.getElementById(id); if(e) e[prop]=val; return e }
function ipcTimeout(channel, arg, ms) {
  const p = arg !== undefined ? ipcRenderer.invoke(channel, arg) : ipcRenderer.invoke(channel)
  return Promise.race([p, new Promise(res => setTimeout(() => res(null), ms || 4000))]).catch(() => null)
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-src="' + src + '"]')) { resolve(); return }
    const s = document.createElement('script')
    s.src = src
    s.dataset.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed: ' + src))
    document.head.appendChild(s)
  })
}
async function ensurePixiLive2D() {
  if (window.PIXI?.live2d) return true
  try {
    await loadScript('./assets/live2dcubismcore.min.js')
    await loadScript('./node_modules/pixi.js/dist/browser/pixi.min.js')
    await loadScript('./node_modules/pixi-live2d-display/dist/cubism4.min.js')
    return !!window.PIXI?.live2d
  } catch (e) {
    console.error('Live2D scripts:', e)
    return false
  }
}

const levWarnings = {
  1: '1x — Spot trading, no liquidation risk',
  2: '2x — Low leverage, safe for beginners',
  5: '5x — Moderate leverage, manageable risk',
  10: '10x — High leverage, significant risk',
  20: '20x — Very high leverage, expert only',
  50: '50x — Extreme leverage, liquidation likely on small moves',
  100: '100x — Maximum risk, 1% move = liquidation',
  150: '150x — EXTREME — 0.67% move = liquidation'
}

// ipcRenderer is exposed globally by preload.js — do not redeclare here

let memory={}, settings={}, alerts=[], watchlist=[], trackedWallets=[], prices={}
let waifuModel=null, editApp=null, custApp=null

// ── Session ──
const h = new Date().getUTCHours()
{ const sb=document.getElementById('session-badge'); if(sb) sb.textContent = h<8?'Asia Session':h<16?'Europe Session':'US Session' }

// ── Audio ──
function chartAnalysisToggleEl() {
  return document.getElementById('tg-chart-analysis-toggle') || document.getElementById('chart-analysis-toggle')
}
async function playAudio(b64) {
  if (!b64 || window._autoSpeak === false) return
  try {
    const bytes = new Uint8Array(atob(b64).split('').map(c=>c.charCodeAt(0)))
    const blob = new Blob([bytes],{type:'audio/mpeg'})
    const ctx = new AudioContext()
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const src = ctx.createBufferSource()
    const an  = ctx.createAnalyser(); an.fftSize=256
    src.buffer=buf; src.connect(an); an.connect(ctx.destination); src.start()
    const arr = new Uint8Array(an.frequencyBinCount)
    const tick = () => {
      an.getByteFrequencyData(arr)
      const v = arr.reduce((a,b)=>a+b)/arr.length
      if (waifuModel) try { waifuModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY',Math.min(v/80,1)) } catch(e){}
      requestAnimationFrame(tick)
    }
    tick()
    return new Promise(r=>{ src.onended=()=>{ if(waifuModel) try{waifuModel.internalModel.coreModel.setParameterValueById('ParamMouthOpenY',0)}catch(e){} r() } })
  } catch(e){}
}

// ── Streaming Voice Chunk Handler ─────────────────────────────────────────
// Queue for sequential audio playback
let _audioQueue = []
let _isPlayingQueue = false
let _currentFullText = ''

async function processAudioQueue() {
  if (_isPlayingQueue) return
  _isPlayingQueue = true
  while (_audioQueue.length > 0) {
    const chunk = _audioQueue.shift()
    await playAudio(chunk.audio)
  }
  _isPlayingQueue = false
}

// Listen for streaming voice chunks from main process
ipcRenderer.on('voice-chunk', async (e, chunk) => {
  // Voice = activity: kill any idle dance instantly
  try { window._lastActivity = Date.now(); window._lastVoiceChunkAt = Date.now(); window._danceStop && window._danceStop() } catch(e2) {}
  // Safety: if ElevenLabs drops mid-stream and isLast never arrives, un-stick the flag
  try {
    clearTimeout(window._bisTimer)
    window._bisTimer = setTimeout(() => { botIsSpeaking = false }, 10000)
  } catch(e2) {}
  // Show text immediately on first chunk
  if (chunk.isFirst) {
    _currentFullText = ''
    botIsSpeaking = true
    setStatus && setStatus('"' + chunk.text.slice(0,50) + '..."')
  }
  _currentFullText += ' ' + chunk.text
  
  // Add to queue and process
  _audioQueue.push(chunk)
  processAudioQueue()
  
  // Update chat history when last chunk arrives
  if (chunk.isLast) {
    addToHistory && addToHistory('asuka', _currentFullText.trim())
    botIsSpeaking = false
  }
})

// Listen for text ready (shows immediately before audio)
ipcRenderer.on('voice-text-ready', (e, { reply }) => {
  if (reply) {
    setStatus && setStatus('"' + reply.slice(0,55) + '"')
  }
})

// ── Waifu: Live2D runs in dashboard-waifu.html iframe (keeps main dashboard JS alive) ──

// ── Load ──

// ── Page-1 wallet add (Trust Wallet / MetaMask / Phantom / other) ──
document.getElementById('p1-wallet-add')?.addEventListener('click', async () => {
  const addr = (document.getElementById('p1-wallet-addr')?.value || '').trim()
  const type = document.getElementById('p1-wallet-type')?.value || 'other'
  const msg = document.getElementById('p1-wallet-msg')
  const setMsg = (t, ok) => { if (msg) { msg.textContent = t; msg.style.color = ok ? 'var(--green)' : 'var(--red)' } }
  if (!addr) { setMsg('Paste an address first', false); return }
  const isEth = /^0x[a-fA-F0-9]{40}$/.test(addr)
  const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) && !addr.startsWith('0x')
  if (!isEth && !isSol) { setMsg('That doesn\'t look like a valid wallet address', false); return }
  const names = { trust: 'Trust Wallet', metamask: 'MetaMask', phantom: 'Phantom', other: 'Wallet' }
  try {
    const s = await ipcRenderer.invoke('get-settings').catch(()=>({})) || {}
    const tracked = Array.isArray(s.trackedWallets) ? s.trackedWallets : []
    if (tracked.some(w => (w.address||'').toLowerCase() === addr.toLowerCase())) { setMsg('Already added', false); return }
    tracked.push({ address: addr, label: `${names[type]} ${tracked.length+1}`, wallet: type, chain: isEth ? 'ETH' : 'SOL', addedAt: Date.now() })
    s.trackedWallets = tracked
    await ipcRenderer.invoke('save-settings', s)
    document.getElementById('p1-wallet-addr').value = ''
    setMsg('✓ Added — now tracking', true)
    loadPage1()
  } catch (e) { setMsg('Failed: ' + e.message, false) }
})


// ── 🔗 Connect modal ──
async function refreshConnStatus(){
  const st = await Promise.race([
    ipcRenderer.invoke('get-connection-status').catch(()=>null),
    new Promise(res => setTimeout(() => res(null), 5000))
  ])
  if (!st) { const bEl = document.getElementById('conn-binance-st'); if (bEl) { bEl.textContent = 'status unavailable'; } }
  const bEl = document.getElementById('conn-binance-st')
  if (bEl && st) { const c = st.binance==='connected'; bEl.textContent = c?'✓ Connected':(st.binance==='keys_saved_unverified'?'saved (unverified)':'not connected'); bEl.style.background = c?'rgba(52,211,153,0.15)':'var(--bg3)'; bEl.style.color = c?'var(--green)':'var(--text2)' }
  const msg = document.getElementById('conn-wmsg')
  const disc = document.getElementById('conn-w-disconnect')
  if (st && msg) {
    if (st.walletLive || st.wallet==='connected') {
      msg.style.color = 'var(--green)'
      msg.textContent = `✓ Live WC: ${(st.walletAddress||'').slice(0,6)}…${(st.walletAddress||'').slice(-4)}${st.walletProvider ? ' · ' + st.walletProvider : ''}`
      if (disc) disc.style.display = 'block'
    } else if (st.wallet==='linked') {
      msg.style.color = 'var(--gold)'
      msg.textContent = `Address linked (not live): ${(st.walletAddress||'').slice(0,6)}… — use WalletConnect above`
      if (disc) disc.style.display = 'block'
    }
  }
  // reflect on the pill
  const pill = document.getElementById('p1-conn-btn')
  if (pill && st) { const anyConn = st.binance==='connected' || st.wallet==='connected' || st.wallet==='linked'; pill.textContent = anyConn ? '🔗 Connected' : '🔗 Connect'; pill.style.color = anyConn?'var(--green)':'var(--accent)'; pill.style.background = anyConn?'rgba(52,211,153,0.12)':'rgba(45,212,255,0.12)' }
}
window.refreshConnStatus = refreshConnStatus
document.getElementById('p1-conn-btn')?.addEventListener('click', () => {
  document.getElementById('connect-modal').style.display='flex'
  document.body.style.cursor = 'default'
  refreshConnStatus()
})
document.getElementById('connect-close')?.addEventListener('click', () => {
  document.getElementById('connect-modal').style.display='none'
  document.body.style.cursor = 'default'
  ipcRenderer.invoke('walletconnect-cancel').catch(()=>{})
})
document.getElementById('connect-modal')?.addEventListener('click', (e)=>{
  if (e.target.id !== 'connect-modal') return
  e.target.style.display='none'
  document.body.style.cursor = 'default'
  ipcRenderer.invoke('walletconnect-cancel').catch(()=>{})
})
document.getElementById('conn-bsave')?.addEventListener('click', async () => {
  const msg = document.getElementById('conn-bmsg'); msg.style.color='var(--text2)'; msg.textContent='Connecting…'
  const r = await ipcRenderer.invoke('connect-binance', { apiKey: document.getElementById('conn-bkey').value.trim(), secret: document.getElementById('conn-bsecret').value.trim(), testnet: document.getElementById('conn-btestnet').checked }).catch(e=>({ok:false,error:e.message}))
  if (r?.ok && r.verified) { msg.style.color='var(--green)'; msg.textContent='✓ Connected! Balance: $'+r.balance }
  else if (r?.ok) { msg.style.color='var(--gold)'; msg.textContent='⚠️ '+(r.note||'saved but not verified') }
  else { msg.style.color='var(--red)'; msg.textContent='✗ '+(r?.error||'failed') }
  refreshConnStatus()
})
let _connProvider = 'metamask'
let _wcDeepLink = null
document.querySelectorAll('.conn-w-provider').forEach(b => b.onclick = () => {
  _connProvider = b.dataset.p
  document.querySelectorAll('.conn-w-provider').forEach(x=>x.style.borderColor='var(--border)')
  b.style.borderColor='var(--accent)'
  const msg = document.getElementById('conn-wmsg')
  if (msg) msg.innerHTML = `<span style="color:var(--text3)">Selected ${b.dataset.p==='metamask'?'MetaMask':'Trust'} — tap Connect with WalletConnect, then scan or Open in wallet.</span>`
})
document.getElementById('conn-wc-start')?.addEventListener('click', async () => {
  const msg = document.getElementById('conn-wmsg')
  const wrap = document.getElementById('conn-wc-qr-wrap')
  if (msg) { msg.style.color='var(--text2)'; msg.textContent='Starting WalletConnect…' }
  const r = await ipcRenderer.invoke('walletconnect-start', { provider: _connProvider }).catch(e=>({ok:false,error:e.message}))
  if (!r?.ok) {
    if (msg) {
      msg.style.color='var(--red)'
      msg.textContent = r?.error === 'missing_project_id' || r?.code === 'missing_project_id'
        ? (r.hint || 'Set WALLETCONNECT_PROJECT_ID in .env (cloud.reown.com)')
        : ('✗ ' + (r?.error || 'failed'))
    }
    return
  }
  _wcDeepLink = r.deepLink
  const img = document.getElementById('conn-wc-qr')
  if (img && r.qrDataUrl) img.src = r.qrDataUrl
  if (wrap) wrap.style.display = 'block'
  if (msg) { msg.style.color='var(--accent)'; msg.textContent='Scan the QR in your wallet app…' }
})
document.getElementById('conn-wc-open')?.addEventListener('click', () => {
  if (_wcDeepLink) ipcRenderer.invoke('open-url', _wcDeepLink).catch(()=>{})
})
document.getElementById('conn-wc-cancel')?.addEventListener('click', () => {
  document.body.style.cursor = 'default'
  const wrap = document.getElementById('conn-wc-qr-wrap')
  if (wrap) wrap.style.display = 'none'
  const msg = document.getElementById('conn-wmsg')
  if (msg) { msg.style.color='var(--text2)'; msg.textContent='Cancelled' }
  // fire-and-forget — never block the UI on WC teardown
  ipcRenderer.invoke('walletconnect-cancel').catch(()=>{})
})
ipcRenderer.on('walletconnect-connected', (e, snap) => {
  const wrap = document.getElementById('conn-wc-qr-wrap')
  if (wrap) wrap.style.display = 'none'
  const msg = document.getElementById('conn-wmsg')
  if (msg) {
    msg.style.color = 'var(--green)'
    msg.textContent = `✓ Live session: ${(snap?.address||'').slice(0,6)}…${(snap?.address||'').slice(-4)}${snap?.peer ? ' · ' + snap.peer : ''}`
  }
  refreshConnStatus()
})
ipcRenderer.on('walletconnect-error', (e, p) => {
  const msg = document.getElementById('conn-wmsg')
  if (msg) { msg.style.color='var(--red)'; msg.textContent='✗ ' + (p?.error || 'WalletConnect failed') }
})
ipcRenderer.on('walletconnect-disconnected', () => {
  refreshConnStatus()
  const msg = document.getElementById('conn-wmsg')
  if (msg) { msg.style.color='var(--text2)'; msg.textContent='Wallet disconnected' }
})
document.getElementById('conn-wsave')?.addEventListener('click', async () => {
  const msg = document.getElementById('conn-wmsg'); msg.style.color='var(--text2)'; msg.textContent='Linking…'
  const r = await ipcRenderer.invoke('connect-wallet', { address: document.getElementById('conn-waddr').value.trim(), provider: _connProvider }).catch(e=>({ok:false,error:e.message}))
  if (r?.ok) { msg.style.color='var(--gold)'; msg.textContent='✓ Address linked: '+r.address.slice(0,6)+'…'+r.address.slice(-4)+' (fallback — not live WC)' }
  else { msg.style.color='var(--red)'; msg.textContent='✗ '+(r?.error||'failed') }
  refreshConnStatus()
})
document.getElementById('conn-w-disconnect')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('disconnect-wallet').catch(()=>{})
  const wrap = document.getElementById('conn-wc-qr-wrap')
  if (wrap) wrap.style.display = 'none'
  refreshConnStatus()
  const msg = document.getElementById('conn-wmsg')
  if (msg) { msg.style.color='var(--text2)'; msg.textContent='Disconnected' }
})

function p1invoke(channel, ms){
  return Promise.race([
    ipcRenderer.invoke(channel).catch(()=>null),
    new Promise(res => setTimeout(() => res(null), ms || 5000))
  ])
}
// page-1 loads itself — never depends on anything else finishing
// (scheduled from dashAppFinishBoot — DOMContentLoaded may have already fired)

async function loadPage1() {
  // Portfolio total + P&L from paper stats + spot balances
  try {
    const stats = await p1invoke('get-paper-stats', 6000)
    if (stats) {
      const bal = Number(stats.balance ?? 0)
      setEl('p1-total','textContent', '$' + bal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))
      const tp = Number(stats.totalPnl ?? 0)
      const tpEl = document.getElementById('p1-totalpnl')
      if (tpEl) { tpEl.textContent = (tp>=0?'+':'') + '$' + tp.toFixed(0); tpEl.style.color = tp>=0?'var(--green)':'var(--red)' }
      const dp = Number(stats.todayPnl ?? stats.dayPnl ?? stats.totalPnl ?? 0)
      const dpEl = document.getElementById('p1-daypnl')
      if (dpEl) { dpEl.textContent = (dp>=0?'▲ +':'▼ ') + '$' + Math.abs(dp).toFixed(2) + ' today'; dpEl.style.color = dp>=0?'var(--green)':'var(--red)' }
      setEl('p1-winrate','textContent', (stats.winRate ?? 0) + '%')
      setEl('p1-open','textContent', String(stats.openCount ?? stats.openTrades ?? stats.open ?? (stats.trades? stats.trades.filter(t=>!t.closed).length : 0)))
    }
  } catch(e) {}

  // Market regime
  try {
    const mkt = await p1invoke('get-market-overview', 5000)
    if (mkt) { const r = mkt.regime || mkt.marketRegime || (mkt.fearGreed!=null ? (mkt.fearGreed<30?'Fear':mkt.fearGreed>70?'Greed':'Neutral') : '—'); setEl('p1-regime','textContent', r) }
  } catch(e) {}

  // Holdings from spot balances
  try {
    const b = await p1invoke('get-spot-balances', 6000)
    const list = (b && (b.balances || b.holdings || b)) || []
    const arr = Array.isArray(list) ? list.filter(h => Number(h.qty ?? h.free ?? h.amount ?? 0) > 0) : []
    const el = document.getElementById('p1-holdings')
    if (el) el.innerHTML = arr.length ? arr.slice(0,10).map(h => {
      const sym = (h.coin || h.asset || '?').toUpperCase()
      const qty = Number(h.qty ?? h.free ?? h.amount ?? 0)
      return `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border2);"><span style="font-weight:600;">${sym}</span><span style="font-family:'JetBrains Mono',monospace;color:var(--text2);">${qty.toPrecision(4)}</span></div>`
    }).join('') : '<div style="color:var(--text3);font-size:11px;">No holdings yet</div>'
  } catch(e) {}

  // Watchlist from price alerts
  try {
    const a = await p1invoke('get-price-alerts', 5000)
    const alerts = (a && (a.alerts || a)) || []
    const el = document.getElementById('p1-watchlist')
    if (el && Array.isArray(alerts)) el.innerHTML = alerts.length ? alerts.slice(0,12).map(al =>
      `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border2);"><span style="font-weight:600;">${(al.coin||al.symbol||'?').toUpperCase()}</span><span style="font-family:'JetBrains Mono',monospace;color:var(--text2);">$${Number(al.price??al.target??0).toLocaleString()}</span></div>`
    ).join('') : '<div style="color:var(--text3);font-size:11px;">No alerts set</div>'
  } catch(e) {}

  // if holdings never resolved, show empty-state instead of eternal Loading…
  { const el = document.getElementById('p1-holdings'); if (el && /Loading/.test(el.textContent)) el.innerHTML = '<div style="color:var(--text3);font-size:11px;">No holdings yet — connect Binance via 🔗</div>' }

  // Tracked wallets (from saved settings — Trust Wallet etc.)
  try {
    const s = await ipcRenderer.invoke('get-settings').catch(()=>null) || {}
    const wallets = Array.isArray(s.trackedWallets) ? s.trackedWallets : []
    const icons = { trust:'🛡️', metamask:'🦊', phantom:'👻', other:'🔗' }
    const el = document.getElementById('p1-wallets')
    if (el) el.innerHTML = wallets.length ? wallets.slice(0,10).map((wl,i) =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border2);"><div><div style="font-weight:600;font-size:11px;">${icons[wl.wallet]||'🔗'} ${wl.label||'Wallet'}</div><div style="font-family:'JetBrains Mono',monospace;color:var(--text3);font-size:10px;">${(wl.address||'').slice(0,6)}…${(wl.address||'').slice(-4)}</div></div><span class="p1-wdel" data-i="${i}" style="color:var(--text3);cursor:pointer;font-size:14px;padding:0 4px;">×</span></div>`
    ).join('') : '<div style="color:var(--text3);font-size:11px;">None tracked yet</div>'
    if (el) el.querySelectorAll('.p1-wdel').forEach(x => x.onclick = async () => {
      const s2 = await ipcRenderer.invoke('get-settings').catch(()=>({})) || {}
      const tw = Array.isArray(s2.trackedWallets) ? s2.trackedWallets : []
      tw.splice(parseInt(x.dataset.i), 1); s2.trackedWallets = tw
      await ipcRenderer.invoke('save-settings', s2); loadPage1()
    })
  } catch(e) {}
}

async function loadData() {
  try { loadPage1() } catch(e) { console.error("loadPage1:", e) }
  memory   = await ipcTimeout('get-memory')   || {}
  settings = await ipcTimeout('get-settings') || {}
  window._cachedMemory = memory
  window._cachedSettings = settings
  alerts   = await ipcTimeout('get-alerts')   || []
  watchlist = settings.watchlist || []
  trackedWallets = settings.trackedWallets || []
  setEl('waifu-name','textContent',settings.characterName || 'Asuka')
  try{renderAlerts()}catch(e){console.error('renderAlerts:',e)}
  try{renderTracked()}catch(e){console.error('renderTracked:',e)}
  try{await loadPrices()}catch(e){console.error('loadPrices:',e)}
  try{await loadPortfolio()}catch(e){console.error('loadPortfolio:',e)}
}

// ── Prices ──
async function loadPrices() {
  renderPrices()
  for (const coin of watchlist) {
    try {
      const txt = await ipcTimeout('get-crypto-price', coin, 6000)
      if (txt) {
        const pm=txt.match(/\$([\d,]+\.?\d*)/)
        const cm=txt.match(/(up|down) ([\d.]+)%/)
        if (pm) prices[coin]={price:pm[1], change:cm?parseFloat(cm[2])*(cm[1]==='down'?-1:1):0}
      }
    } catch(e){}
    renderPrices()
  }
}

function renderPrices() {
  const sec = document.getElementById('prices-section')
  if(!sec) return
  if (!watchlist.length) { sec.innerHTML='<div class="empty-state">Add coins above to track prices</div>'; return }
  sec.innerHTML = watchlist.map(coin=>{
    const p=prices[coin]
    if (p && window.pushHist) { const pv=parseFloat(String(p.price).replace(/,/g,'')); if (isFinite(pv)) window.pushHist(coin, pv) }
    const price = p?'$'+p.price:'—'
    const chg   = p?p.change:null
    const chgStr= chg!==null?(chg>=0?'+':'')+chg.toFixed(2)+'%':'—'
    const cls   = chg!==null?(chg>=0?'pos':'neg'):''
    const bell  = alerts.some(a=>a.coin===coin&&!a.triggered)
    return `<div class="price-row">
      <div class="p-sym">${coin.toUpperCase()}</div>
      <div class="p-price">${price}</div>
      <div class="p-spark" style="margin:0 6px;">${window.sparkSVG?window.sparkSVG(coin):''}</div>
      <div class="p-chg ${cls}">${chgStr}</div>
      <div class="p-bell ${bell?'active':''}" data-coin="${coin}">🔔</div>
      <div class="p-del" data-coin="${coin}">✕</div>
    </div>`
  }).join('')
  sec.querySelectorAll('.p-bell').forEach(b=>b.addEventListener('click',e=>{
    e.stopPropagation()
    setEl('alert-coin-input','value',b.dataset.coin.toUpperCase())
    document.getElementById('alert-price-input').focus()
  }))
  sec.querySelectorAll('.p-del').forEach(d=>d.addEventListener('click',async e=>{
    e.stopPropagation()
    watchlist=watchlist.filter(c=>c!==d.dataset.coin)
    settings.watchlist=watchlist
    await ipcRenderer.invoke('save-settings',settings)
    renderPrices()
  }))
}

document.getElementById('add-coin-btn')?.addEventListener('click',async()=>{
  const coin=document.getElementById('add-coin-input').value.trim().toLowerCase()
  if (!coin||watchlist.includes(coin)) return
  watchlist.push(coin); settings.watchlist=watchlist
  await ipcRenderer.invoke('save-settings',settings)
  setEl('add-coin-input','value','')
  await loadPrices()
})
document.getElementById('add-coin-input')?.addEventListener('keydown',e=>{ if(e.key==='Enter') document.getElementById('add-coin-btn').click() })

// ── Alerts ──
function renderAlerts() {
  const list=document.getElementById('alerts-list')
  if (!list) return
  const active=alerts.filter(a=>!a.triggered)
  if (!active.length) { list.innerHTML='<div style="padding:8px 14px;font-size:11px;color:var(--text3)">No active alerts</div>'; return }
  list.innerHTML=active.map(a=>`<div class="alert-row">
    <div class="al-sym">${a.coin.toUpperCase()}</div>
    <div class="al-info">${a.direction==='above'?'↑ above':'↓ below'} $${parseFloat(a.target).toLocaleString()}</div>
    <div class="al-del" data-id="${a.id}">✕</div>
  </div>`).join('')
  list.querySelectorAll('.al-del').forEach(d=>d.addEventListener('click',async()=>{
    alerts=alerts.filter(a=>a.id!==d.dataset.id)
    await ipcRenderer.invoke('save-alerts',alerts); renderAlerts()
  }))
}
document.getElementById('add-alert-btn')?.addEventListener('click',async()=>{
  const coin=document.getElementById('alert-coin-input').value.trim().toLowerCase()
  const price=document.getElementById('alert-price-input').value.trim()
  const dir=document.getElementById('alert-dir-select').value
  if (!coin||!price) return
  alerts.push({id:Date.now().toString(),coin,target:parseFloat(price),direction:dir,triggered:false})
  await ipcRenderer.invoke('save-alerts',alerts)
  setEl('alert-coin-input','value','')
  setEl('alert-price-input','value','')
  renderAlerts()
})

// ── Tracked wallets ──
function renderTracked() {
  const list=document.getElementById('tracked-list')
  if(!list) return
  if (!trackedWallets.length) { list.innerHTML='<div class="empty-state">Track any wallet to see their moves in real time</div>'; return }
  list.innerHTML=trackedWallets.map((w,i)=>`<div class="track-row" data-idx="${i}">
    <div class="track-avatar">👤</div>
    <div class="track-info">
      <div class="track-label">${w.label||'Wallet '+(i+1)}</div>
      <div class="track-addr">${w.address}</div>
    </div>
    <div class="track-grade" data-idx="${i}" title="Grade this wallet" style="cursor:pointer;font-size:13px;padding:0 4px;">🎓</div>
    <div class="track-copy ${w.copyMode==='paper'?'on':''}" data-idx="${i}" title="Paper copy-trade their buys" style="cursor:pointer;font-size:12px;padding:2px 7px;border-radius:8px;border:1px solid ${w.copyMode==='paper'?'var(--green)':'var(--border)'};color:${w.copyMode==='paper'?'var(--green)':'var(--text3)'};">📋</div>
    <div class="track-del" data-idx="${i}">✕</div>
  </div>`).join('')
  list.querySelectorAll('.track-row').forEach(r=>{
    r.addEventListener('click',e=>{ if(e.target.classList.contains('track-del')||e.target.classList.contains('track-grade')||e.target.classList.contains('track-copy')) return; openWalletDetail(trackedWallets[parseInt(r.dataset.idx)]) })
  })
  // 🎓 GMGN-style wallet grade
  list.querySelectorAll('.track-grade').forEach(g=>g.addEventListener('click',async e=>{
    e.stopPropagation()
    const w = trackedWallets[parseInt(g.dataset.idx)]
    g.textContent='⏳'
    const r = await ipcRenderer.invoke('grade-wallet',{ address:w.address, chain:'eth' }).catch(()=>null)
    g.textContent='🎓'
    if (!r || r.error) { alert(r?.error || 'Could not grade'); return }
    const colors={A:'var(--green)',B:'#7cc47f',C:'var(--gold)',D:'#ff9f0a',F:'var(--red)'}
    let m=document.getElementById('grade-modal'); if(m) m.remove()
    m=document.createElement('div'); m.id='grade-modal'
    m.style.cssText='position:fixed;inset:0;z-index:10005;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;'
    m.innerHTML=`<div style="width:330px;background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:22px;text-align:center;">
      <div style="font-size:44px;font-weight:800;color:${colors[r.grade]||'var(--text)'};">${r.grade}</div>
      <div style="font-size:12px;color:var(--text3);margin:4px 0 12px;">${w.label||'Wallet'}</div>
      <div style="display:flex;justify-content:space-around;font-size:12px;margin-bottom:12px;">
        <div><b style="font-size:15px;">${r.trades}</b><br><span style="color:var(--text3);">trades</span></div>
        <div><b style="font-size:15px;color:${r.realized>=0?'var(--green)':'var(--red)'};">${r.realized>=0?'+':''}$${r.realized}</b><br><span style="color:var(--text3);">realized</span></div>
        <div><b style="font-size:15px;">${r.winRate??'—'}%</b><br><span style="color:var(--text3);">win rate</span></div>
      </div>
      <div style="font-size:12px;line-height:1.5;color:var(--text2);background:var(--bg3);border-radius:10px;padding:10px;">🌸 ${r.verdict}</div>
      <button onclick="this.closest('#grade-modal').remove()" style="margin-top:14px;padding:9px 22px;border:none;border-radius:10px;background:var(--accent);color:#000;font-weight:700;cursor:pointer;font-size:12px;">Close</button>
    </div>`
    m.onclick=(ev)=>{ if(ev.target===m) m.remove() }
    document.body.appendChild(m)
  }))
  // 📋 paper copy-trade toggle
  list.querySelectorAll('.track-copy').forEach(cbtn=>cbtn.addEventListener('click',async e=>{
    e.stopPropagation()
    const w = trackedWallets[parseInt(cbtn.dataset.idx)]
    const next = w.copyMode==='paper' ? 'off' : 'paper'
    w.copyMode = next
    await ipcRenderer.invoke('set-wallet-copy',{ address:w.address, mode:next }).catch(()=>{})
    renderTracked()
  }))
  list.querySelectorAll('.track-del').forEach(d=>d.addEventListener('click',async e=>{
    e.stopPropagation()
    trackedWallets.splice(parseInt(d.dataset.idx),1)
    settings.trackedWallets=trackedWallets
    await ipcRenderer.invoke('save-settings',settings); renderTracked()
  }))
}
document.getElementById('add-track-btn')?.addEventListener('click',async()=>{
  const addr=document.getElementById('tracked-addr-input').value.trim()
  if (!addr) return
  // Detect chain and set auto label
  const isEth = addr.startsWith('0x')
  const label = `${isEth ? 'ETH' : 'SOL'} Wallet ${trackedWallets.length+1}`
  trackedWallets.push({address:addr, label, addedAt:Date.now()})
  settings.trackedWallets=trackedWallets
  await ipcRenderer.invoke('save-settings',settings)
  setEl('tracked-addr-input','value','')
  renderTracked()
})
function openWalletDetail(w) {
  setEl('wd-name','textContent',w.label||'Wallet')
  setEl('wd-addr','textContent',w.address.slice(0,8)+'…'+w.address.slice(-6))
  setEl('wd-body','innerHTML',`
    <div class="wd-stat"><div class="wd-stat-label">Address</div><div class="wd-stat-val" style="font-size:13px;font-weight:500">${w.address.slice(0,14)}…</div></div>
    <div class="wd-stat"><div class="wd-stat-label">Added</div><div class="wd-stat-val" style="font-size:14px">${new Date(w.addedAt).toLocaleDateString()}</div></div>
    <div class="wd-stat"><div class="wd-stat-label">Holdings</div><div class="wd-stat-val" style="font-size:13px;color:var(--text2)">Add Moralis API key in Settings to load holdings</div></div>
  `)
  document.getElementById('wallet-detail').classList.add('open')
}
document.getElementById('wd-back')?.addEventListener('click',()=>document.getElementById('wallet-detail').classList.remove('open'))

// Manage wallets
document.getElementById('manage-wallets-pill')?.addEventListener('click', () => {
  renderManageWallets()
  document.getElementById('manage-wallets-modal').style.display = 'flex'
})
document.getElementById('manage-wallets-close')?.addEventListener('click', () => {
  document.getElementById('manage-wallets-modal').style.display = 'none'
})

function renderManageWallets() {
  const wallets = settings.wallets || []
  const list = document.getElementById('manage-wallets-list')
  if(!list) return
  if (!wallets.length) {
    list.innerHTML = '<div style="color:var(--text2);font-size:13px;text-align:center;padding:20px;">No wallets added yet</div>'
    return
  }
  list.innerHTML = wallets.map((w, i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border2);">
      <div>
        <div style="font-size:13px;font-weight:600;">${w.label}</div>
        <div style="font-size:11px;color:var(--text2);">${w.chain?.toUpperCase()} • ${w.address?.slice(0,8)}...${w.address?.slice(-6)}</div>
      </div>
      <button onclick="removeWallet(${i})" style="background:rgba(255,69,58,0.15);border:1px solid rgba(255,69,58,0.3);color:#ff453a;padding:4px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;">Remove</button>
    </div>
  `).join('')
}

async function removeWallet(index) {
  settings.wallets.splice(index, 1)
  await ipcRenderer.invoke('save-settings', settings)
  renderManageWallets()
  await loadPortfolio()
}

// ── Add wallet modal ──
document.getElementById('add-wallet-pill')?.addEventListener('click',()=>document.getElementById('wallet-modal').classList.add('open'))
document.getElementById('wallet-modal-cancel')?.addEventListener('click',()=>document.getElementById('wallet-modal').classList.remove('open'))
document.getElementById('wallet-add-confirm')?.addEventListener('click',async()=>{
  const addr=document.getElementById('wallet-addr-input').value.trim()
  const chain=document.getElementById('wallet-chain-select').value
  const label=document.getElementById('wallet-label-input').value.trim()||'My Wallet'
  console.log('Add wallet clicked:', addr, chain, label)
  if (!addr) { console.log('No address'); return }
  settings.wallets = settings.wallets || []
  // Prevent duplicates
  if (settings.wallets.some(w => w.address.toLowerCase() === addr.toLowerCase())) {
    alert('This wallet is already added!')
    return
  }
  settings.wallets.push({address:addr,chain,label,addedAt:Date.now()})
  console.log('Saving settings with wallets:', settings.wallets.length)
  const result = await ipcRenderer.invoke('save-settings',settings)
  console.log('Save result:', result)
  document.getElementById('wallet-modal').classList.remove('open')
  setEl('wallet-addr-input','value','')
  setEl('wallet-label-input','value','')
  await loadPortfolio()
})

// ── Page Navigation ──
const pagesWrapper = document.getElementById('pages-wrapper')

// Map page numbers to element IDs
console.log('%cDASH BUILD 2026-07-22-fix4', 'color:#2dd4ff;font-weight:bold');
const PAGE_IDS = { 1: 'page-1', 2: 'page-7', 3: 'trading-page', 5: 'page-5', 6: 'page-6', 7: 'page-7', 8: 'page-8' }

function navigateToPage(pageNum) {
  document.querySelectorAll('.overlay').forEach(o => o.classList.remove('open'))
  document.querySelectorAll('.page-tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.page) === pageNum)
  })
  const pageId = PAGE_IDS[pageNum] || ('page-' + pageNum)
  document.querySelectorAll('.page').forEach(p => {
    const on = p.id === pageId
    p.classList.toggle('active', on)
    p.style.display = on ? 'flex' : 'none'
  })
  if (typeof window.moveTabGlider === 'function') window.moveTabGlider(pageNum)
  loadPageData(pageNum)
}
window.navigateToPage = navigateToPage

let _navLoadGen = 0
function loadPageData(pageNum) {
  const gen = ++_navLoadGen
  setTimeout(() => {
    if (gen !== _navLoadGen) return
    const active = document.querySelector('.page-tab.active')
    if (!active || parseInt(active.dataset.page, 10) !== pageNum) return
    if (pageNum === 2 || pageNum === 7) {
      const pane = document.querySelector('#callers-subnav .callers-tab.active')?.dataset?.callersTab || 'tg'
      if (pane !== 'advisors') loadTelegramUI().catch(() => {})
      if (pane === 'advisors' || pageNum === 7) {
        try { loadAdvisorTab() } catch (e) {}
        try { if (typeof renderLeaderboard === 'function') renderLeaderboard() } catch (e) {}
      }
    }
    if (pageNum === 3) { try { loadTradingUI() } catch(e) { console.error('loadTradingUI:', e) } }
    if (pageNum === 5) {
      const moreTab = document.querySelector('#others-subnav .others-tab.active')?.dataset?.othersTab || 'memory'
      if (typeof openMoreTab === 'function') openMoreTab(moreTab)
      if (typeof loadBooks === 'function') loadBooks().catch(() => {})
      if (typeof loadMemories === 'function') loadMemories().catch(() => {})
      if (typeof loadUsageStats === 'function') loadUsageStats().catch(() => {})
      restoreVoiceSettings().catch(() => {})
    }
    if (pageNum === 8) {
      if (typeof loadCustomizePage === 'function') loadCustomizePage().catch(() => {})
      else {
        try { window.loadHerTab?.() } catch (e) {}
        try { window.loadWallpapers?.() } catch (e) {}
        try { loadRules() } catch (e) {}
        try { loadRoutinesUI() } catch (e) {}
      }
      restoreVoiceSettings().catch(() => {})
    }
    if (pageNum === 6) loadWebsitePage().catch(() => {})
  }, 50)
}
window.loadPageData = loadPageData
window.loadTelegramUI = loadTelegramUI

// Tab clicks handled by dashboard.html early boot — do not bind here

function syncVisiblePageFromActiveTab() {
  const active = document.querySelector('.page-tab.active')
  const n = active ? parseInt(active.dataset.page, 10) : 1
  const pageId = PAGE_IDS[n] || ('page-' + n)
  document.querySelectorAll('.page').forEach(p => {
    const on = p.id === pageId
    p.classList.toggle('active', on)
    p.style.display = on ? 'flex' : 'none'
  })
  if (typeof window.moveTabGlider === 'function') window.moveTabGlider(n)
}
syncVisiblePageFromActiveTab()

// Update active tab on scroll
pagesWrapper?.addEventListener('scroll', () => {
  const pageNum = Math.round(pagesWrapper.scrollLeft / pagesWrapper.offsetWidth) + 1
  document.querySelectorAll('.page-tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.page) === pageNum)
  })
  if (typeof window.moveTabGlider === 'function') window.moveTabGlider(pageNum)
})

// ── Dot Trust Selector ──
function initDots() {
  document.querySelectorAll('.trust-dots').forEach(container => {
    const key = container.dataset.key
    let val = parseInt(container.dataset.val) || 5
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement('div')
      dot.className = `trust-dot ${i <= val ? 'filled' : ''}`
      dot.addEventListener('click', () => {
        val = i
        container.dataset.val = i
        container.querySelectorAll('.trust-dot').forEach((d, idx) => {
          d.classList.toggle('filled', idx < i)
        })
        const valEl = document.getElementById(`w-${key}`)
        if (valEl) valEl.textContent = `${i * 10}%`
        saveWeights()
      })
      container.appendChild(dot)
    }
  })
}

function saveWeights() {
  const weights = {}
  document.querySelectorAll('.trust-dots').forEach(c => {
    weights[c.dataset.key] = parseInt(c.dataset.val) * 10
  })
  ipcRenderer.send('save-weights', weights)
}

// ── Telegram UI ──
async function loadTelegramUI() {
  try {
    const connected = await Promise.race([
      ipcRenderer.invoke('telegram-status'),
      new Promise(r => setTimeout(() => r(false), 2500))
    ])
    const disc = document.getElementById('tg-disconnected')
    const code = document.getElementById('tg-code-section')
    const conn = document.getElementById('tg-connected-section')
    if (disc) disc.style.display = connected ? 'none' : 'block'
    if (code) code.style.display = 'none'
    if (conn) conn.style.display = connected ? 'block' : 'none'

    if (connected) {
      const stats = await Promise.race([
        ipcRenderer.invoke('telegram-get-stats'),
        new Promise(r => setTimeout(() => r(null), 2500))
      ])
      const settings = await Promise.race([
        ipcRenderer.invoke('get-settings'),
        new Promise(r => setTimeout(() => r({}), 2500))
      ]) || {}
      if (stats) {
        renderTgGroups(stats.groups)
        renderTgCallers(stats.callers, stats.stats)
      }
      renderIntelFeed()
      loadBotStatus().catch(() => {})
      loadTgAdminUI().catch(() => {})
      loadTgModUI().catch(() => {})

      if (settings?.tradeNotifications) document.getElementById('trade-notify-toggle')?.classList.add('on')
      if (settings?.intelNotifications) document.getElementById('intel-notify-toggle')?.classList.add('on')
      if (settings?.tgNotifyContact) setEl('tg-notify-contact','textContent',settings.tgNotifyContact)
      const chartEl = chartAnalysisToggleEl()
      if (chartEl) chartEl.classList.toggle('on', !!settings?.chartAnalysis)
      if (settings?.maxDrawdown) {
        setEl('tg-max-drawdown-input','value',settings.maxDrawdown)
        setEl('drawdown-hint','textContent',`Auto-close if trade loses more than ${settings.maxDrawdown}%`)
        const dh = document.getElementById('drawdown-hint')
        if (dh) dh.style.color = 'var(--red)'
      }
    } else {
      loadTgAdminUI().catch(() => {})
      loadBotStatus().catch(() => {})
      loadTgModUI().catch(() => {})
    }
  } catch(e) { console.error('loadTelegramUI:', e) }
}

async function loadTgAdminUI() {
  const st = await ipcRenderer.invoke('tg-admin-status').catch(() => null)
  const botEl = document.getElementById('tg-admin-bot-st')
  if (botEl) {
    if (!st?.botConfigured) botEl.textContent = '⚠️ TELEGRAM_BOT_TOKEN missing in .env'
    else if (st.bot) botEl.textContent = `Bot @${st.bot.username || st.bot.first_name} ready · ${st.managedGroups?.length || 0} group(s)`
    else botEl.textContent = `Bot token set but getMe failed: ${st.botError || 'error'}`
  }
  const list = document.getElementById('tg-admin-groups')
  const sel = document.getElementById('tg-admin-action-group')
  if (list) {
    const groups = st?.managedGroups || []
    if (!groups.length) list.innerHTML = '<div style="color:var(--text3);">No managed groups yet — register a chat id or message the group.</div>'
    else {
      list.innerHTML = groups.map(g => `
        <div class="tg-group-item" style="margin-bottom:6px;">
          <div>
            <div class="tg-group-name">${g.title || g.id}</div>
            <div class="tg-group-type">${g.type || 'group'} · ${g.id}</div>
          </div>
          <button class="tg-remove-btn tg-admin-default" data-id="${g.id}">Default</button>
          <button class="tg-remove-btn tg-admin-forget" data-id="${g.id}">Forget</button>
        </div>`).join('')
      list.querySelectorAll('.tg-admin-forget').forEach(b => b.onclick = async () => {
        await ipcRenderer.invoke('tg-admin-remove-group', { chatId: b.dataset.id })
        loadTgAdminUI()
      })
      list.querySelectorAll('.tg-admin-default').forEach(b => b.onclick = async () => {
        const s = await ipcRenderer.invoke('get-settings').catch(()=>({})) || {}
        s.telegramDefaultManageChatId = b.dataset.id
        await ipcRenderer.invoke('save-settings', s).catch(()=>{})
        const msg = document.getElementById('tg-admin-msg')
        if (msg) { msg.style.color='var(--green)'; msg.textContent='Default manage group set' }
      })
    }
  }
  if (sel) {
    const cur = sel.value
    sel.innerHTML = '<option value="">Select group</option>' + (st?.managedGroups || []).map(g =>
      `<option value="${g.id}">${(g.title || g.id).replace(/</g,'')}</option>`).join('')
    if (cur) sel.value = cur
  }
  const joins = document.getElementById('tg-admin-joins')
  if (joins) {
    const pending = st?.pendingJoins || []
    if (!pending.length) joins.innerHTML = '<div style="color:var(--text3);">None</div>'
    else {
      joins.innerHTML = pending.slice().reverse().slice(0, 12).map(j => `
        <div class="tg-group-item" style="margin-bottom:6px;">
          <div>
            <div class="tg-group-name">${j.name || j.username || j.userId}</div>
            <div class="tg-group-type">${j.chatTitle || j.chatId}</div>
          </div>
          <button class="tg-add-btn tg-join-ok" data-c="${j.chatId}" data-u="${j.userId}" style="padding:4px 8px;font-size:10px;">Approve</button>
          <button class="tg-remove-btn tg-join-no" data-c="${j.chatId}" data-u="${j.userId}">Decline</button>
        </div>`).join('')
      joins.querySelectorAll('.tg-join-ok').forEach(b => b.onclick = async () => {
        const r = await ipcRenderer.invoke('tg-admin-approve-join', { chatId: b.dataset.c, userId: Number(b.dataset.u) })
        const msg = document.getElementById('tg-admin-msg')
        if (msg) { msg.style.color = r?.ok ? 'var(--green)' : 'var(--red)'; msg.textContent = r?.ok ? 'Approved' : (r?.error || 'failed') }
        loadTgAdminUI()
      })
      joins.querySelectorAll('.tg-join-no').forEach(b => b.onclick = async () => {
        const r = await ipcRenderer.invoke('tg-admin-decline-join', { chatId: b.dataset.c, userId: Number(b.dataset.u) })
        const msg = document.getElementById('tg-admin-msg')
        if (msg) { msg.style.color = r?.ok ? 'var(--green)' : 'var(--red)'; msg.textContent = r?.ok ? 'Declined' : (r?.error || 'failed') }
        loadTgAdminUI()
      })
    }
  }
}
window.loadTgAdminUI = loadTgAdminUI

function setToggleEl(id, on) {
  const el = document.getElementById(id)
  if (!el) return
  el.classList.toggle('on', !!on)
}

async function loadTgModUI() {
  const r = await ipcRenderer.invoke('tg-group-mod-get').catch(() => null)
  const cfg = r?.config
  if (!cfg) return
  setToggleEl('tg-mod-enabled', cfg.enabled)
  setToggleEl('tg-mod-spam', cfg.autoSpam)
  setToggleEl('tg-mod-welcome', cfg.welcomeEnabled)
  setToggleEl('tg-mod-hype', cfg.hypeEnabled)
  document.querySelectorAll('.tg-mod-mode').forEach(b => {
    b.style.borderColor = b.dataset.m === cfg.mode ? 'var(--accent)' : 'var(--border)'
  })
  _tgModMode = cfg.mode || 'light'
  const max = document.getElementById('tg-mod-max'); if (max) max.value = cfg.maxRepliesPerHour
  const cd = document.getElementById('tg-mod-cd'); if (cd) cd.value = cfg.cooldownSec
  const hh = document.getElementById('tg-mod-hype-hrs'); if (hh) hh.value = cfg.hypeIntervalHours
  const mh = document.getElementById('tg-mod-mute-hrs'); if (mh) mh.value = cfg.autoMuteSpamHours
  const stats = document.getElementById('tg-mod-stats')
  if (stats && r.runtime) {
    const rows = (r.runtime.replyStats || []).map(x => `${x.chatId}: ${x.lastHour}/hr`).join(' · ')
    stats.textContent = `Bot @${r.runtime.botUsername || '?'} · mode ${cfg.mode}${rows ? ' · ' + rows : ''}`
  }
}

let _tgModMode = 'light'
document.getElementById('tg-mod-enabled')?.addEventListener('click', () => document.getElementById('tg-mod-enabled').classList.toggle('on'))
document.getElementById('tg-mod-spam')?.addEventListener('click', () => document.getElementById('tg-mod-spam').classList.toggle('on'))
document.getElementById('tg-mod-welcome')?.addEventListener('click', () => document.getElementById('tg-mod-welcome').classList.toggle('on'))
document.getElementById('tg-mod-hype')?.addEventListener('click', () => document.getElementById('tg-mod-hype').classList.toggle('on'))
document.querySelectorAll('.tg-mod-mode').forEach(b => b.addEventListener('click', () => {
  _tgModMode = b.dataset.m
  document.querySelectorAll('.tg-mod-mode').forEach(x => x.style.borderColor = 'var(--border)')
  b.style.borderColor = 'var(--accent)'
}))

document.getElementById('tg-mod-save')?.addEventListener('click', async () => {
  const patch = {
    enabled: document.getElementById('tg-mod-enabled')?.classList.contains('on'),
    autoSpam: document.getElementById('tg-mod-spam')?.classList.contains('on'),
    welcomeEnabled: document.getElementById('tg-mod-welcome')?.classList.contains('on'),
    hypeEnabled: document.getElementById('tg-mod-hype')?.classList.contains('on'),
    mode: _tgModMode || 'light',
    maxRepliesPerHour: parseInt(document.getElementById('tg-mod-max')?.value, 10) || 8,
    cooldownSec: parseInt(document.getElementById('tg-mod-cd')?.value, 10) || 50,
    hypeIntervalHours: parseInt(document.getElementById('tg-mod-hype-hrs')?.value, 10) || 6,
    autoMuteSpamHours: parseInt(document.getElementById('tg-mod-mute-hrs')?.value, 10) || 6,
  }
  const r = await ipcRenderer.invoke('tg-group-mod-set', patch).catch(e => ({ ok:false, error:e.message }))
  const msg = document.getElementById('tg-mod-msg')
  if (msg) { msg.style.color = r?.ok ? 'var(--green)' : 'var(--red)'; msg.textContent = r?.ok ? `Saved · ${r.config.mode} host` : (r?.error || 'failed') }
  loadTgModUI()
})

document.getElementById('tg-mod-hype-now')?.addEventListener('click', async () => {
  const chatId = document.getElementById('tg-admin-action-group')?.value || undefined
  const r = await ipcRenderer.invoke('tg-group-mod-hype-now', { chatId: chatId || undefined }).catch(e => ({ ok:false, error:e.message }))
  const msg = document.getElementById('tg-mod-msg')
  if (msg) {
    msg.style.color = (r?.ok || r?.posted > 0) ? 'var(--green)' : 'var(--red)'
    msg.textContent = r?.ok ? 'Hype posted' : (r?.posted != null ? `Posted ${r.posted}` : (r?.error || 'failed/cancelled'))
  }
})

document.getElementById('tg-admin-register')?.addEventListener('click', async () => {
  const chatId = document.getElementById('tg-admin-chat-id')?.value.trim()
  const msg = document.getElementById('tg-admin-msg')
  const r = await ipcRenderer.invoke('tg-admin-register-group', { chatId }).catch(e => ({ ok:false, error:e.message }))
  if (msg) { msg.style.color = r?.ok ? 'var(--green)' : 'var(--red)'; msg.textContent = r?.ok ? `Registered ${r.group?.title || chatId}` : (r?.error || 'failed') }
  if (r?.ok) loadTgAdminUI()
})

document.getElementById('tg-admin-run')?.addEventListener('click', async () => {
  const chatId = document.getElementById('tg-admin-action-group')?.value
  const action = document.getElementById('tg-admin-action')?.value
  const arg = document.getElementById('tg-admin-action-arg')?.value.trim()
  const msg = document.getElementById('tg-admin-msg')
  if (!chatId) { if (msg) { msg.style.color='var(--red)'; msg.textContent='Select a group'; } return }
  let r
  if (action === 'post') r = await ipcRenderer.invoke('tg-admin-post', { chatId, text: arg, pin: false })
  else if (action === 'kick') r = await ipcRenderer.invoke('tg-admin-kick', { chatId, username: arg, userId: /^\d+$/.test(arg) ? Number(arg) : undefined })
  else if (action === 'ban') r = await ipcRenderer.invoke('tg-admin-ban', { chatId, username: arg, userId: /^\d+$/.test(arg) ? Number(arg) : undefined })
  else if (action === 'mute') r = await ipcRenderer.invoke('tg-admin-mute', { chatId, username: arg, userId: /^\d+$/.test(arg) ? Number(arg) : undefined, hours: 24 })
  else if (action === 'title') r = await ipcRenderer.invoke('tg-admin-set-title', { chatId, title: arg })
  else if (action === 'desc') r = await ipcRenderer.invoke('tg-admin-set-description', { chatId, description: arg })
  if (msg) {
    msg.style.color = r?.ok ? 'var(--green)' : 'var(--red)'
    msg.textContent = r?.ok ? 'Done' : (r?.error || r?.hint || 'failed')
  }
  loadTgAdminUI()
})

function renderTgGroups(groups) {
  const list = document.getElementById('tg-groups-list')
  if(!list) return
  if (!groups?.length) { list.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No groups added yet</div>'; return }
  list.innerHTML = groups.map(g => `
    <div class="tg-group-item">
      <div>
        <div class="tg-group-name">${g.name}</div>
        <div class="tg-group-type">${g.type}</div>
      </div>
      <button class="tg-remove-btn" onclick="removeGroup(${g.id})">Remove</button>
    </div>
  `).join('')
}

function renderTgCallers(callers, stats) {
  const list = document.getElementById('tg-tracked-callers-list') || document.getElementById('tg-callers-list')
  if (!list) return
  if (!callers?.length) { list.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No callers tracked yet</div>'; return }
  list.innerHTML = callers.map(c => {
    const s = stats?.[c] || { winRate: 0, total: 0 }
    const rateClass = s.winRate >= 65 ? 'win-rate-good' : s.winRate >= 45 ? 'win-rate-ok' : 'win-rate-bad'
    return `
    <div class="caller-item">
      <div>
        <div class="caller-name">${c}</div>
        <div class="caller-stats ${rateClass}">${s.winRate}% win rate • ${s.total} calls</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div>
          <div style="font-size:10px;color:var(--text2);margin-bottom:4px;">Trust</div>
          <div class="trust-dots" data-key="caller_${c}" data-val="8"></div>
        </div>
        <button class="tg-remove-btn" onclick="removeCaller('${c}')">Unfollow</button>
      </div>
    </div>`
  }).join('')
  // Re-init dots for callers
  document.querySelectorAll('.caller-item .trust-dots').forEach(container => {
    const val = parseInt(container.dataset.val) || 8
    for (let i = 1; i <= 10; i++) {
      const dot = document.createElement('div')
      dot.className = `trust-dot ${i <= val ? 'filled' : ''}`
      dot.addEventListener('click', () => {
        container.dataset.val = i
        container.querySelectorAll('.trust-dot').forEach((d, idx) => d.classList.toggle('filled', idx < i))
      })
      container.appendChild(dot)
    }
  })
}

function renderTgSignals(signals) {
  const list = document.getElementById('tg-signals-list')
  if(!list) return
  if (!signals?.length) { list.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No signals detected yet</div>'; return }
  list.innerHTML = signals.slice(-10).reverse().map(s => {
    const statusClass = s.status === 'win' ? 'won' : s.status === 'loss' ? 'lost' : ''
    const dirClass = s.direction === 'long' ? 'signal-direction-long' : 'signal-direction-short'
    const time = new Date(s.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    return `
    <div class="signal-item ${statusClass}">
      <div class="signal-header">
        <span class="signal-coin">${s.coin} <span class="${dirClass}">${s.direction?.toUpperCase()}</span></span>
        <span class="signal-confidence">${s.confidence}%</span>
      </div>
      <div class="signal-details">Entry: $${s.entry} → Target: $${s.target} | SL: $${s.stopLoss}</div>
      <div class="signal-caller">@${s.caller} • ${time} • ${s.groupName}</div>
    </div>`
  }).join('')
}

async function removeGroup(id) {
  await ipcRenderer.invoke('telegram-remove-group', id)
  loadTelegramUI()
}

async function removeCaller(caller) {
  const stats = await ipcRenderer.invoke('telegram-get-stats')
  const td = { ...stats, trackedCallers: stats.trackedCallers.filter(c => c !== caller) }
  // Update via IPC
  loadTelegramUI()
}

// Connect Telegram — Step 1: Send phone
document.getElementById('tg-connect-btn')?.addEventListener('click', async () => {
  const phone = document.getElementById('tg-phone').value.trim()
  if (!phone) return
  setEl('tg-connect-btn','textContent','Sending code...')
  document.getElementById('tg-connect-btn').disabled = true
  // Show code section immediately — backend will send code to phone
  ipcRenderer.invoke('telegram-connect', phone)
  // Show code input right away
  setTimeout(() => {
    document.getElementById('tg-disconnected').style.display = 'none'
    document.getElementById('tg-code-section').style.display = 'block'
  }, 1000)
})

// Listen for code request from backend
ipcRenderer.on('telegram-needs-code', () => {
  document.getElementById('tg-disconnected').style.display = 'none'
  document.getElementById('tg-code-section').style.display = 'block'
})

// Step 2: Submit code
document.getElementById('tg-verify-btn')?.addEventListener('click', async () => {
  const code = document.getElementById('tg-code').value.trim()
  if (!code) return
  setEl('tg-verify-btn','textContent','Connecting...')
  document.getElementById('tg-verify-btn').disabled = true
  ipcRenderer.send('telegram-code', code)
  // Wait and check if connected
  setTimeout(async () => {
    const connected = await ipcRenderer.invoke('telegram-status')
    if (connected) {
      loadTelegramUI()
    } else {
      setEl('tg-verify-btn','textContent','Verify Code')
      document.getElementById('tg-verify-btn').disabled = false
      alert('Could not connect — check the code and try again')
    }
  }, 4000)
})

// Telegram Bot Authentication
async function loadBotStatus() {
  const settings = await ipcRenderer.invoke('get-settings')
  if (settings?.telegramBotChatId) {
    document.getElementById('bot-not-connected').style.display = 'none'
    document.getElementById('bot-connected').style.display = 'block'
  }
}

document.getElementById('bot-connect-btn')?.addEventListener('click', async () => {
  const code = document.getElementById('bot-auth-code').value.trim().toUpperCase()
  if (!code || code.length < 8) {
    setEl('bot-auth-error','textContent','Enter the full code (e.g. ASK-1234)')
    document.getElementById('bot-auth-error').style.display = 'block'
    return
  }
  
  const result = await ipcRenderer.invoke('authenticate-bot', code)
  if (result.success) {
    document.getElementById('bot-not-connected').style.display = 'none'
    document.getElementById('bot-connected').style.display = 'block'
    document.getElementById('bot-auth-error').style.display = 'none'
  } else {
    setEl('bot-auth-error','textContent',result.error || 'Invalid code — try again')
    document.getElementById('bot-auth-error').style.display = 'block'
  }
})

document.getElementById('bot-disconnect-btn')?.addEventListener('click', async () => {
  const settings = await ipcRenderer.invoke('get-settings')
  settings.telegramBotChatId = null
  await ipcRenderer.invoke('save-settings', settings)
  document.getElementById('bot-connected').style.display = 'none'
  document.getElementById('bot-not-connected').style.display = 'block'
  setEl('bot-auth-code','value','')
})

// Change notification contact
document.getElementById('tg-change-contact')?.addEventListener('click', () => {
  const form = document.getElementById('tg-contact-form')
  if(!form) return
  form.style.display = form.style.display === 'none' ? 'flex' : 'none'
})

document.getElementById('tg-save-contact-btn')?.addEventListener('click', () => {
  const contact = document.getElementById('tg-contact-input').value.trim()
  if (!contact) return
  setEl('tg-notify-contact','textContent',contact)
  document.getElementById('tg-contact-form').style.display = 'none'
  setEl('tg-contact-input','value','')
  ipcRenderer.send('set-setting', 'tgNotifyContact', contact)
})

// Disconnect
document.getElementById('tg-disconnect-btn')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('telegram-disconnect')
  loadTelegramUI()
})

// Add group
document.getElementById('tg-add-group-btn')?.addEventListener('click', async () => {
  const picker = document.getElementById('tg-group-picker')
  if(!picker) return
  picker.style.display = picker.style.display === 'none' ? 'block' : 'none'
  if (picker.style.display === 'block') {
    const groups = await ipcRenderer.invoke('telegram-get-groups')
    const avail = document.getElementById('tg-available-groups')
    if(!avail) return
    avail.innerHTML = groups.map(g => `
      <div class="tg-group-item" style="cursor:pointer" onclick="addGroup(${JSON.stringify(g).replace(/"/g, '&quot;')})">
        <div>
          <div class="tg-group-name">${g.name}</div>
          <div class="tg-group-type">${g.type}</div>
        </div>
        <span style="color:var(--accent);font-size:12px;">+ Add</span>
      </div>
    `).join('') || '<div style="color:var(--text2);font-size:13px;padding:10px">No groups found</div>'
  }
})

async function addGroup(group) {
  await ipcRenderer.invoke('telegram-add-group', group)
  document.getElementById('tg-group-picker').style.display = 'none'
  loadTelegramUI()
}

// Add caller
document.getElementById('tg-add-caller-btn')?.addEventListener('click', () => {
  document.getElementById('tg-add-caller-form').style.display = 'block'
})
document.getElementById('tg-cancel-caller-btn')?.addEventListener('click', () => {
  document.getElementById('tg-add-caller-form').style.display = 'none'
})
document.getElementById('tg-save-caller-btn')?.addEventListener('click', async () => {
  const caller = document.getElementById('tg-caller-input').value.trim()
  if (!caller) return
  await ipcRenderer.invoke('telegram-add-caller', caller.startsWith('@') ? caller : '@' + caller)
  document.getElementById('tg-add-caller-form').style.display = 'none'
  setEl('tg-caller-input','value','')
  loadTelegramUI()
})

async function closeTrade(tradeId, currentPrice) {
  if (!confirm('Close this trade at current price?')) return
  await ipcRenderer.invoke('close-paper-trade', tradeId, currentPrice)
  loadTradingUI()
}

// Confidence threshold control
const confWarnings = {
  1: { type: 'warning', msg: '⚠️ 10% threshold — She will trade on almost any signal. Very risky.' },
  2: { type: 'warning', msg: '⚠️ 20% threshold — Very aggressive. High frequency, high risk.' },
  3: { type: 'notice', msg: '⚡ 30% threshold — Aggressive trading. Suitable for testing only.' },
  4: { type: 'notice', msg: '⚡ 40% threshold — Active trading. Moderate risk.' },
  5: { type: null, msg: null },
  6: { type: null, msg: null },
  7: { type: null, msg: null },
  8: { type: null, msg: null },
  9: { type: null, msg: null },
  10: { type: null, msg: '✅ 100% threshold — Almost never trades. Only the highest conviction setups.' }
}

// Override dot behavior for confidence threshold
document.querySelector('.trust-dots[data-key="tradeThreshold"]')?.addEventListener('click', (e) => {
  if (!e.target.classList.contains('trust-dot')) return
  const container = e.target.closest('.trust-dots')
  const dots = container.querySelectorAll('.trust-dot')
  const idx = Array.from(dots).indexOf(e.target) + 1
  
  dots.forEach((d, i) => d.classList.toggle('filled', i < idx))
  container.dataset.val = idx
  
  const pct = idx * 10
  setEl('conf-threshold-val','textContent',`${pct}%`)
  ipcRenderer.send('set-setting', 'paperTradeThreshold', pct)
  ipcRenderer.send('set-setting', 'independentScanThreshold', pct)
  
  // Update display
  const mainDisp = document.getElementById('main-threshold-display')
  if(!mainDisp) return
  if (mainDisp) mainDisp.textContent = `${pct}%`

  const warning = confWarnings[idx]
  const warningEl = document.getElementById('conf-warning')
  if(!warningEl) return
  if (warning?.msg) {
    warningEl.textContent = warning.msg
    warningEl.className = warning.type === 'warning' ? 'conf-warning-box' : 'conf-notice-box'
    warningEl.style.display = 'block'
  } else {
    warningEl.style.display = 'none'
  }
})

// Auto/Manual toggle
document.getElementById('conf-manual-btn')?.addEventListener('click', () => {
  document.getElementById('conf-manual-btn').classList.add('active')
  document.getElementById('conf-auto-btn').classList.remove('active')
  document.getElementById('conf-manual-section').style.display = 'block'
  document.getElementById('conf-auto-section').style.display = 'none'
  ipcRenderer.send('set-setting', 'autoThreshold', false)
})

document.getElementById('conf-auto-btn')?.addEventListener('click', async () => {
  document.getElementById('conf-auto-btn').classList.add('active')
  document.getElementById('conf-manual-btn').classList.remove('active')
  document.getElementById('conf-manual-section').style.display = 'none'
  document.getElementById('conf-auto-section').style.display = 'block'
  ipcRenderer.send('set-setting', 'autoThreshold', true)
  // Calculate current auto threshold
  const autoThreshold = await ipcRenderer.invoke('get-auto-threshold')
  setEl('auto-threshold-display','textContent',`Current auto threshold: ${autoThreshold}%`)
})

// Restore confidence settings
async function restoreConfidenceSettings() {
  const settings = await ipcRenderer.invoke('get-settings')
  if (settings?.autoThreshold) {
    document.getElementById('conf-auto-btn')?.click()
  } else {
    const threshold = settings?.paperTradeThreshold || 60
    const dotVal = Math.round(threshold / 10)
    const container = document.querySelector('.trust-dots[data-key="tradeThreshold"]')
    if (container) {
      container.dataset.val = dotVal
      container.querySelectorAll('.trust-dot').forEach((d, i) => d.classList.toggle('filled', i < dotVal))
      if (document.getElementById('conf-threshold-val')) setEl('conf-threshold-val','textContent',`${threshold}%`)
    }
  }

  // Restore TP/SL settings
  if (settings?.tpSlMode) {
    showTpSlPanel(settings.tpSlMode)
  }

  // Restore main leverage buttons
  if (settings?.paperLeverage) {
    document.querySelectorAll('.lev-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.lev) === settings.paperLeverage)
    })
    const warn = document.getElementById('lev-warning')
    if(!warn) return
    if (warn) warn.textContent = levWarnings[settings.paperLeverage] || ''
  }

  // Restore scalp indicators
  const scalpInds = settings?.scalpIndicators || {}
  Object.entries({ 'scalp-rsi-toggle': 'rsi', 'scalp-bb-toggle': 'bb', 'scalp-sr-toggle': 'sr', 'scalp-ob-toggle': 'ob' }).forEach(([id, key]) => {
    const el = document.getElementById(id)
    if (!el) return
    if (scalpInds[key] === false) el.classList.remove('on')
    else el.classList.add('on')
  })

  // Restore TA indicators
  const taInds = settings?.enabledIndicators || {}
  Object.entries({ 'ta-rsi-toggle': 'rsi', 'ta-ma-toggle': 'ma', 'ta-macd-toggle': 'macd', 'ta-bb-toggle': 'bb', 'ta-sr-toggle': 'sr', 'ta-ob-toggle': 'ob', 'ta-corr-toggle': 'corr', 'ta-time-toggle': 'time', 'ta-ichimoku-toggle': 'ichimoku', 'ta-atr-toggle': 'atr', 'ta-vwap-toggle': 'vwap', 'ta-stochrsi-toggle': 'stochRsi', 'ta-emacross-toggle': 'emaCross', 'ta-fundingextreme-toggle': 'fundingExtreme', 'ta-pivots-toggle': 'pivots' }).forEach(([id, key]) => {
    const el = document.getElementById(id)
    if (!el) return
    if (taInds[key] === false) el.classList.remove('on')
    else el.classList.add('on')
  })
  if (settings?.taMode === 'manual') {
    document.getElementById('ta-manual-btn')?.classList.add('active')
    document.getElementById('ta-auto-btn')?.classList.remove('active')
    document.getElementById('ta-manual-panel').style.display = 'block'
  }
  if (settings?.tpSlRatio) {
  // Restore RSI period
  if (settings?.rsiPeriod) {
    document.querySelectorAll('.rsi-period-btn').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.val) === settings.rsiPeriod)
    )
  }
  // Restore Ichimoku settings
  if (settings?.ichimokuTenkan) document.querySelectorAll('.ichi-tenkan-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val) === settings.ichimokuTenkan))
  if (settings?.ichimokuKijun) document.querySelectorAll('.ichi-kijun-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val) === settings.ichimokuKijun))
  if (settings?.ichimokuSenkouB) document.querySelectorAll('.ichi-senkou-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val) === settings.ichimokuSenkouB))
    document.querySelectorAll('.ratio-btn').forEach(b => {
      b.classList.toggle('active', parseFloat(b.dataset.ratio) === settings.tpSlRatio)
    })
    setEl('ratio-preview','textContent',`Example: SL 1% → TP ${settings.tpSlRatio}%`)
  }
  if (settings?.customTpPct) setEl('custom-tp-input','value',settings.customTpPct)
  if (settings?.customSlPct) setEl('custom-sl-input','value',settings.customSlPct)

  if (settings?.maxScalpTrades) {
    document.querySelectorAll('.scalp-max-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.val) === settings.maxScalpTrades)
    })
  }

  // Restore scalp threshold
  const scalpThreshold = settings?.scalpThreshold || 45
  const scalpDotVal = Math.round(scalpThreshold / 10)
  const scalpContainer = document.querySelector('.trust-dots[data-key="scalpThreshold"]')
  if (scalpContainer) {
    scalpContainer.dataset.val = scalpDotVal
    scalpContainer.querySelectorAll('.trust-dot').forEach((d, i) => d.classList.toggle('filled', i < scalpDotVal))
    if (document.getElementById('scalp-threshold-val')) setEl('scalp-threshold-val','textContent',`${scalpThreshold}%`)
  }

  // Update displays
  const mainDisp = document.getElementById('main-threshold-display')
  if(!mainDisp) return
  const scalpDisp = document.getElementById('scalp-threshold-display')
  if(!scalpDisp) return
  const mainThreshold = settings?.paperTradeThreshold || 60
  if (mainDisp) mainDisp.textContent = `${mainThreshold}%`
  if (scalpDisp) scalpDisp.textContent = `${scalpThreshold}%`
}

// ── Coin Selectors (separate per trade type) ─────────────────────────────

const coinState = {
  main:  { selected: ['BTC','ETH','SOL'], custom: [] },
  day:   { selected: ['BTC','ETH','SOL'], custom: [] },
  scalp: { selected: ['BTC','ETH','SOL'], custom: [] },
}

const FREE_COIN_LIMIT = 999

function setupCoinSelector(prefix, settingKey) {
  function updateCounter() {
    const counter = document.getElementById(`${prefix}-coin-counter`)
    if (counter) counter.textContent = `${coinState[prefix].selected.length}/999 coins`
  }

  function renderCustom() {
    const list = document.getElementById(`${prefix}-custom-coins-list`)
    if (!list) return
    list.innerHTML = coinState[prefix].custom.map(coin => `
      <div style="display:flex;align-items:center;gap:3px;background:rgba(0,212,255,0.15);border:1px solid rgba(0,212,255,0.3);border-radius:6px;padding:3px 8px;">
        <span style="font-size:11px;font-weight:600;">${coin}</span>
        <button onclick="removeCustomCoin('${prefix}','${coin}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;padding:0 0 0 4px;">✕</button>
      </div>`).join('')
  }

  function toggleCoin(coin, btn) {
    const sel = coinState[prefix].selected
    if (sel.includes(coin)) {
      if (sel.length <= 1) return
      coinState[prefix].selected = sel.filter(c => c !== coin)
      btn.classList.remove('active')
    } else {
      coinState[prefix].selected.push(coin)
      btn.classList.add('active')
    }
    ipcRenderer.send('set-setting', settingKey, coinState[prefix].selected)
    updateCounter()
  }

  // Bind buttons
  document.querySelectorAll(`.${prefix}-coin-btn`).forEach(btn => {
    btn.addEventListener('click', () => toggleCoin(btn.dataset.coin, btn))
  })

  // Add custom coin
  document.getElementById(`${prefix}-add-coin-btn`)?.addEventListener('click', () => {
    const input = document.getElementById(`${prefix}-custom-coin-input`)
    const coin = input?.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!coin) return
    if (!coinState[prefix].custom.includes(coin)) {
      coinState[prefix].custom.push(coin)
      coinState[prefix].selected.push(coin)
      ipcRenderer.send('set-setting', settingKey, coinState[prefix].selected)
      ipcRenderer.send('set-setting', `${settingKey}Custom`, coinState[prefix].custom)
      renderCustom()
      updateCounter()
    }
    if (input) input.value = ''
  })

  document.getElementById(`${prefix}-custom-coin-input`)?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById(`${prefix}-add-coin-btn`)?.click()
  })

  updateCounter()
  renderCustom()
}



// Initialize all 3 selectors (deferred — don't block first paint)
setTimeout(function() {
  setupCoinSelector('main', 'tradingCoins');
  setupCoinSelector('day', 'dayTradeCoins');
  setupCoinSelector('scalp', 'scalpCoins');
}, 0);

// Restore coin selections from settings
async function restoreCoinSelections(settings) {
  const restore = (prefix, settingKey, defaultCoins) => {
    const saved = settings?.[settingKey] || defaultCoins
    const savedCustom = settings?.[`${settingKey}Custom`] || []
    coinState[prefix].selected = saved
    coinState[prefix].custom = savedCustom

    // Update button states
    document.querySelectorAll(`.${prefix}-coin-btn`).forEach(btn => {
      btn.classList.toggle('active', saved.includes(btn.dataset.coin))
    })

    // Update counter
    const counter = document.getElementById(`${prefix}-coin-counter`)
    if (counter) counter.textContent = `${saved.length}/999 coins`

    // Render custom
    const list = document.getElementById(`${prefix}-custom-coins-list`)
    if (list && savedCustom.length) {
      list.innerHTML = savedCustom.map(coin => `
        <div style="display:flex;align-items:center;gap:3px;background:rgba(0,212,255,0.15);border:1px solid rgba(0,212,255,0.3);border-radius:6px;padding:3px 8px;">
          <span style="font-size:11px;font-weight:600;">${coin}</span>
          <button onclick="removeCustomCoin('${prefix}','${coin}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;padding:0 0 0 4px;">✕</button>
        </div>`).join('')
    }
  }

  restore('main', 'tradingCoins', ['BTC','ETH','SOL'])
  restore('day', 'dayTradeCoins', ['BTC','ETH','SOL'])
  restore('scalp', 'scalpCoins', ['BTC','ETH','SOL'])
}

// Legacy compat

let selectedCoins = coinState.main.selected
let customCoins = coinState.main.custom

// ── Daily Loss Limit ─────────────────────────────────────────────────────
document.querySelectorAll('.daily-loss-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.daily-loss-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'dailyLossLimit', parseFloat(this.dataset.val))
  })
})
document.getElementById('save-loss-limit-btn')?.addEventListener('click', () => {
  const val = parseFloat(document.getElementById('custom-loss-limit').value)
  if (val > 0) {
    document.querySelectorAll('.daily-loss-btn').forEach(b => b.classList.remove('active'))
    ipcRenderer.send('set-setting', 'dailyLossLimit', val)
    document.getElementById('custom-loss-limit').style.borderColor = 'var(--green)'
    setTimeout(() => document.getElementById('custom-loss-limit').style.borderColor = '', 1000)
  }
})

// ── Max Positions ────────────────────────────────────────────────────────
document.querySelectorAll('.max-pos-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.max-pos-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'maxOpenPositions', parseInt(this.dataset.val))
  })
})

// ── Trading Control ──────────────────────────────────────────────────────
document.getElementById('pause-trading-btn')?.addEventListener('click', async () => {
  ipcRenderer.send('pause-trading', 60)
  setEl('trading-status','textContent','⏸️ Trading Paused (1 hour)')
  document.getElementById('trading-status').style.color = 'var(--red)'
})
document.getElementById('resume-trading-btn')?.addEventListener('click', () => {
  ipcRenderer.send('resume-trading')
  setEl('trading-status','textContent','✅ Trading Active')
  document.getElementById('trading-status').style.color = 'var(--green)'
})

// ── DCA Plans ────────────────────────────────────────────────────────────
let dcaInterval = 'weekly'
document.querySelectorAll('.dca-interval-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.dca-interval-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    dcaInterval = this.dataset.val
  })
})

document.getElementById('add-dca-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('dca-coin').value
  const amount = parseFloat(document.getElementById('dca-amount').value)
  if (!amount || amount <= 0) return
  ipcRenderer.send('save-dca-plan', { coin, amount, interval: dcaInterval, enabled: true })
  setEl('dca-amount','value','')
  setTimeout(loadDCAPlans, 500)
})

async function loadDCAPlans() {
  const list = document.getElementById('dca-plans-list')
  if (!list) return
  const data = await ipcRenderer.invoke('get-dca-plans').catch(() => ({ plans: [] }))
  if (!data.plans?.length) { list.innerHTML = '<div style="color:var(--text2);font-size:11px;">No DCA plans yet</div>'; return }
  list.innerHTML = data.plans.map(p => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg3);border-radius:6px;margin-bottom:4px;">
      <div>
        <span style="font-weight:600;">${p.coin}</span>
        <span style="color:var(--text2);font-size:11px;"> $${p.amount} ${p.interval}</span>
        ${p.lastRun ? `<div style="font-size:10px;color:var(--text2);">Last: ${new Date(p.lastRun).toLocaleDateString()}</div>` : ''}
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <div class="toggle-switch ${p.enabled ? 'on' : ''}" onclick="toggleDCA(${p.id})"></div>
        <button onclick="deleteDCA(${p.id})" style="background:none;border:none;color:var(--red);cursor:pointer;">✕</button>
      </div>
    </div>`).join('')
}

function toggleDCA(id) {
  ipcRenderer.invoke('get-dca-plans').then(data => {
    const plan = data.plans.find(p => p.id === id)
    if (plan) { plan.enabled = !plan.enabled; ipcRenderer.send('save-dca-plan', plan); setTimeout(loadDCAPlans, 300) }
  })
}
function deleteDCA(id) { ipcRenderer.send('delete-dca-plan', id); setTimeout(loadDCAPlans, 300) }

// ── Price Alerts ─────────────────────────────────────────────────────────
let alertDirection = 'above'
document.querySelectorAll('.alert-dir-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.alert-dir-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    alertDirection = this.dataset.val
  })
})

document.getElementById('add-alert-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('alert-coin').value
  const price = parseFloat(document.getElementById('alert-price').value)
  if (!price || price <= 0) return
  ipcRenderer.send('set-price-alert', { coin, price, direction: alertDirection })
  setEl('alert-price','value','')
  setTimeout(loadAlerts, 300)
})

async function loadAlerts() {
  const list = document.getElementById('alerts-list')
  if (!list) return
  const alerts = await ipcRenderer.invoke('get-price-alerts').catch(() => [])
  if (!alerts?.length) { list.innerHTML = '<div style="color:var(--text2);font-size:11px;">No alerts set</div>'; return }
  list.innerHTML = alerts.map((a, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg3);border-radius:6px;margin-bottom:4px;">
      <div style="font-size:12px;">
        <span style="font-weight:600;">${a.coin}</span>
        <span style="color:var(--text2);"> ${a.direction} $${a.price.toLocaleString()}</span>
      </div>
      <button onclick="removeAlert(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;">✕</button>
    </div>`).join('')
}

function removeAlert(idx) { ipcRenderer.send('remove-price-alert', idx); setTimeout(loadAlerts, 300) }

// Load DCA and alerts when trading page opens
// DCA/alerts loaded in applySettingsToUI below

// ── Usage Stats & Limits ─────────────────────────────────────────────────

async function loadUsageStats() {
  try {
    const stats = await ipcRenderer.invoke('get-usage-stats')
    if (!stats) return

    const tier = stats.tierName || 'pro'
    const tierNames = { starter: 'STARTER', pro: 'PRO', degen: 'DEGEN' }
    const tierColors = { starter: '#fbbf24', pro: '#00d4ff', degen: '#a78bfa' }

    // Tier badge
    const badge = document.getElementById('user-tier-badge')
    if(!badge) return
    if (badge) {
      badge.textContent = tierNames[tier] || 'PRO'
      badge.style.color = tierColors[tier] || '#00d4ff'
      badge.style.background = `${tierColors[tier]}22`
    }

    // Voice usage
    const voiceLimits = stats.limits?.voice || { used: 0, limit: 200, pct: 0 }
    const voiceText = document.getElementById('voice-usage-text')
    if(!voiceText) return
    const voiceBar = document.getElementById('voice-usage-bar')
    if (voiceText) {
      if (voiceLimits.limit >= 999999) {
        voiceText.textContent = `${voiceLimits.used} (unlimited)`
      } else {
        voiceText.textContent = `${voiceLimits.used}/${voiceLimits.limit}`
      }
      voiceText.style.color = voiceLimits.pct >= 90 ? 'var(--red)' : voiceLimits.pct >= 70 ? '#fbbf24' : 'var(--text)'
    }
    if (voiceBar) {
      const pct = Math.min(100, voiceLimits.pct || 0)
      voiceBar.style.width = pct + '%'
      voiceBar.style.background = pct >= 90 ? 'var(--red)' : pct >= 70 ? '#fbbf24' : 'var(--green)'
    }

// Show alert if any limit hit
    const limitAlert = document.getElementById('limit-alert')
    const limitMsg = document.getElementById('limit-alert-msg')
    if (limitAlert && limitMsg) {
      const voiceHit = voiceLimits.limit < 999999 && voiceLimits.pct >= 100
      const voiceWarn = voiceLimits.limit < 999999 && voiceLimits.pct >= 70

      if (voiceHit) {
        limitAlert.style.display = 'block'
        limitMsg.textContent = '🛑 Voice limit reached!'
        limitAlert.style.borderColor = 'rgba(239,68,68,0.3)'
        limitAlert.style.background = 'rgba(239,68,68,0.1)'
      } else if (voiceWarn) {
        limitAlert.style.display = 'block'
        limitMsg.textContent = `⚠️ ${voiceLimits.remaining} voice messages left today`
        limitAlert.style.borderColor = 'rgba(251,191,36,0.3)'
        limitAlert.style.background = 'rgba(251,191,36,0.1)'
        limitMsg.style.color = '#fbbf24'
      } else {
        limitAlert.style.display = 'none'
      }
    }

    // Auto extend toggle
    const autoToggle = document.getElementById('auto-extend-toggle')
    if(!autoToggle) return
    if (autoToggle && stats.config?.auto_extend) autoToggle.classList.add('on')

    // Store stripe links + fill subscription card from pricing source of truth
    window._stripeLinks = stats.stripeLinks || {}
    const vt = stats.pricing?.voiceTiers || {}
    const tierKey = stats.tierName || 'pro'
    const tierInfo = vt[tierKey] || stats.tier || {}
    const nameEl = document.getElementById('sub-tier-name')
    const priceEl = document.getElementById('sub-tier-price')
    if (nameEl) nameEl.textContent = (tierInfo.name || tierNames[tierKey] || tierKey || 'PRO').toUpperCase()
    if (priceEl && tierInfo.price_annual != null) priceEl.textContent = `$${tierInfo.price_annual}/year`
    const addons = stats.pricing?.addons || {}
    const degenBtn = document.getElementById('btn-upgrade-degen')
    const dayBtn = document.getElementById('btn-day-pass')
    const packBtn = document.getElementById('btn-msg-pack')
    if (degenBtn && vt.degen?.price_annual) degenBtn.textContent = `⬆️ Upgrade to Degen $${vt.degen.price_annual}/yr`
    if (dayBtn && addons.day_pass?.price != null) dayBtn.textContent = `🎫 Buy Day Pass $${addons.day_pass.price}`
    if (packBtn && addons.message_pack) {
      const n = addons.message_pack.voice_messages || 500
      const p = addons.message_pack.price
      packBtn.textContent = p != null ? `📦 +${n} Voice msgs $${p}` : `📦 +${n} Voice msgs`
    }

  } catch(e) { console.error('Usage stats error:', e) }
}

// Limit action buttons
document.getElementById('buy-day-pass-btn')?.addEventListener('click', () => {
  ipcRenderer.send('add-day-pass')
  if (window._stripeLinks?.day_pass) {
    ipcRenderer.invoke('open-url', window._stripeLinks.day_pass).catch(() => {})
  }
  setTimeout(loadUsageStats, 500)
})

document.getElementById('buy-msg-pack-btn')?.addEventListener('click', () => {
  ipcRenderer.send('add-message-pack', 500)
  if (window._stripeLinks?.message_pack) {
    ipcRenderer.invoke('open-url', window._stripeLinks.message_pack).catch(() => {})
  }
  setTimeout(loadUsageStats, 500)
})

document.getElementById('upgrade-plan-btn')?.addEventListener('click', () => {
  if (window._stripeLinks?.upgrade_degen) {
    ipcRenderer.invoke('open-url', window._stripeLinks.upgrade_degen).catch(() => {})
  }
})

document.getElementById('auto-extend-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-auto-extend', this.classList.contains('on'))
})

// Refresh usage every 30 seconds
setInterval(loadUsageStats, 30000)

// ── Analytics + Regime + Advanced Settings ───────────────────────────────

function formatRegimeDetails(regime) {
  if (!regime?.regime) return null
  const colors = { bull: 'var(--green)', bear: 'var(--red)', sideways: '#fbbf24', unknown: 'var(--text2)' }
  const color = colors[regime.regime] || colors.unknown
  const title = `${String(regime.regime).toUpperCase()} MARKET (${regime.strength || '—'})`
  const body = `Bias: ${String(regime.bias || '—').toUpperCase()} · 30d: ${regime.priceChange30d ?? '—'}% · RSI: ${regime.rsi != null ? Number(regime.rsi).toFixed(0) : '—'} · FG: ${regime.fgNum ?? '—'}`
  return { color, title, body, htmlPanel: `
      <div style="color:${color};font-weight:700;font-size:14px;">${title}</div>
      <div style="margin-top:4px;color:var(--text2);font-size:11px;">Bias: ${String(regime.bias || '—').toUpperCase()} | 30d change: ${regime.priceChange30d ?? '—'}% | RSI: ${regime.rsi != null ? Number(regime.rsi).toFixed(0) : '—'} | FG: ${regime.fgNum ?? '—'}</div>` }
}

function applyRegimeToUi(regime) {
  const fmt = formatRegimeDetails(regime)
  const el = document.getElementById('regime-display')
  const popTitle = document.getElementById('ov-regime-pop-title')
  const popBody = document.getElementById('ov-regime-pop-body')
  const regimeEl = document.getElementById('ov-regime')
  if (!fmt) {
    if (el) el.textContent = 'Unable to detect'
    if (popBody) popBody.textContent = 'Unable to detect market regime'
    return
  }
  if (el) el.innerHTML = fmt.htmlPanel
  if (popTitle) {
    popTitle.textContent = fmt.title
    popTitle.style.color = fmt.color
  }
  if (popBody) popBody.textContent = fmt.body
  if (regimeEl && regime?.regime) {
    const r = String(regime.regime).toLowerCase()
    regimeEl.textContent = r === 'bull' ? '🐂 Bull' : r === 'bear' ? '🐻 Bear' : '〰️ Side'
    regimeEl.className = 'ov-chip-val ' + (r === 'bull' ? 'regime-bull' : r === 'bear' ? 'regime-bear' : 'regime-side')
  }
}

async function loadMarketRegime() {
  const el = document.getElementById('regime-display')
  if (!el && !document.getElementById('ov-regime')) return
  try {
    const regime = await ipcTimeout('get-market-regime', undefined, 8000)
    applyRegimeToUi(regime)
  } catch(e) {
    if (el) el.textContent = 'Error loading regime'
    const popBody = document.getElementById('ov-regime-pop-body')
    if (popBody) popBody.textContent = 'Error loading regime'
  }
}

async function loadTradeAnalytics() {
  const el = document.getElementById('analytics-display')
  if (!el) return
  try {
    const analytics = await ipcTimeout('get-trade-analytics', undefined, 8000)
    if (!analytics) { el.textContent = 'Not enough trades yet (need 5+)'; return }
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
        <div style="padding:6px;background:var(--bg3);border-radius:6px;">
          <div style="font-size:10px;color:var(--text2);">Best Coin</div>
          <div style="font-size:13px;font-weight:700;color:var(--green);">${analytics.bestCoin?.coin || '-'}</div>
          <div style="font-size:10px;color:var(--text2);">$${analytics.bestCoin?.pnl?.toFixed(0) || 0} P&L</div>
        </div>
        <div style="padding:6px;background:var(--bg3);border-radius:6px;">
          <div style="font-size:10px;color:var(--text2);">Worst Coin</div>
          <div style="font-size:13px;font-weight:700;color:var(--red);">${analytics.worstCoin?.coin || '-'}</div>
          <div style="font-size:10px;color:var(--text2);">$${analytics.worstCoin?.pnl?.toFixed(0) || 0} P&L</div>
        </div>
        <div style="padding:6px;background:var(--bg3);border-radius:6px;">
          <div style="font-size:10px;color:var(--text2);">Best Hour (UTC)</div>
          <div style="font-size:13px;font-weight:700;">${analytics.bestHour !== null ? analytics.bestHour?.hour + ':00' : '-'}</div>
          <div style="font-size:10px;color:var(--text2);">$${analytics.bestHour?.pnl?.toFixed(0) || 0} P&L</div>
        </div>
        <div style="padding:6px;background:var(--bg3);border-radius:6px;">
          <div style="font-size:10px;color:var(--text2);">Avg Hold Time</div>
          <div style="font-size:13px;font-weight:700;">${analytics.avgHoldMin}m</div>
          <div style="font-size:10px;color:var(--text2);">${analytics.totalTrades} total trades</div>
        </div>
      </div>`
  } catch(e) { el.textContent = 'Error loading analytics' }
}

document.getElementById('refresh-regime-btn')?.addEventListener('click', loadMarketRegime)

document.getElementById('kelly-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'useKellyCriterion', this.classList.contains('on'))
})

document.querySelectorAll('.cooldown-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.cooldown-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'lossCooldownMinutes', parseInt(this.dataset.val))
  })
})

document.querySelectorAll('.mtf-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.mtf-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'mtfMode', this.dataset.val)
  })
})

document.getElementById('precision-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'precisionScanner', this.classList.contains('on'))
})

document.querySelectorAll('.tier-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.tier-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'confluenceMinTier', this.dataset.val)
  })
})

// Load analytics when trading tab opens
// regime/analytics loaded inline below

// ── Analytics + Regime restore ────────────────────────────────────────────
function restoreAdvancedSettings(settings) {
  if (!settings) return
  if (settings.useKellyCriterion) document.getElementById('kelly-toggle')?.classList.add('on')
  if (settings.lossCooldownMinutes !== undefined) {
    document.querySelectorAll('.cooldown-btn').forEach(b =>
      b.classList.toggle('active', parseInt(b.dataset.val) === settings.lossCooldownMinutes)
    )
  }
  if (settings.mtfMode) {
    document.querySelectorAll('.mtf-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.val === settings.mtfMode)
    )
  }
  const prec = document.getElementById('precision-toggle')
  if (prec) prec.classList.toggle('on', settings.precisionScanner !== false)
  if (settings.confluenceMinTier) {
    document.querySelectorAll('.tier-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.val === settings.confluenceMinTier)
    )
  }
}

// ── Technical Indicators (handled by buildIndicatorSections) ─────────────
// ta-auto-btn and ta-manual-btn removed — now using inline toggles per indicator

// Individual indicator toggles
const taToggles = {
  'ta-rsi-toggle': 'rsi',
  'ta-ma-toggle': 'ma',
  'ta-macd-toggle': 'macd',
  'ta-bb-toggle': 'bb',
  'ta-sr-toggle': 'sr',
  'ta-ob-toggle': 'ob',
  'ta-corr-toggle': 'corr',
  'ta-time-toggle': 'time'
}

Object.entries(taToggles).forEach(([id, key]) => {
  const el = document.getElementById(id)
  if (!el) return
  el.addEventListener('click', async function() {
    this.classList.toggle('on')
    const settings = await ipcRenderer.invoke('get-settings')
    const indicators = settings?.enabledIndicators || {}
    indicators[key] = this.classList.contains('on')
    ipcRenderer.send('set-setting', 'enabledIndicators', indicators)
  })
})

// Scalp indicator toggles
const scalpToggles = {
  'scalp-rsi-toggle': 'rsi',
  'scalp-bb-toggle': 'bb',
  'scalp-sr-toggle': 'sr',
  'scalp-ob-toggle': 'ob'
}

Object.entries(scalpToggles).forEach(([id, key]) => {
  const el = document.getElementById(id)
  if (!el) return
  el.addEventListener('click', async function() {
    this.classList.toggle('on')
    const settings = await ipcRenderer.invoke('get-settings')
    const indicators = settings?.scalpIndicators || {}
    indicators[key] = this.classList.contains('on')
    ipcRenderer.send('set-setting', 'scalpIndicators', indicators)
  })
})

// ── TP/SL Settings ───────────────────────────────────────────────────────

let currentTpSlMode = 'auto'

function showTpSlPanel(mode) {
  currentTpSlMode = mode
  document.getElementById('tpsl-auto-panel').style.display = mode === 'auto' ? 'block' : 'none'
  document.getElementById('tpsl-ratio-panel').style.display = mode === 'ratio' ? 'block' : 'none'
  document.getElementById('tpsl-manual-panel').style.display = mode === 'manual' ? 'block' : 'none'
  document.getElementById('tpsl-auto-btn').classList.toggle('active', mode === 'auto')
  document.getElementById('tpsl-ratio-btn').classList.toggle('active', mode === 'ratio')
  document.getElementById('tpsl-manual-btn').classList.toggle('active', mode === 'manual')
  ipcRenderer.send('set-setting', 'tpSlMode', mode)
}

document.getElementById('tpsl-auto-btn')?.addEventListener('click', () => showTpSlPanel('auto'))
document.getElementById('tpsl-ratio-btn')?.addEventListener('click', () => showTpSlPanel('ratio'))
document.getElementById('tpsl-manual-btn')?.addEventListener('click', () => showTpSlPanel('manual'))

// Ratio buttons
document.querySelectorAll('.ratio-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    const ratio = parseFloat(this.dataset.ratio)
    ipcRenderer.send('set-setting', 'tpSlRatio', ratio)
    setEl('ratio-preview','textContent',`Example: SL 1% → TP ${ratio}%`)
  })
})

// Manual save
document.getElementById('save-tpsl-btn')?.addEventListener('click', () => {
  const tp = parseFloat(document.getElementById('custom-tp-input').value)
  const sl = parseFloat(document.getElementById('custom-sl-input').value)
  const hint = document.getElementById('tpsl-hint')
  if(!hint) return
  if (!tp || !sl || tp <= 0 || sl <= 0) {
    hint.textContent = 'Enter valid TP and SL values'
    hint.style.color = 'var(--red)'
    return
  }
  if (tp < sl) {
    hint.textContent = `⚠️ TP (${tp}%) is less than SL (${sl}%) — ratio would be below 1:1`
    hint.style.color = 'var(--red)'
    return
  }
  ipcRenderer.send('set-setting', 'customTpPct', tp)
  ipcRenderer.send('set-setting', 'customSlPct', sl)
  hint.textContent = `✅ Saved: TP ${tp}% | SL ${sl}% | Ratio 1:${(tp/sl).toFixed(1)}`
  hint.style.color = 'var(--green)'
})

// Collapsible sections handled via CSS classes

// Max scalp limit
document.querySelectorAll('.scalp-max-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.scalp-max-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-max-scalps', parseInt(this.dataset.val))
  })
})

// scalp-max handled above

// Scalp threshold dots
document.querySelector('.trust-dots[data-key="scalpThreshold"]')?.addEventListener('click', (e) => {
  if (!e.target.classList.contains('trust-dot')) return
  const container = e.target.closest('.trust-dots')
  const dots = container.querySelectorAll('.trust-dot')
  const idx = Array.from(dots).indexOf(e.target) + 1
  dots.forEach((d, i) => d.classList.toggle('filled', i < idx))
  container.dataset.val = idx
  const pct = idx * 10
  if (document.getElementById('scalp-threshold-val')) setEl('scalp-threshold-val','textContent',`${pct}%`)
  const scalpDisp = document.getElementById('scalp-threshold-display')
  if(!scalpDisp) return
  if (scalpDisp) scalpDisp.textContent = `${pct}%`
  ipcRenderer.send('set-setting', 'scalpThreshold', pct)
})

// Coin selector
// selectedCoins handled by coinState
// customCoins handled by coinState

// renderCustomCoins handled by coinState

// FREE_COIN_LIMIT defined above

function showCoinLimitModal() {
  // Show upgrade prompt
  const existing = document.getElementById('coin-limit-modal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'coin-limit-modal';
  modal.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--bg2);border:1px solid var(--border);border-radius:12px;
    padding:24px;z-index:9999;width:280px;text-align:center;
    box-shadow:0 20px 60px rgba(0,0,0,0.5);
  `;
  modal.innerHTML = `
    <div style="font-size:24px;margin-bottom:8px;">🔒</div>
    <div style="font-size:15px;font-weight:700;margin-bottom:8px;">3 Coin Limit</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:16px;line-height:1.5;">
      Free plan includes 3 coins.<br>
      Add more coins for <b style="color:var(--accent)">$5/month each</b>.
    </div>
    <button onclick="document.getElementById('coin-limit-modal').remove()" 
      style="background:var(--accent);color:#000;border:none;padding:10px 20px;border-radius:8px;font-weight:700;cursor:pointer;width:100%;margin-bottom:8px;">
      Upgrade — Coming Soon
    </button>
    <button onclick="document.getElementById('coin-limit-modal').remove()" 
      style="background:transparent;color:var(--text2);border:1px solid var(--border);padding:8px 20px;border-radius:8px;cursor:pointer;width:100%;">
      Cancel
    </button>
  `;
  document.body.appendChild(modal);
}

function toggleCoin(coin, btn) {
  if (selectedCoins.includes(coin)) {
    if (selectedCoins.length <= 1) return // Keep at least 1 coin
    selectedCoins = selectedCoins.filter(c => c !== coin)
    btn.classList.remove('active')
  } else {
    // Check 3 coin limit
    if (selectedCoins.length >= FREE_COIN_LIMIT) {
      showCoinLimitModal();
      return;
    }
    selectedCoins.push(coin)
    btn.classList.add('active')
  }
  ipcRenderer.send('set-setting', 'tradingCoins', selectedCoins)
  updateCoinCounter()
}

function updateCoinCounter() {
  const counter = document.getElementById('coin-counter');
  if (counter) {
    counter.textContent = `${selectedCoins.length}/${FREE_COIN_LIMIT} free coins used`;
    counter.style.color = selectedCoins.length >= FREE_COIN_LIMIT ? 'var(--red)' : 'var(--text2)';
  }
}

function removeCustomCoin(prefix, coin) {
  // Legacy single-arg support: removeCustomCoin('PEPE') → main list
  if (coin === undefined) { coin = prefix; prefix = 'main' }
  if (!coinState[prefix]) return
  coinState[prefix].custom = coinState[prefix].custom.filter(c => c !== coin)
  coinState[prefix].selected = coinState[prefix].selected.filter(c => c !== coin)
  const keyMap = { main: 'tradingCoins', day: 'dayTradeCoins', scalp: 'scalpCoins' }
  ipcRenderer.send('set-setting', keyMap[prefix] || 'tradingCoins', coinState[prefix].selected)
  // Re-render chips + counter
  const list = document.getElementById(`${prefix}-custom-coins-list`)
  if (list) list.innerHTML = coinState[prefix].custom.map(c => `
      <div style="display:flex;align-items:center;gap:3px;background:rgba(0,212,255,0.15);border:1px solid rgba(0,212,255,0.3);border-radius:6px;padding:3px 8px;">
        <span style="font-size:11px;font-weight:600;">${c}</span>
        <button onclick="removeCustomCoin('${prefix}','${c}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;padding:0 0 0 4px;">✕</button>
      </div>`).join('')
  const counter = document.getElementById(`${prefix}-coin-counter`)
  if (counter) counter.textContent = `${coinState[prefix].selected.length}/999 coins`
}

document.querySelectorAll('.coin-btn[data-coin]').forEach(btn => {
  btn.addEventListener('click', () => toggleCoin(btn.dataset.coin, btn))
})

document.getElementById('add-custom-coin-btn')?.addEventListener('click', () => {
  const input = document.getElementById('custom-coin-input')
  if(!input) return
  const coin = input.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!coin) return
  
  // Check limit
  if (selectedCoins.length >= FREE_COIN_LIMIT && !selectedCoins.includes(coin)) {
    showCoinLimitModal();
    input.value = '';
    return;
  }
  
  if (!customCoins.includes(coin)) {
    customCoins.push(coin)
    selectedCoins.push(coin)
    ipcRenderer.send('set-setting', 'tradingCoins', selectedCoins)
    ipcRenderer.send('set-setting', 'customCoins', customCoins)
    renderCustomCoins()
    updateCoinCounter()
  }
  input.value = ''
})

document.getElementById('custom-coin-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-custom-coin-btn').click()
})

// Restore coin selections
// restoreCoinSelections handled above


// Scalp toggle
document.getElementById('scalp-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  const on = this.classList.contains('on')
  ipcRenderer.send('set-setting', 'scalpTrading', on)
  try { refreshBotStatusCards() } catch(e) {}
  document.getElementById('scalp-settings-panel').style.display = on ? 'block' : 'none'
  if (on) {
    ipcRenderer.send('trigger-scalp-scan') // Run immediately
  }
})

// Scalp leverage
// ── Intelligence Settings Builder ─────────────────────────────────────────

// Advanced settings config per indicator
const indicatorAdvanced = {
  rsi: {
    label: 'RSI',
    settings: [
      { key: 'rsiPeriod', label: 'Period', type: 'buttons', options: [7,14,21], default: 14 },
      { key: 'rsiOversold', label: 'Oversold threshold', type: 'buttons', options: [20,25,30,35], default: 30 },
      { key: 'rsiOverbought', label: 'Overbought threshold', type: 'buttons', options: [65,70,75,80], default: 70 },
    ]
  },
  bb: {
    label: 'Bollinger Bands',
    settings: [
      { key: 'bbPeriod', label: 'Period', type: 'buttons', options: [14,20,25], default: 20 },
      { key: 'bbMultiplier', label: 'Std Dev multiplier', type: 'buttons', options: [1.5,2,2.5], default: 2 },
    ]
  },
  ichimoku: {
    label: 'Ichimoku Cloud',
    settings: [
      { key: 'ichimokuTenkan', label: 'Tenkan (fast)', type: 'buttons', options: [7,9,10], default: 9 },
      { key: 'ichimokuKijun', label: 'Kijun (base)', type: 'buttons', options: [20,26,30], default: 26 },
      { key: 'ichimokuSenkouB', label: 'Senkou B (slow)', type: 'buttons', options: [44,52,60], default: 52 },
    ]
  },
  atr: {
    label: 'ATR',
    settings: [
      { key: 'atrPeriod', label: 'Period', type: 'buttons', options: [7,14,21], default: 14 },
      { key: 'atrTpMultiplier', label: 'TP multiplier', type: 'buttons', options: [1.5,2,2.5,3], default: 2 },
      { key: 'atrSlMultiplier', label: 'SL multiplier', type: 'buttons', options: [0.5,1,1.5], default: 1 },
    ]
  },
  stochRsi: {
    label: 'Stochastic RSI',
    settings: [
      { key: 'stochRsiOversold', label: 'Oversold', type: 'buttons', options: [15,20,25], default: 20 },
      { key: 'stochRsiOverbought', label: 'Overbought', type: 'buttons', options: [75,80,85], default: 80 },
      { key: 'stochKPeriod', label: 'K period', type: 'buttons', options: [2,3,5], default: 3 },
    ]
  },
  emaCross: {
    label: 'EMA Cross',
    settings: [
      { key: 'emaFastPeriod', label: 'Fast EMA', type: 'buttons', options: [5,9,12], default: 9 },
      { key: 'emaSlowPeriod', label: 'Slow EMA', type: 'buttons', options: [21,26,50], default: 21 },
    ]
  },
  fundingExtreme: {
    label: 'Funding Extremes',
    settings: [
      { key: 'fundingHighThreshold', label: 'High threshold %', type: 'buttons', options: [0.05,0.1,0.15], default: 0.1 },
      { key: 'fundingLowThreshold', label: 'Low threshold %', type: 'buttons', options: [-0.05,-0.1,-0.15], default: -0.1 },
    ]
  },
  pivots: {
    label: 'Pivot Points',
    settings: [
      { key: 'pivotType', label: 'Type', type: 'buttons', options: ['Standard','Fibonacci'], default: 'Standard' },
      { key: 'pivotTimeframe', label: 'Timeframe', type: 'buttons', options: ['Daily','Weekly'], default: 'Daily' },
    ]
  },
  vwap: {
    label: 'VWAP',
    settings: [
      { key: 'vwapTimeframe', label: 'Timeframe', type: 'buttons', options: ['1h','4h','1d'], default: '1h' },
    ]
  },
}

// Main trade indicators
const mainIndicators = [
  { key: 'rsi', id: 'ta-rsi-toggle', label: 'RSI', desc: 'Overbought/oversold (1h+4h)', hasAdv: true },
  { key: 'ma', id: 'ta-ma-toggle', label: 'Moving Averages', desc: 'EMA9/SMA20/50/200', hasAdv: false },
  { key: 'macd', id: 'ta-macd-toggle', label: 'MACD', desc: 'Momentum direction', hasAdv: false },
  { key: 'bb', id: 'ta-bb-toggle', label: 'Bollinger Bands', desc: 'Volatility & squeezes', hasAdv: true },
  { key: 'sr', id: 'ta-sr-toggle', label: 'Support/Resistance', desc: 'Key price levels', hasAdv: false },
  { key: 'ob', id: 'ta-ob-toggle', label: 'Order Book', desc: 'Buy/sell walls', hasAdv: false },
  { key: 'ichimoku', id: 'ta-ichimoku-toggle', label: 'Ichimoku Cloud', desc: 'Trend + momentum', hasAdv: true },
  { key: 'atr', id: 'ta-atr-toggle', label: 'ATR', desc: 'Smart TP/SL sizing', hasAdv: true },
  { key: 'vwap', id: 'ta-vwap-toggle', label: 'VWAP', desc: 'Intraday bias level', hasAdv: true },
  { key: 'stochRsi', id: 'ta-stochrsi-toggle', label: 'Stoch RSI', desc: 'Precise turn detection', hasAdv: true },
  { key: 'emaCross', id: 'ta-emacross-toggle', label: 'EMA Cross', desc: 'Momentum crossovers', hasAdv: true },
  { key: 'fundingExtreme', id: 'ta-fundingextreme-toggle', label: 'Funding Extremes', desc: 'Squeeze risk', hasAdv: true },
  { key: 'pivots', id: 'ta-pivots-toggle', label: 'Pivot Points', desc: 'Daily PP/R1/R2/S1/S2', hasAdv: true },
  { key: 'corr', id: 'ta-corr-toggle', label: 'Correlation', desc: 'BTC lag for alts', hasAdv: false },
  { key: 'time', id: 'ta-time-toggle', label: 'Time Filter', desc: 'Best trading hours', hasAdv: false },
]

// Scalp indicators
const scalpIndicatorsList = [
  { key: 'rsi', id: 'scalp-rsi-toggle', label: 'RSI 15m', desc: 'Fast oversold/overbought', hasAdv: true },
  { key: 'bb', id: 'scalp-bb-toggle', label: 'Bollinger Bands 15m', desc: 'Band touch entries', hasAdv: true },
  { key: 'sr', id: 'scalp-sr-toggle', label: 'Support/Resistance', desc: 'Nearby key levels', hasAdv: false },
  { key: 'ob', id: 'scalp-ob-toggle', label: 'Order Book', desc: 'Buy/sell walls', hasAdv: false },
  { key: 'vwap', id: 'scalp-vwap-toggle', label: 'VWAP', desc: 'Intraday bias', hasAdv: false },
  { key: 'stochRsi', id: 'scalp-stochrsi-toggle', label: 'Stoch RSI 15m', desc: 'Precise timing', hasAdv: true },
  { key: 'emaCross', id: 'scalp-emacross-toggle', label: 'EMA Cross 15m', desc: 'Quick momentum shift', hasAdv: true },
  { key: 'ichimoku', id: 'scalp-ichimoku-toggle', label: 'Ichimoku 1h', desc: 'Trend confirmation', hasAdv: false },
  { key: 'atr', id: 'scalp-atr-toggle', label: 'ATR 15m', desc: 'Volatility sizing', hasAdv: false },
  { key: 'fundingExtreme', id: 'scalp-fundingextreme-toggle', label: 'Funding Extremes', desc: 'Squeeze risk', hasAdv: false },
  { key: 'pivots', id: 'scalp-pivots-toggle', label: 'Pivot Points', desc: 'Key targets', hasAdv: false },
]

function buildIndicatorRow(ind, settingsObj, settingsKey) {
  const enabled = settingsObj?.[ind.key] !== false
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg3);border-radius:8px;margin-bottom:4px;'
  row.innerHTML = `
    <div style="flex:1;">
      <div style="font-size:12px;font-weight:600;color:var(--text);">${ind.label}</div>
      <div style="font-size:10px;color:var(--text2);">${ind.desc}</div>
    </div>
    <div style="display:flex;align-items:center;gap:8px;">
      ${ind.hasAdv ? `<button class="adv-btn" data-key="${ind.key}" style="font-size:10px;padding:2px 8px;border:1px solid var(--border);background:transparent;color:var(--text2);border-radius:4px;cursor:pointer;">⚙️ Edit</button>` : ''}
      <div class="toggle-switch ${enabled ? 'on' : ''}" id="${ind.id}"></div>
    </div>`

  // Toggle handler
  const toggle = row.querySelector(`#${ind.id}`)
  toggle?.addEventListener('click', function() {
    this.classList.toggle('on')
    const s = {}
    s[ind.key] = this.classList.contains('on')
    const existing = window._cachedSettings?.[settingsKey] || {}
    ipcRenderer.send('set-setting', settingsKey, { ...existing, ...s })
    if (window._cachedSettings) {
      if (!window._cachedSettings[settingsKey]) window._cachedSettings[settingsKey] = {}
      window._cachedSettings[settingsKey][ind.key] = this.classList.contains('on')
    }
  })

  // Advanced button handler
  const advBtn = row.querySelector('.adv-btn')
  advBtn?.addEventListener('click', () => showAdvancedPanel(ind.key))

  return row
}

function showAdvancedPanel(key) {
  const config = indicatorAdvanced[key]
  if (!config) return
  const panel = document.getElementById('advanced-settings-panel')
  const title = document.getElementById('adv-panel-title')
  if(!title) return
  const content = document.getElementById('adv-panel-content')
  if(!content) return
  if (!panel || !title || !content) return

  title.textContent = `⚙️ ${config.label} — Advanced Settings`
  content.innerHTML = ''

  config.settings.forEach(setting => {
    const settingDiv = document.createElement('div')
    settingDiv.style.marginBottom = '10px'

    const currentVal = window._cachedSettings?.[setting.key] ?? setting.default

    settingDiv.innerHTML = `
      <div style="font-size:11px;color:var(--text2);margin-bottom:4px;">${setting.label}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        ${setting.options.map(opt => `
          <button class="leverage-btn adv-opt-btn ${currentVal == opt ? 'active' : ''}"
            data-key="${setting.key}" data-val="${opt}"
            style="font-size:11px;">
            ${opt}
          </button>`).join('')}
      </div>`

    settingDiv.querySelectorAll('.adv-opt-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        settingDiv.querySelectorAll('.adv-opt-btn').forEach(b => b.classList.remove('active'))
        this.classList.add('active')
        const val = isNaN(this.dataset.val) ? this.dataset.val : parseFloat(this.dataset.val)
        ipcRenderer.send('set-setting', this.dataset.key, val)
        if (window._cachedSettings) window._cachedSettings[this.dataset.key] = val
      })
    })

    content.appendChild(settingDiv)
  })

  panel.style.display = 'block'
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function buildIndicatorSections(settings) {
  const mainContainer = document.getElementById('main-indicators-built')
  if(!mainContainer) return
  const scalpContainer = document.getElementById('scalp-indicators-built')
  if(!scalpContainer) return
  if (!mainContainer || !scalpContainer) return

  mainContainer.innerHTML = ''
  scalpContainer.innerHTML = ''

  const enabledIndicators = settings?.enabledIndicators || {}
  const scalpIndicators = settings?.scalpIndicators || {}

  mainIndicators.forEach(ind => {
    mainContainer.appendChild(buildIndicatorRow(ind, enabledIndicators, 'enabledIndicators'))
  })

  scalpIndicatorsList.forEach(ind => {
    scalpContainer.appendChild(buildIndicatorRow(ind, scalpIndicators, 'scalpIndicators'))
  })
}

// ── RSI Period + Ichimoku Settings ───────────────────────────────────────
document.querySelectorAll('.rsi-period-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.rsi-period-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'rsiPeriod', parseInt(this.dataset.val))
  })
})

document.querySelectorAll('.ichi-tenkan-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.ichi-tenkan-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'ichimokuTenkan', parseInt(this.dataset.val))
  })
})

document.querySelectorAll('.ichi-kijun-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.ichi-kijun-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'ichimokuKijun', parseInt(this.dataset.val))
  })
})

document.querySelectorAll('.ichi-senkou-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.ichi-senkou-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'ichimokuSenkouB', parseInt(this.dataset.val))
  })
})

// ── Daily Trade Bot ───────────────────────────────────────────────────────

function setupDailyBtnGroup(selector, settingKey) {
  document.querySelectorAll(selector).forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll(selector).forEach(b => b.classList.remove('active'))
      this.classList.add('active')
      ipcRenderer.send('set-daily-setting', settingKey, parseFloat(this.dataset.val))
    })
  })
}

setupDailyBtnGroup('.daily-period-btn', 'dailyRSIPeriod')
setupDailyBtnGroup('.daily-pbuy-btn', 'dailyPowerBuyRSI')
setupDailyBtnGroup('.daily-buy-btn', 'dailyBuyRSI')
setupDailyBtnGroup('.daily-sell-btn', 'dailySellRSI')
setupDailyBtnGroup('.daily-psell-btn', 'dailyPowerSellRSI')
setupDailyBtnGroup('.daily-lev-btn', 'dailyLeverage')
setupDailyBtnGroup('.daily-max-btn', 'dailyMaxTrades')

document.getElementById('daily-trade-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-daily-setting', 'dailyTradeEnabled', this.classList.contains('on'))
  try { refreshBotStatusCards() } catch(e) {}
})

document.getElementById('daily-power-only-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-daily-setting', 'dailyPowerOnly', this.classList.contains('on'))
})

document.getElementById('save-daily-size-btn')?.addEventListener('click', () => {
  const val = parseFloat(document.getElementById('daily-size-input').value)
  if (val > 0) {
    ipcRenderer.send('set-daily-setting', 'dailyTradeSize', val)
    document.getElementById('daily-size-input').style.borderColor = 'var(--green)'
    setTimeout(() => document.getElementById('daily-size-input').style.borderColor = '', 1000)
  }
})

document.getElementById('refresh-daily-signals-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('refresh-daily-signals-btn')
  if(!btn) return
  btn.textContent = 'Scanning...'
  btn.disabled = true
  await ipcRenderer.invoke('trigger-daily-scan-wait').catch(() => 
    ipcRenderer.send('trigger-daily-scan')
  )
  setTimeout(async () => {
    await loadDailySignals()
    btn.textContent = 'Scan Now'
    btn.disabled = false
  }, 5000)
})

async function loadDailySignals() {
  const list = document.getElementById('daily-signals-list')
  if (!list) return
  try {
    const data = await ipcRenderer.invoke('get-daily-signals')
    if (!data?.signals || !Object.keys(data.signals).length) {
      list.innerHTML = '<div style="color:var(--text2);text-align:center;padding:8px;">No signals today — market neutral or not scanned yet</div>'
      return
    }

    const tierColors = {
      'Power Buy': '#34d399',
      'Buy': '#86efac',
      'Neutral': 'var(--text2)',
      'Sell': '#fca5a5',
      'Power Sell': '#ef4444'
    }
    const tierEmoji = {
      'Power Buy': '🔥🟢',
      'Buy': '🟢',
      'Neutral': '⚪',
      'Sell': '🔴',
      'Power Sell': '🔥🔴'
    }

    list.innerHTML = Object.entries(data.signals).map(([coin, s]) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border2);">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;color:var(--text);">${coin}</span>
          <span style="font-size:11px;color:${tierColors[s.tier] || 'var(--text2)'};">${tierEmoji[s.tier] || ''} ${s.tier}</span>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:700;color:${tierColors[s.tier]};">RSI ${s.rsi}</div>
          <div style="font-size:10px;color:var(--text2);">${s.direction?.toUpperCase() || 'SKIP'}</div>
        </div>
      </div>`).join('') +
      `<div style="font-size:10px;color:var(--text2);margin-top:6px;text-align:right;">Updated: ${data.date || 'Today'}</div>`
  } catch(e) {
    list.innerHTML = '<div style="color:var(--text2);font-size:11px;">Error loading signals</div>'
  }
}

// Restore daily settings
async function restoreDailySettings(settings) {
  if (!settings) return
  if (settings.dailyTradeEnabled) document.getElementById('daily-trade-toggle')?.classList.add('on')
  if (settings.dailyPowerOnly !== false) document.getElementById('daily-power-only-toggle')?.classList.add('on')
  if (settings.dailyRSIPeriod) document.querySelectorAll('.daily-period-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailyRSIPeriod))
  if (settings.dailyPowerBuyRSI) document.querySelectorAll('.daily-pbuy-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailyPowerBuyRSI))
  if (settings.dailyBuyRSI) document.querySelectorAll('.daily-buy-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailyBuyRSI))
  if (settings.dailySellRSI) document.querySelectorAll('.daily-sell-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailySellRSI))
  if (settings.dailyPowerSellRSI) document.querySelectorAll('.daily-psell-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailyPowerSellRSI))
  if (settings.dailyLeverage) document.querySelectorAll('.daily-lev-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailyLeverage))
  if (settings.dailyMaxTrades) document.querySelectorAll('.daily-max-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.val) === settings.dailyMaxTrades))
  if (settings.dailyTradeSize) { const el = document.getElementById('daily-size-input'); if(el) el.value = settings.dailyTradeSize }
  await loadDailySignals()
}


// ── Trading Sub-tabs (scoped to Trade page only) ──────────────────────────
document.querySelectorAll('#trade-subnav .trade-tab').forEach(tab => {
  tab.addEventListener('click', function() {
    document.querySelectorAll('#trade-subnav .trade-tab').forEach(t => t.classList.remove('active'))
    document.querySelectorAll('#trading-page .trade-tab-content').forEach(c => c.classList.remove('active'))
    this.classList.add('active')
    const tabId = 'tab-' + this.dataset.tab
    document.getElementById(tabId)?.classList.add('active')
    if (this.dataset.tab === 'overview') loadOverviewTab()
    if (this.dataset.tab === 'daytrade') loadDayTradeTab()
    if (this.dataset.tab === 'maintrade') loadMainTradeTab()
    if (this.dataset.tab === 'scalp') loadScalpTab()
    if (this.dataset.tab === 'spot') { loadSpotBalances(); loadOpenLimitOrders(); loadDCAPlans(); loadAlerts() }
  })
})

function gotoTradeTab(tabName) {
  const btn = document.querySelector(`#trade-subnav .trade-tab[data-tab="${tabName}"]`)
  if (btn) btn.click()
}

function refreshBotStatusCards() {
  const onOff = (el) => {
    const on = !!el?.classList.contains('on')
    return { on, label: on ? 'ON' : 'OFF' }
  }
  const main = onOff(document.getElementById('auto-trade-toggle'))
  const day = onOff(document.getElementById('daily-trade-toggle'))
  const scalp = onOff(document.getElementById('scalp-toggle'))
  const set = (id, state) => {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = state.label
    el.classList.toggle('on', state.on)
    el.classList.toggle('off', !state.on)
  }
  set('bot-st-main', main)
  set('bot-st-day', day)
  set('bot-st-scalp', scalp)
}

document.getElementById('bot-status-grid')?.addEventListener('click', (e) => {
  const card = e.target.closest('.bot-status-card')
  if (!card) return
  if (card.dataset.goto) {
    document.querySelector('.page-tab[data-page="3"]')?.click()
    setTimeout(() => gotoTradeTab(card.dataset.goto), 50)
  } else if (card.dataset.gotoPage) {
    document.querySelector(`.page-tab[data-page="${card.dataset.gotoPage}"]`)?.click()
  }
})

function loadOverviewTab() {
  loadOpenPositions()
  loadMarketRegime()
  loadTradeAnalytics()
  loadDailySignals()
  refreshBotStatusCards()
}

function loadDayTradeTab() {
  const pd = JSON.parse(localStorage.getItem('_pt_cache') || 'null')
  if (!pd) { ipcRenderer.invoke('get-paper-stats').then(s => { if(s) renderDayTrades(s) }) }
  else renderDayTrades(pd)
}

function loadMainTradeTab() {
  ipcRenderer.invoke('get-paper-stats').then(s => { if(s) renderMainTrades(s) })
  buildIndicatorSections(window._cachedSettings || {})
}

function loadScalpTab() {
  ipcRenderer.invoke('get-paper-stats').then(s => { if(s) renderScalpTrades(s) })
  buildIndicatorSections(window._cachedSettings || {})
}

function renderDayTrades(stats) {
  if (!stats || !Array.isArray(stats.trades)) stats = { ...(stats||{}), trades: [] }
  const open = stats.trades.filter(t => t.status === 'open' && t.isDayTrade)
  const closed = stats.trades.filter(t => t.status !== 'open' && t.isDayTrade)
  const wins = closed.filter(t => t.pnl > 0)
  const pnl = closed.reduce((s, t) => s + (t.pnl||0), 0)

  const el = id => document.getElementById(id)
  if(el('day-total')) el('day-total').textContent = closed.length
  if(el('day-pnl')) { el('day-pnl').textContent = `${pnl>=0?'+':''}$${pnl.toFixed(0)}`; el('day-pnl').style.color = pnl>=0?'var(--green)':'var(--red)' }
  if(el('day-wr')) el('day-wr').textContent = closed.length ? Math.round(wins.length/closed.length*100)+'%' : '0%'

  const openList = el('day-open-list')
  if(openList) openList.innerHTML = open.length ? renderTradeCards(open) : '<div style="color:var(--text2);text-align:center;padding:12px;font-size:12px;">No open day trades</div>'
  const histList = el('day-history-list')
  if(histList) histList.innerHTML = closed.length ? renderTradeCards(closed.slice(-10).reverse()) : '<div style="color:var(--text2);text-align:center;padding:12px;font-size:12px;">No history yet</div>'
}

function renderMainTrades(stats) {
  if (!stats || !Array.isArray(stats.trades)) stats = { ...(stats||{}), trades: [] }
  const open = stats.trades.filter(t => t.status === 'open' && !t.isDayTrade && !t.isScalp)
  const closed = stats.trades.filter(t => t.status !== 'open' && !t.isDayTrade && !t.isScalp)
  const wins = closed.filter(t => t.pnl > 0)
  const pnl = closed.reduce((s, t) => s + (t.pnl||0), 0)

  const el = id => document.getElementById(id)
  if(el('main-total')) el('main-total').textContent = closed.length
  if(el('main-pnl')) { el('main-pnl').textContent = `${pnl>=0?'+':''}$${pnl.toFixed(0)}`; el('main-pnl').style.color = pnl>=0?'var(--green)':'var(--red)' }
  if(el('main-wr')) el('main-wr').textContent = closed.length ? Math.round(wins.length/closed.length*100)+'%' : '0%'

  const openList = el('main-open-list')
  if(openList) openList.innerHTML = open.length ? renderTradeCards(open) : '<div style="color:var(--text2);text-align:center;padding:12px;font-size:12px;">No open positions</div>'
  const histList = el('main-history-list')
  if(histList) histList.innerHTML = closed.length ? renderTradeCards(closed.slice(-20).reverse()) : '<div style="color:var(--text2);text-align:center;padding:12px;font-size:12px;">No history yet</div>'

  // Lessons
  ipcRenderer.invoke('get-lessons').then(lessons => {
    const list = el('pt-lessons-list')
    if(!list) return
    if(!lessons?.length) { list.innerHTML = '<div style="color:var(--text2);font-size:12px;text-align:center;padding:12px;">No lessons yet</div>'; return }
    list.innerHTML = lessons.slice(-10).reverse().map(l => `
      <div style="padding:8px 0;border-bottom:1px solid var(--border2);font-size:12px;">
        <div style="color:var(--accent);margin-bottom:3px;">📋 ${l.rule||l.lesson||''}</div>
        <div style="color:var(--text2);font-size:10px;">${new Date(l.timestamp||Date.now()).toLocaleDateString()}</div>
      </div>`).join('')
  }).catch(() => {})
}

function renderScalpTrades(stats) {
  if (!stats || !Array.isArray(stats.trades)) stats = { ...(stats||{}), trades: [] }
  const open = stats.trades.filter(t => t.status === 'open' && t.isScalp)
  const closed = stats.trades.filter(t => t.status !== 'open' && t.isScalp)
  const wins = closed.filter(t => t.pnl > 0)
  const pnl = closed.reduce((s, t) => s + (t.pnl||0), 0)

  const el = id => document.getElementById(id)
  if(el('scalp-total')) el('scalp-total').textContent = closed.length
  if(el('scalp-pnl')) { el('scalp-pnl').textContent = `${pnl>=0?'+':''}$${pnl.toFixed(0)}`; el('scalp-pnl').style.color = pnl>=0?'var(--green)':'var(--red)' }
  if(el('scalp-wr')) el('scalp-wr').textContent = closed.length ? Math.round(wins.length/closed.length*100)+'%' : '0%'

  const openList = el('scalp-open-list')
  if(openList) openList.innerHTML = open.length ? renderTradeCards(open) : '<div style="color:var(--text2);text-align:center;padding:12px;font-size:12px;">No open scalps</div>'
  const histList = el('scalp-history-list')
  if(histList) histList.innerHTML = closed.length ? renderTradeCards(closed.slice(-30).reverse()) : '<div style="color:var(--text2);text-align:center;padding:12px;font-size:12px;">No history yet</div>'
}

function renderTradeCards(trades) {
  return trades.map(t => {
    const pnl = t.pnl || 0
    const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)'
    const badge = t.isScalp ? '<span style="background:rgba(251,191,36,0.2);color:#fbbf24;border-radius:4px;font-size:10px;padding:1px 5px;">⚡SCALP</span>' :
                  t.isDayTrade ? '<span style="background:rgba(99,102,241,0.2);color:#818cf8;border-radius:4px;font-size:10px;padding:1px 5px;">📅DAY</span>' : ''
    const status = t.status === 'open' ? '<span style="color:#fbbf24;">● OPEN</span>' :
                   t.status === 'win' ? '<span style="color:var(--green);">✅ WIN</span>' :
                   '<span style="color:var(--red);">❌ LOSS</span>'
    return `<div style="padding:10px;background:var(--bg3);border-radius:8px;margin-bottom:6px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-weight:700;">${t.coin}</span>
          <span style="font-size:11px;color:${t.direction==='long'?'var(--green)':'var(--red)'};">${t.direction?.toUpperCase()} ${t.leverage}x</span>
          ${badge}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${status}
          <span style="font-weight:700;color:${pnlColor};">${pnl>=0?'+':''}$${pnl.toFixed(2)}</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text2);">Entry: $${t.entry} | TP: $${t.target} | SL: $${t.stopLoss}</div>
      <div style="font-size:10px;color:var(--text2);">${t.caller || ''} | ${new Date(t.openTime).toLocaleString()}</div>
      ${t.status === 'open' ? `<button onclick="closeTrade(${t.id},${t.entry})" style="margin-top:4px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:var(--red);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer;">Close</button>` : ''}
    </div>`
  }).join('')
}

// Load overview by default when trading page opens

// ── Main Leverage Buttons ─────────────────────────────────────────────────
document.querySelectorAll('.lev-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.lev-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    const lev = parseInt(this.dataset.lev)
    ipcRenderer.send('set-setting', 'paperLeverage', lev)
    const warn = document.getElementById('lev-warning')
    if(!warn) return
    if (warn) warn.textContent = levWarnings[lev] || `${lev}x leverage`
  })
})

// ── Scalp Leverage Buttons ────────────────────────────────────────────────
document.querySelectorAll('.scalp-lev-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.scalp-lev-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'scalpLeverage', parseInt(this.dataset.lev))
  })
})

// Scalp duration
document.querySelectorAll('.scalp-dur-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.scalp-dur-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'scalpDuration', parseInt(this.dataset.min))
  })
})

// Scalp size
document.getElementById('save-scalp-btn')?.addEventListener('click', () => {
  const size = parseFloat(document.getElementById('scalp-size-input').value)
  if (!size || size <= 0) return
  ipcRenderer.send('set-setting', 'scalpSize', size)
  setEl('scalp-hint','textContent',`Scalp size: $${size} per trade`)
  document.getElementById('scalp-hint').style.color = 'var(--green)'
})

// ── New Features Setup ──────────────────────────────────────────────────
try {

// ── Rage Lock ────────────────────────────────────────────────────────────
document.getElementById('rage-lock-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  const on = this.classList.contains('on')
  ipcRenderer.send('set-setting', 'rageLockEnabled', on)
  document.getElementById('rage-lock-settings').style.display = on ? 'block' : 'none'
})

document.querySelectorAll('.rage-thresh-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.rage-thresh-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'rageLockThreshold', parseInt(this.dataset.val))
  })
})

document.querySelectorAll('.rage-dur-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.rage-dur-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'rageLockMinutes', parseInt(this.dataset.min))
  })
})

document.getElementById('manual-lock-btn')?.addEventListener('click', () => {
  ipcRenderer.send('manual-rage-lock', 30)
  document.getElementById('rage-lock-status').style.display = 'block'
  setEl('rage-lock-reason','textContent','Manually locked — take a break!')
})

document.getElementById('manual-unlock-btn')?.addEventListener('click', () => {
  ipcRenderer.send('unlock-rage-lock')
  document.getElementById('rage-lock-status').style.display = 'none'
})

ipcRenderer.on('rage-lock-activated', (e, data) => {
  document.getElementById('rage-lock-status').style.display = 'block'
  setEl('rage-lock-reason','textContent',`${data.reason} — locked for ${data.minutes} min`)
})

ipcRenderer.on('rage-lock-deactivated', () => {
  document.getElementById('rage-lock-status').style.display = 'none'
})

// ── Psychology Score ────────────────────────────────────────────────────
async function loadPsychScore() {
  const score = await ipcRenderer.invoke('get-psychology-score')
  if (!score) return
  const numEl = document.getElementById('psych-score-num')
  if(!numEl) return
  const gradeEl = document.getElementById('psych-grade')
  if(!gradeEl) return
  const issuesEl = document.getElementById('psych-issues')
  numEl.textContent = score.score
  numEl.style.color = score.score >= 80 ? 'var(--green)' : score.score >= 60 ? 'var(--gold)' : 'var(--red)'
  gradeEl.textContent = `Grade: ${score.grade}`
  gradeEl.style.color = numEl.style.color
  issuesEl.innerHTML = [
    ...score.issues.map(i => `<div style="color:var(--red);margin-bottom:4px;">⚠️ ${i}</div>`),
    ...score.wins.map(w => `<div style="color:var(--green);margin-bottom:4px;">✅ ${w}</div>`)
  ].join('')
}

document.getElementById('refresh-psych-btn')?.addEventListener('click', loadPsychScore)


// Dev unlock in settings
document.getElementById('dev-unlock-settings-btn')?.addEventListener('click', async () => {
  const pwd = document.getElementById('dev-pwd-settings')?.value
  const err = document.getElementById('dev-unlock-error')
  try {
    const res = await fetch('http://localhost:3001/auth', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:pwd})
    })
    const data = await res.json()
    if (data.success) {
      localStorage.setItem('dev_token', data.token)
      document.getElementById('dev-lock-in-settings').style.display = 'none'
      document.getElementById('dev-controls-in-settings').style.display = 'block'
      if(err) err.textContent = ''
    } else {
      if(err) err.textContent = '❌ Wrong password'
    }
  } catch(e) {
    if(err) err.textContent = '❌ Dev server not running'
  }
})

document.getElementById('dev-change-pwd-settings')?.addEventListener('click', async () => {
  const pwd = document.getElementById('dev-new-pwd-settings')?.value
  if (!pwd || pwd.length < 8) return
  await fetch('http://localhost:3001/api/control', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+localStorage.getItem('dev_token')},
    body:JSON.stringify({action:'changePassword',value:pwd})
  }).catch(() => {})
  localStorage.setItem('dev_token', pwd)
  setEl('dev-new-pwd-settings','value','')
})

// ── More page sub-tabs ───────────────────────────────────────────────────
function openMoreTab(name) {
  document.querySelectorAll('#others-subnav .others-tab').forEach(t => t.classList.toggle('active', t.dataset.othersTab === name))
  document.querySelectorAll('#page-5 .others-tab-content').forEach(c => c.classList.toggle('active', c.id === 'others-' + name))
  if (name === 'study') loadStudyLibrary()
  if (name === 'life') { try { window.loadQuests?.() } catch (e) {} }
  if (name === 'memory') loadMemories()
  if (name === 'intel') loadIntel()
}
document.querySelectorAll('#others-subnav .others-tab').forEach(tab => {
  tab.addEventListener('click', function() {
    openMoreTab(this.dataset.othersTab)
  })
})

// More defaults to Memory — Customize is its own top tab
openMoreTab('memory')

// Shortcuts into character look / select overlays
document.getElementById('more-open-look')?.addEventListener('click', () => {
  document.getElementById('edit-page')?.classList.remove('open')
  document.getElementById('customize-page')?.classList.add('open')
  try { initCustWaifu(); loadCustSettings() } catch (e) {}
})
document.getElementById('more-open-character')?.addEventListener('click', () => {
  document.getElementById('customize-page')?.classList.remove('open')
  document.getElementById('edit-page')?.classList.add('open')
  try { buildCharRow(); initEditWaifu() } catch (e) {}
})


// ── ✨ Intelligence tab (brain stats + live swarm + what she knows) ─────────
async function loadIntel() {
  loadBrainStats()
  loadPrecisionScoreboard()
  loadWhatSheKnows()
  loadRules()
  loadReplays()
}

// ── Study Library (Others → Study) ──
document.getElementById('open-classroom-btn')?.addEventListener('click', () => ipcRenderer.invoke('open-classroom').catch(()=>{}))
async function loadStudyLibrary() {
  const el = document.getElementById('study-library-list')
  if (!el) return
  const lib = (await ipcRenderer.invoke('get-lesson-library').catch(()=>null)) || {}
  if (!Array.isArray(lib.lessons)) lib.lessons = []
  const badge = document.getElementById('lib-count-badge')
  if(!badge) return
  if (badge) badge.textContent = `${lib.lessons.length} saved`
  if (!lib.lessons.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;text-align:center;padding:20px;">No lessons yet. Tap "New Lesson" to upload a document.</div>'; return }
  el.innerHTML = lib.lessons.map(l => `<div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:11px 13px;margin-bottom:7px;">
    <div style="cursor:pointer;flex:1;" class="sl-open" data-id="${l.id}">
      <div style="font-weight:600;font-size:13px;">${l.topic}</div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px;">${l.beatCount} beats · ${(l.source||[]).join(', ')} · ${new Date(l.ts).toLocaleDateString()}</div>
    </div>
    <span class="sl-pdf" data-id="${l.id}" style="cursor:pointer;color:var(--text2);font-size:12px;padding-left:10px;">⬇ PDF</span>
    <span class="sl-rm" data-id="${l.id}" style="cursor:pointer;color:var(--red);font-size:14px;padding-left:10px;">🗑</span>
  </div>`).join('')
  el.querySelectorAll('.sl-open').forEach(x => x.onclick = () => ipcRenderer.invoke('open-lesson', { id: x.dataset.id }).catch(()=>{}))
  el.querySelectorAll('.sl-pdf').forEach(x => x.onclick = async (ev) => { ev.stopPropagation(); x.textContent = '…'; const r = await ipcRenderer.invoke('export-lesson-pdf', { id: x.dataset.id }).catch(()=>null); x.textContent = r?.ok ? '✓ saved' : '⬇ PDF'; setTimeout(()=>x.textContent='⬇ PDF', 2000) })
  el.querySelectorAll('.sl-rm').forEach(x => x.onclick = async (ev) => { ev.stopPropagation(); await ipcRenderer.invoke('remove-lesson', { id: x.dataset.id }).catch(()=>{}); loadStudyLibrary() })
}

// ── Your Rules ──
async function loadRules() {
  const rules = await ipcRenderer.invoke('get-user-rules').catch(()=>[])
  const el = document.getElementById('rules-list')
  if (!el) return
  if (!rules.length) { el.innerHTML = '<div style="color:var(--text2);font-size:11px;">No rules yet. She\'ll follow any you add.</div>'; return }
  el.innerHTML = rules.map((r,i) => `<div style="display:flex;justify-content:space-between;align-items:center;background:var(--bg3);border-radius:8px;padding:8px 10px;margin-bottom:5px;">
    <span style="font-size:12px;">${i+1}. ${r}</span>
    <span data-delrule="${i}" style="cursor:pointer;color:var(--red);font-size:13px;">✕</span></div>`).join('')
  el.querySelectorAll('[data-delrule]').forEach(x => x.onclick = async () => { await ipcRenderer.invoke('delete-user-rule', +x.dataset.delrule).catch(()=>{}); loadRules() })
}
document.getElementById('rule-add')?.addEventListener('click', async () => {
  const inp = document.getElementById('rule-input'); const v = inp.value.trim(); if (!v) return
  await ipcRenderer.invoke('add-user-rule', v).catch(()=>{}); inp.value=''; loadRules()
})
document.getElementById('rule-input')?.addEventListener('keydown', e => { if (e.key==='Enter') document.getElementById('rule-add').click() })

// ── Trade Replay ──
async function loadReplays() {
  const replays = await ipcRenderer.invoke('get-trade-replays').catch(()=>[])
  const el = document.getElementById('replay-list')
  if (!el) return
  if (!replays.length) { el.innerHTML = '<div style="color:var(--text2);font-size:11px;">No trades recorded yet. Run the scanners and decisions will log here.</div>'; return }
  el.innerHTML = replays.slice(0,15).map(r => {
    const dirColor = r.direction==='long'?'var(--green)':'var(--red)'
    const oc = r.outcome==='would_win'||r.outcome==='win'?'✅':r.outcome==='would_lose'||r.outcome==='loss'?'❌':''
    return `<div data-replay="${r.id}" style="background:var(--bg3);border-radius:8px;padding:9px;margin-bottom:5px;cursor:pointer;">
      <div style="display:flex;justify-content:space-between;">
        <span style="font-weight:700;font-size:12px;color:${dirColor};">${(r.direction||'').toUpperCase()} ${r.coin} ${oc}</span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text2);">${r.swarmAgreePct}% · ${r.confidence}%</span>
      </div>
      <div style="font-size:10px;color:var(--text2);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.claudeReason||''}</div>
    </div>`
  }).join('')
  el.querySelectorAll('[data-replay]').forEach(x => x.onclick = () => showReplay(x.dataset.replay, replays))
}
function showReplay(id, replays) {
  const r = replays.find(x => x.id === id); if (!r) return
  const d = document.getElementById('replay-detail')
  if(!d) return
  const when = new Date(r.timestamp).toLocaleString()
  const agreeVotes = (r.agentVotes||[]).filter(v=>v.agree).length
  d.style.display = 'block'
  d.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px;">
    <div style="font-family:var(--display);font-size:14px;margin-bottom:8px;">${(r.direction||'').toUpperCase()} ${r.coin} <span style="font-size:10px;color:var(--text2);">${when}</span></div>
    <div style="font-size:11px;line-height:1.6;">
      <div><b>Claude's read:</b> ${r.claudeReason||'—'}</div>
      <div><b>Market bias:</b> ${r.marketBias||'—'} · <b>Quality:</b> ${r.qualityGrade||'—'} · <b>Mode:</b> ${r.mode||'—'}</div>
      <div style="margin-top:6px;"><b>Agent swarm:</b> ${agreeVotes}/${r.agentsTotal} agreed (${r.swarmAgreePct}%), ${r.agentsChanged} changed mind</div>
      ${r.bullArg?`<div style="color:var(--green);">🐂 ${r.bullArg}</div>`:''}
      ${r.bearArg?`<div style="color:var(--red);">🐻 ${r.bearArg}</div>`:''}
      <div style="margin-top:6px;"><b>Entry:</b> ${r.entry} · <b>Target:</b> ${r.target} · <b>Stop:</b> ${r.stopLoss}</div>
      ${r.finalReason?`<div style="margin-top:6px;"><b>Final call:</b> ${r.finalReason}</div>`:''}
      ${r.outcome?`<div style="margin-top:6px;"><b>Outcome:</b> ${r.outcome} ${r.pnl?`(${r.pnl})`:''}</div>`:'<div style="margin-top:6px;color:var(--text2);">Outcome pending...</div>'}
    </div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;margin-top:8px;">
      ${(r.agentVotes||[]).map(v=>`<div style="text-align:center;font-size:8px;color:var(--text2);background:var(--bg3);border-radius:5px;padding:3px;">${v.role}<br><span style="color:${v.agree?'var(--green)':'var(--red)'};">${v.agree?'✓':'✗'}</span></div>`).join('')}
    </div>
  </div>`
  d.scrollIntoView({ behavior:'smooth', block:'nearest' })
}

async function loadBrainStats() {
  const b = await ipcRenderer.invoke('get-brain-stats').catch(()=>null)
  const el = document.getElementById('brain-stats')
  if(!el) return
  if (!b || b.error) { el.innerHTML = '<div style="color:var(--text2);font-size:11px;grid-column:1/3;">No data yet — run the scanners a while.</div>'; return }
  const card = (label, val, sub, color) => `<div style="background:var(--bg3);border-radius:10px;padding:10px;">
    <div style="font-size:10px;color:var(--text2);">${label}</div>
    <div style="font-family:'JetBrains Mono',monospace;font-size:20px;font-weight:700;color:${color||'var(--text)'};">${val}</div>
    ${sub?`<div style="font-size:9px;color:var(--text2);">${sub}</div>`:''}</div>`
  const trendStr = b.trend == null ? '' : b.trend > 0 ? `▲ +${b.trend}% improving` : b.trend < 0 ? `▼ ${b.trend}%` : '→ steady'
  const trendColor = b.trend > 0 ? 'var(--green)' : b.trend < 0 ? 'var(--red)' : 'var(--text2)'
  el.innerHTML =
    card('Shadow win-rate', b.winRate != null ? b.winRate+'%' : '—', `${b.resolvedTrades} resolved`, 'var(--accent)') +
    card('Trend', trendStr || '—', b.recentWR!=null?`recent ${b.recentWR}%`:'', trendColor) +
    card('Veteran agents', `${b.vetAgents}/${b.totalAgents}`, '5+ votes each', 'var(--violet)') +
    card('Lessons learned', b.lessonsLearned, b.topAgent?`top: ${b.topAgent.role} ${b.topAgent.accuracy}%`:'', 'var(--sakura)')
}

async function loadPrecisionScoreboard() {
  const el = document.getElementById('precision-scoreboard')
  if (!el) return
  const s = await ipcRenderer.invoke('get-precision-scoreboard').catch(() => null)
  if (!s || s.error) {
    el.innerHTML = `<div class="sb-empty">${s?.error || 'No precision data yet.'}<br><span style="color:var(--text2);">Turn on Independent Scanner + Precision, then let shadows resolve.</span></div>`
    return
  }
  const t = s.totals || {}
  const hold = t.holdoutWinRate
  const holdClass = hold == null ? '' : hold >= 55 ? 'up' : hold < 45 ? 'down' : 'accent'
  const status = (t.holdout || 0) < 10
    ? '<span class="sb-status wait">collecting holdout</span>'
    : hold != null && hold >= 55
      ? '<span class="sb-status ok">holdout ok</span>'
      : '<span class="sb-status warn">review edge</span>'

  let html = `<div class="sb-hero">
    <div class="sb-metric"><div class="sb-metric-label">Resolved</div><div class="sb-metric-val">${t.resolved || 0}</div><div class="sb-metric-sub">${t.structuredShadows || 0} structured</div></div>
    <div class="sb-metric"><div class="sb-metric-label">Holdout WR</div><div class="sb-metric-val ${holdClass}">${hold != null ? hold + '%' : '—'}</div><div class="sb-metric-sub">${t.holdout || 0} OOS · ${status}</div></div>
    <div class="sb-metric"><div class="sb-metric-label">In-sample WR</div><div class="sb-metric-val">${t.inSampleWinRate != null ? t.inSampleWinRate + '%' : '—'}</div><div class="sb-metric-sub">${t.inSample || 0} samples</div></div>
    <div class="sb-metric"><div class="sb-metric-label">Setups tracked</div><div class="sb-metric-val accent">${(s.expectancy || []).length}</div><div class="sb-metric-sub">expectancy rows</div></div>
  </div>`

  const night = s.nightly
  if (night?.at) {
    const p = night.paper || {}
    const when = new Date(night.at).toLocaleString()
    html += `<div class="sb-section"><div class="sb-section-title"><span>Last nightly report</span><button id="precision-run-nightly" class="as-btn as-btn-data" style="font-size:10px;padding:4px 10px;">Run now</button></div>
      <div class="sb-row"><span class="sb-row-k">${when}</span><span class="sb-row-v">${p.wins || 0}W/${p.losses || 0}L · ${p.winRate != null ? p.winRate + '%' : '—'} · P&L ${Number(p.totalPnl || 0) >= 0 ? '+' : ''}$${Number(p.totalPnl || 0).toFixed(2)}</span></div>
      <div class="sb-empty" style="padding:8px 12px;">Telegram every day at 23:55 UTC. Daily RSI paper bot stays enabled.</div>
    </div>`
  } else {
    html += `<div class="sb-section"><div class="sb-section-title"><span>Nightly report</span><button id="precision-run-nightly" class="as-btn as-btn-data" style="font-size:10px;padding:4px 10px;">Run now</button></div>
      <div class="sb-empty" style="padding:12px;">No report yet — scheduled 23:55 UTC, or tap Run now.</div></div>`
  }

  const ab = s.featureAB || {}
  html += '<div class="sb-section"><div class="sb-section-title"><span>Gate quality</span></div>'
  const abEntries = Object.entries(ab)
  if (!abEntries.length) html += '<div class="sb-empty" style="padding:12px;">Gates will appear after blocked shadows resolve.</div>'
  else {
    for (const [feat, v] of abEntries) {
      const val = v.status === 'need_more_data' || v.status === 'collecting'
        ? `n=${v.n} · collecting`
        : `${v.precision ?? '—'}% good blocks · ${v.status} (n=${v.n})`
      html += `<div class="sb-row"><span class="sb-row-k">${feat}</span><span class="sb-row-v">${val}</span></div>`
    }
  }
  html += '</div>'

  html += '<div class="sb-section"><div class="sb-section-title"><span>Expectancy</span></div>'
  const exp = (s.expectancy || []).slice(0, 8)
  if (!exp.length) html += '<div class="sb-empty" style="padding:12px;">Closes with setupType fill this table.</div>'
  else for (const e of exp) {
    const eClass = (e.expectancy || 0) > 0.15 ? 'color:var(--green)' : (e.expectancy || 0) <= 0 ? 'color:var(--red)' : ''
    html += `<div class="sb-row"><span class="sb-row-k">${e.key}</span><span class="sb-row-v" style="${eClass}">E=${e.expectancy ?? '—'} · ${e.winRate ?? '—'}% · n=${e.n}</span></div>`
  }
  html += '</div>'

  const setups = (s.bySetup || []).slice(0, 6)
  if (setups.length) {
    html += '<div class="sb-section"><div class="sb-section-title"><span>By setup (shadows)</span></div>'
    for (const b of setups) {
      html += `<div class="sb-row"><span class="sb-row-k">${b.key}</span><span class="sb-row-v">${b.winRate ?? '—'}% · n=${b.n}</span></div>`
    }
    html += '</div>'
  }

  const paper = (s.paperBySetup || []).slice(0, 6)
  if (paper.length) {
    html += '<div class="sb-section"><div class="sb-section-title"><span>Paper by setup</span></div>'
    for (const b of paper) {
      const pnl = Number(b.pnl || 0)
      const eClass = pnl > 0 ? 'color:var(--green)' : pnl < 0 ? 'color:var(--red)' : ''
      html += `<div class="sb-row"><span class="sb-row-k">${b.key}</span><span class="sb-row-v" style="${eClass}">${b.winRate ?? '—'}% · $${pnl.toFixed(2)} · n=${b.n}</span></div>`
    }
    html += '</div>'
  }

  const tiers = (s.byTier || []).slice(0, 5)
  const regimes = (s.byRegime || []).slice(0, 5)
  if (tiers.length || regimes.length) {
    html += '<div class="sb-section"><div class="sb-section-title"><span>Tier / regime</span></div><div class="sb-chip-row">'
    for (const b of tiers) html += `<span class="sb-chip">tier ${b.key} · ${b.winRate}% (${b.n})</span>`
    for (const b of regimes) html += `<span class="sb-chip">regime ${b.key} · ${b.winRate}% (${b.n})</span>`
    html += '</div></div>'
  }

  const blocked = (s.byBlockedBy || []).slice(0, 6)
  if (blocked.length) {
    html += '<div class="sb-section"><div class="sb-section-title"><span>Blocked by</span></div>'
    for (const b of blocked) {
      html += `<div class="sb-row"><span class="sb-row-k">${b.key}</span><span class="sb-row-v">${b.n} · avoid-proxy ${b.winRate}%</span></div>`
    }
    html += '</div>'
  }

  el.innerHTML = html
  document.getElementById('precision-run-nightly')?.addEventListener('click', async () => {
    const btn = document.getElementById('precision-run-nightly')
    if (btn) { btn.disabled = true; btn.textContent = 'Running…' }
    await ipcRenderer.invoke('run-precision-nightly-now').catch(() => null)
    await loadPrecisionScoreboard()
  })
}
document.getElementById('precision-refresh')?.addEventListener('click', () => loadPrecisionScoreboard())
document.querySelector('[data-others-tab="intel"]')?.addEventListener('click', () => {
  setTimeout(() => { loadPrecisionScoreboard(); loadBrainStats(); }, 300)
})

async function loadWhatSheKnows() {
  const k = await ipcRenderer.invoke('get-what-she-knows').catch(()=>null)
  const el = document.getElementById('knows-content')
  if(!el) return
  if (!k || k.error) { el.innerHTML = '<div style="color:var(--text2);font-size:11px;">Talk to her more and she\'ll learn about you.</div>'; return }
  let html = ''
  if (k.bondTier) html += `<div style="margin-bottom:10px;"><span class="as-pill as-pill-her">${k.bondTier}</span></div>`
  if (k.trading?.length) {
    html += '<div style="font-size:11px;font-weight:700;margin-bottom:6px;">📈 Trading</div>'
    html += k.trading.map(t => `<div style="display:flex;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:1px solid var(--border2);"><span style="color:var(--text2);">${t.k}</span><span>${t.v}</span></div>`).join('')
  }
  if (k.learning?.length) {
    html += '<div style="font-size:11px;font-weight:700;margin:10px 0 6px;">📚 Learning</div>'
    html += k.learning.map(l => `<div style="display:flex;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:1px solid var(--border2);"><span style="color:var(--text2);">${l.goal} (${l.level})</span><span>${l.covered} topics${l.weakSpots?` · ${l.weakSpots} weak`:''}</span></div>`).join('')
  }
  if (!html) html = '<div style="color:var(--text2);font-size:11px;">Still getting to know you — keep chatting, trading, and learning together.</div>'
  el.innerHTML = html
}
// Live swarm — agents stream in as they vote
ipcRenderer.on('swarm-live', (e, data) => {
  const status = document.getElementById('swarm-status')
  const summary = document.getElementById('swarm-summary')
  const grid = document.getElementById('swarm-grid')
  const args = document.getElementById('swarm-args')
  if (!grid) return
  if (status) { status.textContent = 'live'; status.style.background = 'rgba(52,211,153,0.15)'; status.style.color = 'var(--green)' }
  if (summary) summary.innerHTML = `${(data.direction||'').toUpperCase()} ${data.coin} — <b style="color:${data.agreePct>=60?'var(--green)':data.agreePct>=50?'var(--gold)':'var(--red)'}">${data.agreePct}% agree</b> · ${data.changed} changed mind`
  // Render each agent as a chip, animating in
  grid.innerHTML = (data.agents||[]).map((a, i) => {
    const c = a.agree ? 'var(--green)' : 'var(--red)'
    const acc = a.accuracy != null ? a.accuracy+'%' : ''
    return `<div style="background:var(--bg3);border:1px solid ${a.agree?'rgba(52,211,153,0.3)':'rgba(251,113,133,0.3)'};border-radius:8px;padding:6px;text-align:center;opacity:0;animation:fadeIn .3s ease forwards;animation-delay:${i*40}ms;">
      <div style="font-size:9px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${a.role}</div>
      <div style="font-size:13px;color:${c};">${a.agree?'✓':'✗'}</div>
      ${acc?`<div style="font-size:8px;color:var(--text3);font-family:'JetBrains Mono',monospace;">${acc}</div>`:''}
    </div>`
  }).join('')
  if (args) args.innerHTML = (data.bullArg||data.bearArg) ? `${data.bullArg?`<div style="color:var(--green);">🐂 ${data.bullArg}</div>`:''}${data.bearArg?`<div style="color:var(--red);margin-top:4px;">🐻 ${data.bearArg}</div>`:''}` : ''
  setTimeout(() => { if (status) { status.textContent='idle'; status.style.background='rgba(45,212,255,0.12)'; status.style.color='var(--data)' } }, 8000)
})


// ── 📣 Advisor Calls tab ───────────────────────────────────────────────
document.getElementById('global-rules-btn')?.addEventListener('click', () => openRulesPanel(null, null))

// ── 🏆 Advisor leaderboard — who's actually good, by executed results ──
async function renderAdvisorLeaderboard() {
  const el = document.getElementById('adv-leaderboard')
  if (!el) return
  const raw = await ipcRenderer.invoke('advisor-leaderboard').catch(() => [])
  const rows = (Array.isArray(raw) ? raw : (raw?.rows || [])).filter(x => (x.trades || 0) > 0 || (x.open || 0) > 0)
  if (!rows.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px 0;">No executed advisor results yet.</div>'; return }
  el.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text3);letter-spacing:.05em;margin-bottom:8px;">🏆 LEADERBOARD — EXECUTED RESULTS</div>` +
    rows.map((x,i) => `<div style="display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border);border-radius:11px;padding:10px 14px;margin-bottom:6px;">
      <div style="font-size:14px;width:26px;">${['🥇','🥈','🥉'][i] || (i+1)+'.'}</div>
      <div style="flex:1;"><div style="font-size:13px;font-weight:600;">${x.name}</div>
        <div style="font-size:10px;color:var(--text3);">${x.trades||0} closed · ${x.open||0} open · ${x.mode||'—'}</div></div>
      <div style="text-align:right;">
        <div style="font-family:monospace;font-size:13px;font-weight:700;color:${(x.pnl||0)>=0?'var(--green)':'var(--red)'};">${(x.pnl||0)>=0?'+':''}$${Math.abs(x.pnl||0).toFixed(2)}</div>
        <div style="font-size:10px;color:var(--text3);">${x.winRate==null?'—':x.winRate+'% win'} (${x.wins||0}W/${x.losses||0}L)</div>
      </div>
    </div>`).join('')
}
window.renderAdvisorLeaderboard = renderAdvisorLeaderboard
setInterval(renderAdvisorLeaderboard, 30000)
setTimeout(renderAdvisorLeaderboard, 1500)
function timeAgo(ts) {
  const s = Math.floor((Date.now()-ts)/1000)
  if (s<60) return 'just now'
  if (s<3600) return Math.floor(s/60)+'m ago'
  if (s<86400) return Math.floor(s/3600)+'h ago'
  return new Date(ts).toLocaleDateString()
}
function loadAdvisorTab() {
  // run both independently so one failing/hanging never blocks the other
  renderAdvisors().catch(e => console.error('renderAdvisors', e))
  renderCalls().catch(e => console.error('renderCalls', e))
}
async function renderAdvisors() {
  const el = document.getElementById('advisor-list'); if (!el) return
  const advisors = await Promise.race([
    ipcRenderer.invoke('get-advisor-stats').catch(()=>[]),
    new Promise(r => setTimeout(() => r([]), 4000))
  ])
  if (!advisors.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:10px;">No advisors set up yet. Add them in the dev panel.</div>'; return }
  el.innerHTML = advisors.map((a, idx) => {
    const wr = a.winRate
    const rank = idx === 0 && advisors.length > 1 ? '<span style="font-size:10px;background:var(--gold);color:#000;padding:2px 7px;border-radius:99px;font-weight:700;margin-left:6px;">🏆 #1</span>' : ''
    const pnlColor = a.realizedPnl > 0 ? 'var(--green)' : a.realizedPnl < 0 ? 'var(--red)' : 'var(--text3)'
    const pnlStr = a.realizedPnl ? `${a.realizedPnl>0?'+':''}$${a.realizedPnl}` : '—'
    const modeBtn = (m, icon, label) => `<button class="adv-mode" data-adv="${a.id}" data-mode="${m}" style="flex:1;padding:8px;border-radius:9px;font-size:11px;cursor:pointer;border:1px solid ${a.followMode===m?'var(--accent)':'var(--border)'};background:${a.followMode===m?'var(--accent)':'var(--bg3)'};color:${a.followMode===m?'#fff':'var(--text2)'};">${icon} ${label}</button>`
    return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <div style="width:46px;height:46px;border-radius:50%;background:${a.avatar?`url('${a.avatar}') center/cover`:'var(--asuka-grad)'};flex-shrink:0;"></div>
        <div style="flex:1;">
          <div style="font-weight:600;font-size:15px;">${a.name}${rank}</div>
          <div style="font-size:12px;color:var(--text3);">${a.handle||''}${a.totalCalls?` · ${a.totalCalls} call${a.totalCalls!==1?'s':''}`:' · no calls yet'}</div>
        </div>
      </div>
      ${a.bio?`<div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.5;">${a.bio}</div>`:''}
      <div style="display:flex;gap:8px;margin-bottom:12px;">
        <div style="flex:1;background:var(--bg3);border-radius:10px;padding:9px;text-align:center;"><div style="font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:600;color:${wr>=50?'var(--green)':wr!=null?'var(--red)':'var(--text2)'};">${wr!=null?wr+'%':'—'}</div><div style="font-size:9px;color:var(--text3);">win rate</div></div>
        <div style="flex:1;background:var(--bg3);border-radius:10px;padding:9px;text-align:center;"><div style="font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:600;">${a.openCalls}</div><div style="font-size:9px;color:var(--text3);">open</div></div>
        <div style="flex:1;background:var(--bg3);border-radius:10px;padding:9px;text-align:center;"><div style="font-family:'JetBrains Mono',monospace;font-size:16px;font-weight:600;color:${pnlColor};">${pnlStr}</div><div style="font-size:9px;color:var(--text3);">your P&L</div></div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px;">
        ${modeBtn('notify','🔔','Notify')}
        ${modeBtn('auto','⚡','Auto-trade')}
        ${modeBtn('trial','🕶️','Trial')}
        ${modeBtn('off','🔇','Off')}
      </div>
      <div id="adv-risk-${a.id}" style="display:${a.followMode==='auto'?'block':'none'};">
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <div style="flex:1;"><div style="font-size:10px;color:var(--text3);margin-bottom:3px;">$ per call</div><input type="number" class="tg-input adv-risk" data-adv="${a.id}" data-field="risk" value="${a.riskUsd||50}" style="width:100%;font-size:12px;padding:8px;"></div>
          <div style="flex:1;"><div style="font-size:10px;color:var(--text3);margin-bottom:3px;">Max $/day</div><input type="number" class="tg-input adv-risk" data-adv="${a.id}" data-field="cap" value="${a.maxPerDay||200}" style="width:100%;font-size:12px;padding:8px;"></div>
        </div>
        <div style="font-size:10px;color:var(--text3);margin-bottom:4px;">When they edit/close a trade mid-way:</div>
        <div style="display:flex;gap:6px;">
          <button class="adv-auton" data-adv="${a.id}" data-auton="full" style="flex:1;padding:7px;border-radius:8px;font-size:10px;cursor:pointer;border:1px solid ${(a.autonomyMode||'confirm')==='full'?'var(--accent)':'var(--border)'};background:${(a.autonomyMode||'confirm')==='full'?'var(--accent)':'var(--bg3)'};color:${(a.autonomyMode||'confirm')==='full'?'#fff':'var(--text2)'};">⚡ Full auto</button>
          <button class="adv-auton" data-adv="${a.id}" data-auton="confirm" style="flex:1;padding:7px;border-radius:8px;font-size:10px;cursor:pointer;border:1px solid ${(a.autonomyMode||'confirm')==='confirm'?'var(--accent)':'var(--border)'};background:${(a.autonomyMode||'confirm')==='confirm'?'var(--accent)':'var(--bg3)'};color:${(a.autonomyMode||'confirm')==='confirm'?'#fff':'var(--text2)'};">✋ Ask me first</button>
        </div>
      </div>
      <div style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px;">
        <div style="display:flex;gap:8px;">
          <button class="adv-trades-btn" data-adv="${a.id}" style="flex:1;padding:8px;border-radius:9px;font-size:11px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">📈 Current Trades${a.openCalls?` (${a.openCalls})`:''}</button>
          <button class="adv-history-btn" data-adv="${a.id}" style="flex:1;padding:8px;border-radius:9px;font-size:11px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text2);">🕓 History</button>
          <button class="adv-rules-btn" data-adv="${a.id}" data-name="${a.name}" style="flex:1;padding:8px;border-radius:9px;font-size:11px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text2);">⚙️ My Rules</button>
        </div>
        <div class="adv-trades-panel" id="adv-trades-${a.id}" style="display:none;margin-top:10px;"></div>
      </div>
    </div>`
  }).join('')
  // wire trades + history buttons
  el.querySelectorAll('.adv-trades-btn').forEach(b => b.onclick = () => toggleAdvisorTrades(b.dataset.adv, false))
  el.querySelectorAll('.adv-history-btn').forEach(b => b.onclick = () => toggleAdvisorTrades(b.dataset.adv, true))
  el.querySelectorAll('.adv-rules-btn').forEach(b => b.onclick = () => openRulesPanel(b.dataset.adv, b.dataset.name))
  // wire mode buttons
  el.querySelectorAll('.adv-mode').forEach(b => b.onclick = async () => {
    await ipcRenderer.invoke('set-advisor-mode', { advisorId: b.dataset.adv, mode: b.dataset.mode }).catch(()=>{})
    renderAdvisors()
  })
  // wire risk inputs
  el.querySelectorAll('.adv-risk').forEach(inp => inp.onchange = async () => {
    const adv = inp.dataset.adv
    const risk = el.querySelector(`.adv-risk[data-adv="${adv}"][data-field="risk"]`)?.value
    const cap = el.querySelector(`.adv-risk[data-adv="${adv}"][data-field="cap"]`)?.value
    await ipcRenderer.invoke('set-advisor-risk', { advisorId: adv, riskUsd: parseFloat(risk)||50, maxPerDay: parseFloat(cap)||200 }).catch(()=>{})
  })
  el.querySelectorAll('.adv-auton').forEach(b => b.onclick = async () => {
    await ipcRenderer.invoke('set-advisor-autonomy', { advisorId: b.dataset.adv, autonomyMode: b.dataset.auton }).catch(()=>{})
    renderAdvisors()
  })
}
async function renderCalls() {
  const el = document.getElementById('calls-feed'); if (!el) return
  const calls = await Promise.race([
    ipcRenderer.invoke('get-advisor-calls').catch(()=>[]),
    new Promise(r => setTimeout(() => r([]), 4000))
  ])
  if (!calls.length) { el.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:20px;text-align:center;">No calls yet. When your advisor posts, they show here.</div>'; return }
  el.innerHTML = calls.slice(0,30).map(c => {
    const dirColor = c.direction==='long'?'var(--green)':'var(--red)'
    const when = new Date(c.timestamp).toLocaleString()
    // Update items (close/edit) render compact + distinct
    if (c.isUpdate) {
      const label = c.updateType==='close'?'🔴 CLOSE':c.updateType==='update_sl'?'✏️ Move SL':c.updateType==='update_tp'?'✏️ Move TP':c.updateType==='add'?'➕ Add to':'✏️ Update'
      return `<div style="background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--gold);border-radius:12px;padding:12px 14px;margin-bottom:9px;">
        <div style="font-size:13px;font-weight:600;">${label} ${c.coin} ${c.sl?`<span style="color:var(--red);font-family:'JetBrains Mono',monospace;font-size:11px;">SL ${c.sl}</span>`:''} ${c.tp?`<span style="color:var(--green);font-family:'JetBrains Mono',monospace;font-size:11px;">TP ${c.tp}</span>`:''}</div>
        ${c.reasoning?`<div style="font-size:12px;color:var(--text2);margin-top:5px;">${c.reasoning}</div>`:''}
        <div style="font-size:10px;color:var(--text3);margin-top:6px;">${c.advisorName} · ${when}</div>
      </div>`
    }
    const oc = c.outcome==='win'?'<span style="color:var(--green);">✅ Hit TP</span>':c.outcome==='loss'?'<span style="color:var(--red);">❌ Hit SL</span>':'<span style="color:var(--text3);">● Open</span>'
    return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:15px;margin-bottom:11px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:600;"><span style="color:${dirColor};">${(c.direction||'').toUpperCase()}</span> ${c.coin}</div>
        <div style="font-size:11px;">${oc}</div>
      </div>
      ${c.image?`<img src="${c.image}" style="width:100%;border-radius:10px;margin-bottom:8px;max-height:240px;object-fit:cover;">`:''}
      <div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:10px;">${c.reasoning||''}</div>
      <div style="display:flex;gap:8px;">
        <div style="flex:1;background:var(--bg3);border-radius:8px;padding:7px;text-align:center;"><div style="font-size:9px;color:var(--text3);">ENTRY</div><div style="font-family:'JetBrains Mono',monospace;font-size:13px;">${c.entry ?? 'market'}</div></div>
        ${c.tp?`<div style="flex:1;background:var(--bg3);border-radius:8px;padding:7px;text-align:center;"><div style="font-size:9px;color:var(--text3);">TARGET</div><div style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--green);">${c.tp}</div></div>`:''}
        ${c.sl?`<div style="flex:1;background:var(--bg3);border-radius:8px;padding:7px;text-align:center;"><div style="font-size:9px;color:var(--text3);">STOP</div><div style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--red);">${c.sl}</div></div>`:''}
      </div>
      <div style="font-size:10px;color:var(--text3);margin-top:10px;">${c.advisorName} · ${timeAgo(c.timestamp)}</div>
    </div>`
  }).join('')
}


// Advisor mid-trade action needs user confirmation (autonomyMode = 'confirm')
ipcRenderer.on('advisor-confirm', (e, d) => {
  const verb = d.action==='close'?'close':d.action==='update_sl'?'move stop on':d.action==='update_tp'?'move target on':'update'
  const detail = d.sl?`new SL ${d.sl}`:d.tp?`new TP ${d.tp}`:''
  let bar = document.getElementById('advisor-confirm-bar')
  if (!bar) { bar = document.createElement('div'); bar.id='advisor-confirm-bar'
    bar.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10003;background:var(--bg2);border:1px solid var(--gold);border-radius:14px;padding:14px 18px;box-shadow:0 10px 40px rgba(0,0,0,.5);max-width:420px;'
    document.body.appendChild(bar) }
  bar.innerHTML = `<div style="font-size:13px;margin-bottom:10px;"><b>${d.advisorName}</b> wants to <b>${verb} ${d.coin}</b>${detail?` (${detail})`:''}.</div>
    <div style="display:flex;gap:8px;">
      <button id="adv-confirm-yes" style="flex:1;padding:9px;border-radius:9px;border:none;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;">Apply</button>
      <button id="adv-confirm-no" style="flex:1;padding:9px;border-radius:9px;border:1px solid var(--border);background:var(--bg3);color:var(--text2);cursor:pointer;">Dismiss</button>
    </div>`
  document.getElementById('adv-confirm-yes').onclick = async () => {
    await ipcRenderer.invoke('advisor-confirm-action', { tradeId:d.tradeId, action:d.action, sl:d.sl, tp:d.tp }).catch(()=>{})
    bar.remove()
  }
  document.getElementById('adv-confirm-no').onclick = () => bar.remove()
})

// live update when a new call arrives

// ── Per-advisor trades view (current + history) with live P&L + user edit ──
let _advTradesTimer = null
async function toggleAdvisorTrades(advisorId, history) {
  const panel = document.getElementById('adv-trades-'+advisorId)
  if (!panel) return
  const isOpen = panel.style.display !== 'none' && panel.dataset.history === String(history)
  // close any other open panels
  document.querySelectorAll('.adv-trades-panel').forEach(p => { if (p!==panel) p.style.display='none' })
  if (isOpen) { panel.style.display='none'; if(_advTradesTimer){clearInterval(_advTradesTimer);_advTradesTimer=null} return }
  panel.style.display='block'; panel.dataset.history=String(history)
  await renderAdvisorTrades(advisorId, history)
  // live refresh open trades every 6s
  if (_advTradesTimer) clearInterval(_advTradesTimer)
  if (!history) _advTradesTimer = setInterval(() => renderAdvisorTrades(advisorId, false), 6000)
}
async function renderAdvisorTrades(advisorId, history) {
  const panel = document.getElementById('adv-trades-'+advisorId); if (!panel) return
  const trades = await ipcRenderer.invoke('get-advisor-trades', { advisorId, history }).catch(()=>[])
  if (!trades.length) { panel.innerHTML = `<div style="color:var(--text3);font-size:11px;padding:10px;text-align:center;">${history?'No past trades yet.':'No open trades right now.'}</div>`; return }
  panel.innerHTML = trades.map(t => {
    const up = (t.pnlUsd||0) >= 0
    const pnlColor = up ? 'var(--green)' : 'var(--red)'
    const dirC = t.direction==='long'?'var(--green)':'var(--red)'
    const live = t.status==='open'
    const pnlStr = `${up?'+':''}$${Math.abs(t.pnlUsd||0).toFixed(2)} (${up?'+':''}${(t.pnlPct||0).toFixed(1)}%)`
    const histStr = `${(t.pnlUsd||0)>=0?'+':''}$${(t.pnlUsd||0).toFixed(2)}`
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-weight:600;font-size:13px;"><span style="color:${dirC};">${(t.direction||'').toUpperCase()}</span> ${t.coin} ${t.leverage>1?`<span style="font-size:10px;color:var(--text3);">${t.leverage}x</span>`:''}</div>
        <div style="font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:600;color:${live?pnlColor:((t.pnlUsd||0)>=0?'var(--green)':'var(--red)')};">${live?pnlStr:histStr}</div>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:${live?'10':'0'}px;">
        <div style="flex:1;background:var(--bg2);border-radius:7px;padding:6px;text-align:center;"><div style="font-size:8px;color:var(--text3);">ENTRY</div><div style="font-family:'JetBrains Mono',monospace;font-size:12px;">${t.entry ?? 'mkt'}</div></div>
        <div style="flex:1;background:var(--bg2);border-radius:7px;padding:6px;text-align:center;"><div style="font-size:8px;color:var(--text3);">${live?'NOW':'CLOSED'}</div><div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--accent);">${live?(t.currentPrice??'—'):(t.closePrice??'—')}</div></div>
        <div style="flex:1;background:var(--bg2);border-radius:7px;padding:6px;text-align:center;"><div style="font-size:8px;color:var(--text3);">TARGET</div><div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--green);">${t.target ?? '—'}</div></div>
        <div style="flex:1;background:var(--bg2);border-radius:7px;padding:6px;text-align:center;"><div style="font-size:8px;color:var(--text3);">STOP</div><div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--red);">${t.stopLoss ?? '—'}</div></div>
      </div>
      ${live ? `<button class="ut-manage" data-id="${t.id}" style="width:100%;padding:9px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--bg2);color:var(--text);">⚙️ Manage Trade</button>` : `<div style="font-size:9px;color:var(--text3);margin-top:6px;">${t.closeTime?new Date(t.closeTime).toLocaleString():''}</div>`}
    </div>`
  }).join('')
  // tap a trade → open the full control panel
  panel.querySelectorAll('.ut-manage').forEach(b => b.onclick = () => openTradePanel(b.dataset.id, advisorId, trades.find(x=>String(x.id)===b.dataset.id)))
}

// ── Pre-trade rules panel (global default OR per-advisor override) ──
async function openRulesPanel(advisorId, advisorName) {
  const all = await ipcRenderer.invoke('get-trade-rules').catch(()=>({global:{},perAdvisor:{}}))
  const isGlobal = !advisorId
  const r = isGlobal ? (all.global||{}) : ((all.perAdvisor&&all.perAdvisor[advisorId])||{})
  const g = all.global || {}
  let modal = document.getElementById('rules-panel')
  if (!modal) { modal = document.createElement('div'); modal.id='rules-panel'; document.body.appendChild(modal) }
  modal.style.cssText='position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;'
  const ph = (k,d)=> isGlobal ? (g[k]??d) : (g[k]!==undefined&&g[k]!==''?`global: ${g[k]}`:d)  // show global as placeholder hint
  const val = (k)=> (r[k]??'')
  modal.innerHTML = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:18px;padding:22px;width:380px;max-width:92vw;max-height:88vh;overflow-y:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <div style="font-size:16px;font-weight:700;">⚙️ ${isGlobal?'Default Rules (all advisors)':'Rules · '+advisorName}</div>
      <div id="rp-x" style="cursor:pointer;color:var(--text3);font-size:20px;">×</div>
    </div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:16px;">${isGlobal?'Applies to every advisor unless they have their own rules.':'Overrides your global defaults for this advisor. Leave blank to use global.'}</div>

    <label style="font-size:12px;color:var(--text2);">💵 $ size per trade</label>
    <input id="rp-size" type="number" value="${val('sizeUsd')}" placeholder="${ph('sizeUsd','50')}" class="s-input" style="margin:5px 0 14px;">

    <label style="font-size:12px;color:var(--text2);">⚡ Max leverage cap (0 = no cap)</label>
    <input id="rp-lev" type="number" value="${val('maxLeverage')}" placeholder="${ph('maxLeverage','0')}" class="s-input" style="margin:5px 0 14px;">

    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2);margin-bottom:8px;cursor:pointer;">
      <input id="rp-usemy" type="checkbox" ${r.useMySlTp?'checked':''}> Use MY stop/target % (ignore advisor's)
    </label>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <div style="flex:1;"><label style="font-size:11px;color:var(--text3);">Stop %</label><input id="rp-sl" type="number" value="${val('slPct')}" placeholder="${ph('slPct','5')}" class="s-input" style="margin-top:4px;"></div>
      <div style="flex:1;"><label style="font-size:11px;color:var(--text3);">Target %</label><input id="rp-tp" type="number" value="${val('tpPct')}" placeholder="${ph('tpPct','10')}" class="s-input" style="margin-top:4px;"></div>
    </div>

    <label style="font-size:12px;color:var(--text2);">📅 Daily max $ (0 = unlimited)</label>
    <input id="rp-dmax" type="number" value="${val('dailyMaxUsd')}" placeholder="${ph('dailyMaxUsd','0')}" class="s-input" style="margin:5px 0 14px;">

    <label style="font-size:12px;color:var(--text2);">🛑 Daily max LOSS $ — halt trading after losing this (0 = off)</label>
    <input id="rp-dloss" type="number" value="${val('dailyMaxLossUsd')}" placeholder="${ph('dailyMaxLossUsd','0')}" class="s-input" style="margin:5px 0 14px;">

    <label style="font-size:12px;color:var(--text2);">📅 Daily max # trades (0 = unlimited)</label>
    <input id="rp-dtrades" type="number" value="${val('dailyMaxTrades')}" placeholder="${ph('dailyMaxTrades','0')}" class="s-input" style="margin:5px 0 14px;">

    <label style="font-size:12px;color:var(--text2);">🛡️ Auto-breakeven at +% profit (0 = off)</label>
    <input id="rp-be" type="number" value="${val('autoBreakevenPct')}" placeholder="${ph('autoBreakevenPct','0')}" class="s-input" style="margin:5px 0 10px;">
    <div style="font-size:11px;color:var(--text3);">📉 Trailing stop % (SL follows the high — 0 = off)</div>
    <input id="rp-trail" type="number" value="${val('trailingPct')}" placeholder="${ph('trailingPct','0')}" class="s-input" style="margin:5px 0 16px;">

    <button id="rp-save" style="width:100%;padding:12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;background:var(--accent);color:#000;">Save Rules</button>
  </div>`
  const close = ()=>modal.remove()
  modal.onclick=(e)=>{ if(e.target===modal) close() }
  modal.querySelector('#rp-x').onclick=close
  modal.querySelector('#rp-save').onclick=async ()=>{
    const num=(id)=>{ const v=document.getElementById(id).value; return v===''?null:Number(v) }
    const rules={
      sizeUsd:num('rp-size'), maxLeverage:num('rp-lev'),
      useMySlTp:document.getElementById('rp-usemy').checked,
      slPct:num('rp-sl'), tpPct:num('rp-tp'),
      dailyMaxUsd:num('rp-dmax'), dailyMaxTrades:num('rp-dtrades'), dailyMaxLossUsd:num('rp-dloss'),
      autoBreakevenPct:num('rp-be'),
      trailingPct:num('rp-trail')
    }
    await ipcRenderer.invoke('set-trade-rules',{ scope:isGlobal?'global':'advisor', advisorId, rules }).catch(()=>{})
    close()
  }
}

// ── Full per-trade control panel (SL/TP/breakeven/partial/add/note/close) ──
function openTradePanel(tradeId, advisorId, t) {
  if (!t) return
  let modal = document.getElementById('trade-panel')
  if (!modal) { modal = document.createElement('div'); modal.id = 'trade-panel'; document.body.appendChild(modal) }
  modal.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;'
  const dirC = t.direction==='long'?'var(--green)':'var(--red)'
  modal.innerHTML = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:18px;padding:20px;width:360px;max-width:92vw;max-height:88vh;overflow-y:auto;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <div style="font-size:16px;font-weight:700;"><span style="color:${dirC};">${(t.direction||'').toUpperCase()}</span> ${t.coin} ${t.leverage>1?`<span style="font-size:11px;color:var(--text3);">${t.leverage}x</span>`:''}</div>
      <div id="tp-close-x" style="cursor:pointer;color:var(--text3);font-size:20px;">×</div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:16px;">
      <div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center;"><div style="font-size:8px;color:var(--text3);">ENTRY</div><div style="font-family:monospace;font-size:13px;">${t.entry??'mkt'}</div></div>
      <div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center;"><div style="font-size:8px;color:var(--text3);">NOW</div><div style="font-family:monospace;font-size:13px;color:var(--accent);">${t.currentPrice??'—'}</div></div>
      <div style="flex:1;background:var(--bg3);border-radius:8px;padding:8px;text-align:center;"><div style="font-size:8px;color:var(--text3);">P&L</div><div style="font-family:monospace;font-size:13px;color:${(t.pnlUsd||0)>=0?'var(--green)':'var(--red)'};">${(t.pnlUsd||0)>=0?'+':''}$${Math.abs(t.pnlUsd||0).toFixed(2)}</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <button class="tp-act" data-act="sl" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">✏️ Move Stop (${t.stopLoss??'—'})</button>
      <button class="tp-act" data-act="tp" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">✏️ Move Target (${t.target??'—'})</button>
      <button class="tp-act" data-act="breakeven" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--gold);background:rgba(251,191,36,.12);color:var(--gold);">🛡️ Breakeven</button>
      <button class="tp-act" data-act="trail" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">📉 Trail SL</button>
      <button class="tp-act" data-act="partial" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">✂️ Partial Close</button>
      <button class="tp-act" data-act="add" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">➕ Add to Position</button>
      <button class="tp-act" data-act="note" style="padding:11px;border-radius:9px;font-size:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--text);">📝 Note</button>
    </div>
    ${t.userNote?`<div style="font-size:11px;color:var(--text2);margin-top:10px;background:var(--bg3);border-radius:8px;padding:8px;">📝 ${t.userNote}</div>`:''}
    <button class="tp-act" data-act="close" style="width:100%;margin-top:14px;padding:12px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--red);background:rgba(255,90,95,.14);color:var(--red);">🔴 Close Trade</button>
  </div>`
  const closeModal = () => modal.remove()
  modal.onclick = (e) => { if (e.target === modal) closeModal() }
  modal.querySelector('#tp-close-x').onclick = closeModal
  modal.querySelectorAll('.tp-act').forEach(b => b.onclick = async () => {
    const act = b.dataset.act
    let value = null
    if (act === 'close') { if (!confirm('Close the whole trade?')) return }
    else if (act === 'breakeven') { /* no input */ }
    else if (act === 'sl') { value = prompt('New stop-loss price:', t.stopLoss??''); if (value==null||value==='') return }
    else if (act === 'tp') { value = prompt('New target price:', t.target??''); if (value==null||value==='') return }
    else if (act === 'partial') { value = prompt('Close what % of the position? (e.g. 50)', '50'); if (value==null||value==='') return }
    else if (act === 'add') { value = prompt('Add how much $ to the position?', '50'); if (value==null||value==='') return }
    else if (act === 'note') { value = prompt('Your note on this trade:', t.userNote||''); if (value==null) return }
    else if (act === 'trail') { value = prompt('Trail the stop by what % below the peak? (e.g. 10)', t.trailingPct||'10'); if (value==null||value==='') return }
    const res = await ipcRenderer.invoke('user-edit-trade', { tradeId, action:act, value }).catch(()=>({success:false}))
    if (act === 'partial' && res?.realized!=null) alert(`Closed ${value}% — locked $${res.realized}. Rest stays open.`)
    closeModal()
    renderAdvisorTrades(advisorId, false)
  })
}

ipcRenderer.on('advisor-call', () => { if (document.getElementById('page-7')?.style.display !== 'none') renderCalls() })

// ── Study Timer ──────────────────────────────────────────────────────────
let timerInterval = null
let timerSeconds = 25 * 60
let timerRunning = false

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
}

function updateTimerDisplay() {
  const el = document.getElementById('timer-display')
  if(!el) return
  if (el) el.textContent = formatTime(timerSeconds)
}

document.querySelectorAll('.timer-preset-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.timer-preset-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    timerSeconds = parseInt(this.dataset.min) * 60
    timerRunning = false
    clearInterval(timerInterval)
    updateTimerDisplay()
    const startBtn = document.getElementById('timer-start-btn')
    if(!startBtn) return
    if (startBtn) startBtn.textContent = '▶ Start'
  })
})

document.getElementById('timer-start-btn')?.addEventListener('click', function() {
  if (timerRunning) {
    timerRunning = false
    clearInterval(timerInterval)
    this.textContent = '▶ Start'
  } else {
    timerRunning = true
    this.textContent = '⏸ Pause'
    timerInterval = setInterval(() => {
      if (timerSeconds <= 0) {
        clearInterval(timerInterval)
        timerRunning = false
        setEl('timer-start-btn','textContent','▶ Start')
        // Notify
        ipcRenderer.invoke('get-voice', 'Time is up! Great work! Take a break.').then(audio => {
          if (audio) playAudio(audio)
        }).catch(() => {})
        return
      }
      timerSeconds--
      updateTimerDisplay()
    }, 1000)
  }
})

document.getElementById('timer-reset-btn')?.addEventListener('click', () => {
  clearInterval(timerInterval)
  timerRunning = false
  const activeBtn = document.querySelector('.timer-preset-btn.active')
  timerSeconds = parseInt(activeBtn?.dataset.min || 25) * 60
  updateTimerDisplay()
  const startBtn = document.getElementById('timer-start-btn')
  if(!startBtn) return
  if (startBtn) startBtn.textContent = '▶ Start'
})

// ── Calculator ────────────────────────────────────────────────────────────
document.getElementById('calc-btn')?.addEventListener('click', async () => {
  const q = document.getElementById('calc-input')?.value
  if (!q) return
  const result = document.getElementById('calc-result')
  if(!result) return
  if (result) result.textContent = 'Calculating...'
  try {
    // Simple eval for basic math
    const cleanQ = q.trim()
    let answer = ''
    if (/^[\d\s+\-*/.()%]+$/.test(cleanQ)) {
      answer = eval(cleanQ.replace('%', '/100'))
    } else {
      // Ask Claude
      const res = await ipcRenderer.invoke('process-voice-input-text', `Calculate: ${q}`, null)
      answer = res?.reply || 'Could not calculate'
    }
    if (result) result.textContent = `= ${answer}`
  } catch(e) {
    if (result) result.textContent = 'Could not calculate'
  }
})

document.getElementById('calc-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('calc-btn')?.click()
})

// ── Currency Converter ────────────────────────────────────────────────────
document.getElementById('conv-btn')?.addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('conv-amount')?.value)
  const from = document.getElementById('conv-from')?.value
  const to = document.getElementById('conv-to')?.value
  const result = document.getElementById('conv-result')
  if(!result) return
  if (!amount || !from || !to) return
  if (result) result.textContent = 'Converting...'
  try {
    const res = await fetch(`https://api.exchangerate.host/convert?from=${from}&to=${to}&amount=${amount}`)
    const data = await res.json()
    if (data.result) {
      if (result) result.textContent = `${amount} ${from} = ${data.result.toFixed(2)} ${to}`
    } else {
      // Ask Claude as fallback
      const reply = await ipcRenderer.invoke('process-voice-input-text', `Convert ${amount} ${from} to ${to}`, null)
      if (result) result.textContent = reply?.reply || 'Could not convert'
    }
  } catch(e) {
    if (result) result.textContent = 'Could not connect to exchange rate API'
  }
})

// ── Speed buttons ─────────────────────────────────────────────────────────
async function restoreVoiceSettings() {
  try {
    const s = await ipcRenderer.invoke('get-settings').catch(() => ({})) || {}
    window._autoSpeak = s.autoSpeak !== false
    const ast = document.getElementById('auto-speak-toggle')
    if (ast) ast.classList.toggle('on', window._autoSpeak)
    if (s.voiceSpeed) {
      document.querySelectorAll('.speed-btn').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === s.voiceSpeed)
      )
    }
  } catch (e) {}
}
document.getElementById('auto-speak-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  window._autoSpeak = this.classList.contains('on')
  ipcRenderer.send('set-setting', 'autoSpeak', window._autoSpeak)
})
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    const speed = parseFloat(this.dataset.speed)
    ipcRenderer.send('set-setting', 'voiceSpeed', speed)
    if (memory) memory.voiceSpeed = speed
    ipcRenderer.invoke('patch-character-profile', { voiceSpeed: speed }).catch(() => {})
  })
})

// ── Notes ─────────────────────────────────────────────────────────────────
document.getElementById('save-note-btn')?.addEventListener('click', async () => {
  const note = document.getElementById('quick-note')?.value?.trim()
  if (!note) return
  await ipcRenderer.invoke('save-memory', note).catch(() => {})
  setEl('quick-note','value','')
  loadMemories()
})

// Page 5 data loads via loadPageData when tab opens — no extra tab listener

// ── Books & Study System ──────────────────────────────────────────────────

let _activeBookId = null

async function loadBooks() {
  const data = await ipcRenderer.invoke('get-books').catch(() => ({ books: [] }))
  const list = document.getElementById('books-list')
  if (!list) return

  if (!data.books?.length) {
    list.innerHTML = '<div class="empty-state">No textbooks yet</div>'
    return
  }

  list.innerHTML = data.books.map(b => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:var(--bg3);border-radius:8px;margin-bottom:4px;">
      <div style="cursor:pointer;flex:1;" data-book-id="${b.id}" data-book-name="${b.name}" class="book-select-btn">
        <div style="font-size:12px;font-weight:600;">${b.name}</div>
        <div style="font-size:10px;color:var(--text2);">${b.pageCount} pages • ${b.subject}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        ${_activeBookId === b.id ? '<span style="font-size:10px;color:var(--accent);">Active</span>' : ''}
        <button data-delete-book="${b.id}" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:4px;">✕</button>
      </div>
    </div>`).join('')

  // Wire up book buttons after rendering
  list.querySelectorAll('.book-select-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveBook(btn.dataset.bookId, btn.dataset.bookName))
  })
  list.querySelectorAll('[data-delete-book]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); deleteBook(btn.dataset.deleteBook) })
  })
}

function setActiveBook(id, name) {
  _activeBookId = id
  loadBooks()
  showStatus(`📚 Active book: ${name}`)
}

async function deleteBook(id) {
  await ipcRenderer.invoke('delete-book', id)
  if (_activeBookId === id) _activeBookId = null
  loadBooks()
}

async function handleBookFile(input) {
  const file = input.files[0]
  if (!file) return
  await processBookUploadFile(file)
}

async function handleBookDrop(event) {
  event.preventDefault()
  const zone = document.getElementById('book-drop-zone')
  if(!zone) return
  if (zone) zone.style.borderColor = 'var(--border)'
  const file = event.dataTransfer.files[0]
  if (!file) { showStatus('No file detected'); return }
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showStatus('Please drop a PDF file')
    return
  }
  await processBookUploadFile(file)
}

async function processBookUploadFile(file) {
  const status = document.getElementById('book-index-status')
  const nameInput = document.getElementById('book-name-input')
  const subject = document.getElementById('book-subject')?.value || 'general'
  const bookName = nameInput?.value.trim() || file.name.replace(/\.pdf$/i, '')
  const sizeMB = file.size / (1024 * 1024)

  if (status) {
    status.style.display = 'block'
    status.style.color = 'var(--accent)'
    status.textContent = `⏳ Reading "${bookName}" (${sizeMB.toFixed(1)}MB)...`
  }

  try {
    let result

    if (sizeMB > 8) {
      // Large PDF — use native file dialog (bypasses IPC size limit)
      if (status) status.textContent = `⏳ Large PDF detected — opening file browser...`
      result = await ipcRenderer.invoke('open-book-dialog', { name: bookName, subject })
    } else {
      // Small PDF — send bytes through IPC
      const arrayBuffer = await file.arrayBuffer()
      const uint8Array = new Uint8Array(arrayBuffer)
      const fileData = Array.from(uint8Array)

      if (status) status.textContent = `⏳ Indexing "${bookName}"...`

      result = await ipcRenderer.invoke('index-book-data', { fileData, name: bookName, subject })

      // If too large, fall back to dialog
      if (result?.error === 'FILE_TOO_LARGE') {
        if (status) status.textContent = `⏳ File too large — opening file browser...`
        result = await ipcRenderer.invoke('open-book-dialog', { name: bookName, subject })
      }
    }

    if (result?.success) {
      if (status) {
        status.style.color = 'var(--green)'
        status.textContent = `✅ "${bookName}" indexed — ${result.pageCount} pages ready! Say "Page 1" to start.`
      }
      _activeBookId = result.bookId
      if (nameInput) nameInput.value = ''
      await loadBooks()
      document.getElementById('books-list')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else {
      if (status) {
        status.style.color = 'var(--red)'
        status.textContent = `❌ Error: ${result?.error || 'Could not parse PDF'}`
      }
    }
  } catch(e) {
    if (status) {
      status.style.color = 'var(--red)'
      status.textContent = `❌ Failed: ${e.message}`
    }
    console.error('Book upload error:', e)
  }
}

// Page jump
document.getElementById('page-jump-btn')?.addEventListener('click', async () => {
  const pageNum = parseInt(document.getElementById('page-jump-input')?.value)
  if (!pageNum || !_activeBookId) {
    if (!_activeBookId) showStatus('Select a book first')
    return
  }
  const page = await ipcRenderer.invoke('get-book-page', _activeBookId, pageNum)
  const display = document.getElementById('page-content-display')
  if (!display) return
  if (page) {
    display.style.display = 'block'
    display.innerHTML = `<div style="font-size:10px;color:var(--accent);margin-bottom:6px;">Page ${pageNum}</div><div style="white-space:pre-wrap;">${page.text.slice(0, 2000)}</div>`
  } else {
    display.style.display = 'block'
    display.textContent = `Page ${pageNum} not found`
  }
})

// Listen for book indexed event from main
ipcRenderer.on('book-indexed', (e, result) => {
  if (result.success) {
    _activeBookId = result.bookId
    loadBooks()
  }
})

// Load books on startup
setTimeout(() => { if(typeof loadBooks === "function") loadBooks(); }, 1000)

// Wire up book drop zone properly (no inline handlers)
function initBookDropZone() {
  const zone = document.getElementById('book-drop-zone')
  const fileInput = document.getElementById('book-file-input')
  if (!zone || !fileInput) return

  // Click to browse — use native dialog directly (no size limits)
  zone.addEventListener('click', () => {
    const nameInput = document.getElementById('book-name-input')
    const subject = document.getElementById('book-subject')?.value || 'general'
    const bookName = nameInput?.value.trim() || ''
    const status = document.getElementById('book-index-status')
    if(!status) return
    if (status) { status.style.display = 'block'; status.style.color = 'var(--accent)'; status.textContent = '⏳ Opening file browser...' }
    ipcRenderer.invoke('open-book-dialog', { name: bookName, subject }).then(async result => {
      if (result?.success) {
        if (status) { status.style.color = 'var(--green)'; status.textContent = `✅ "${result.name}" indexed — ${result.pageCount} pages ready!` }
        _activeBookId = result.bookId
        if (nameInput) nameInput.value = ''
        await loadBooks()
      } else if (result?.error && result.error !== 'No file selected') {
        if (status) { status.style.color = 'var(--red)'; status.textContent = `❌ ${result.error}` }
      } else {
        if (status) { status.style.display = 'none' }
      }
    }).catch(e => { if (status) { status.style.color = 'var(--red)'; status.textContent = `❌ ${e.message}` } })
  })

  // Drag over
  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
    zone.style.borderColor = 'var(--accent)'
    zone.style.background = 'rgba(0,212,255,0.05)'
  })

  // Drag leave
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault()
    zone.style.borderColor = 'var(--border)'
    zone.style.background = ''
  })

  // Drop
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    zone.style.borderColor = 'var(--border)'
    zone.style.background = ''
    const file = e.dataTransfer.files[0]
    if (!file) { showStatus('No file detected'); return }
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      showStatus('⚠️ Please drop a PDF file')
      return
    }
    processBookUploadFile(file)
  })

  // File input change
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]
    if (file) processBookUploadFile(file)
    // Reset so same file can be selected again
    fileInput.value = ''
  })
}

// Init after DOM ready
setTimeout(initBookDropZone, 800)

// ── Auto-Launch Desk ──────────────────────────────────────────────────────
function aldForm() {
  return {
    ca: document.getElementById('ls-ca')?.value.trim() || '',
    name: document.getElementById('ls-name')?.value.trim() || '',
    symbol: document.getElementById('ls-symbol')?.value.trim() || '',
    tagline: document.getElementById('ls-tagline')?.value.trim() || '',
    twitter: document.getElementById('ls-twitter')?.value.trim() || '',
    telegram: document.getElementById('ls-telegram')?.value.trim() || '',
    chain: 'solana'
  }
}
function aldSay(msg) { const s = document.getElementById('ald-status'); s.style.display = 'block'; s.textContent = msg }

document.getElementById('ald-mode-adv')?.addEventListener('click', () => {
  const a = document.getElementById('ald-advanced'); a.style.display = a.style.display === 'none' ? 'block' : 'none'
})
document.getElementById('ald-mode-manual')?.addEventListener('click', () => {
  aldSay('Manual mode: use the buttons above (Build Site, Marketing Pack, Caller Guide) one at a time. You stay in full control.')
})
document.getElementById('ald-mode-auto')?.addEventListener('click', async () => {
  const form = aldForm()
  if (!form.name && !form.ca) { aldSay('Enter at least a token name or contract address up top first!') ; return }
  aldSay('⚡ Asuka is launching everything... this takes ~30-40s\n(site + logo + marketing + buyback + growth)')
  const r = await ipcRenderer.invoke('launch-full-auto', form).catch(() => null)
  if (!r?.success) { aldSay('❌ ' + (r?.error || 'Launch failed')) ; return }
  aldSay('🚀 LAUNCH COMPLETE\n\n' + r.steps.join('\n') + '\n\nEverything is now running — scroll down to the live console to edit anything.')
  await aldLoadProjects(r.project.id)
})
document.querySelectorAll('.ald-step').forEach(btn => btn.addEventListener('click', async function() {
  const step = this.dataset.step, form = aldForm()
  if (!form.name && !form.ca) { aldSay('Enter token name or CA first!'); return }
  const orig = this.textContent; this.textContent = '⏳'
  try {
    if (step === 'site') { const r = await ipcRenderer.invoke('launch-generate-site', form); aldSay(r?.success ? '✅ Site built: ' + r.path : '❌ ' + (r?.error||'failed')) }
    else if (step === 'art') { const r = await ipcRenderer.invoke('launch-generate-art', form); aldSay(r?.success ? '✅ Logo saved: ' + r.path : '⚠️ ' + (r?.error||'failed')) }
    else if (step === 'marketing') { document.getElementById('ls-marketing-btn')?.click(); aldSay('📣 Generating marketing pack above ↑') }
    else { // buyback / growth / health → create project then toggle
      const cr = await ipcRenderer.invoke('launch-create-project', form)
      if (cr?.success) {
        const patch = step === 'buyback' ? { buyback: { enabled: true } } : step === 'growth' ? { growth: { enabled: true } } : {}
        if (Object.keys(patch).length) await ipcRenderer.invoke('launch-update-project', { id: cr.project.id, patch: { ...patch, status: 'live' } })
        aldSay('✅ ' + step + ' configured — see live console below')
        await aldLoadProjects(cr.project.id)
      }
    }
  } catch(e) { aldSay('❌ ' + e.message) }
  this.textContent = orig
}))

let _aldProject = null
let _aldList = []
async function aldLoadProjects(selectId) {
  const list = await ipcRenderer.invoke('launch-list-projects').catch(() => [])
  _aldList = list
  const picker = document.getElementById('ald-proj-picker')
  const overview = document.getElementById('ald-overview')
  if(!overview) return
  const console_ = document.getElementById('ald-console')
  if(!console_) return
  if (!list.length) {
    if (overview) overview.style.display = 'none'
    if (console_) console_.style.display = 'none'
    return
  }
  if (picker) picker.innerHTML = list.map(p => `<option value="${p.id}">${p.name||p.symbol} (${p.status})</option>`).join('')
  if (selectId) { showConsole(selectId) }
  else { showOverview() }
}
function statusColor(s) { return s==='live'?'var(--green)':s==='paused'?'var(--gold)':'var(--text3)' }
function showOverview() {
  document.getElementById('ald-console').style.display = 'none'
  const ov = document.getElementById('ald-overview')
  if(!ov) return
  ov.style.display = 'block'
  setEl('ald-count','textContent',`${_aldList.length} coin${_aldList.length!==1?'s':''}`)
  setEl('ald-grid','innerHTML',_aldList.map(p => {
    const h = p.health || {}
    const price = h.price ? '$' + h.price : '—'
    const liq = h.liq ? '$' + (h.liq/1000).toFixed(0) + 'K' : '—'
    return `<div class="ald-card" data-id="${p.id}" style="background:linear-gradient(180deg,var(--bg2),var(--bg1));border:1px solid var(--border);border-radius:12px;padding:11px;cursor:pointer;position:relative;transition:.15s;">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:6px;">
        <div>
          <div style="font-weight:700;font-size:13px;">$${(p.symbol||'?').toUpperCase()}</div>
          <div style="font-size:10px;color:var(--text2);">${p.name||''} · ${p.chain||'—'}</div>
        </div>
        <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,0.06);color:${statusColor(p.status)};">${(p.status||'').toUpperCase()}</span>
      </div>
      <div style="display:flex;gap:10px;font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--text2);margin-bottom:8px;">
        <span>${price}</span><span>Liq ${liq}</span>
      </div>
      <div style="display:flex;gap:4px;font-size:9px;">
        ${p.buybackEnabled?'<span style="color:var(--green);">● buyback</span>':''}
        ${p.growthEnabled?'<span style="color:var(--violet);">● growth</span>':''}
      </div>
      <button class="ald-del" data-id="${p.id}" data-sym="${p.symbol}" style="position:absolute;top:8px;right:8px;display:none;background:rgba(251,113,133,0.15);border:none;border-radius:6px;color:var(--red);cursor:pointer;font-size:11px;padding:2px 6px;">🗑</button>
    </div>`
  }).join(''))
  // wire cards
  document.querySelectorAll('.ald-card').forEach(c => {
    c.addEventListener('mouseenter', () => { c.style.borderColor = 'var(--violet)'; c.querySelector('.ald-del').style.display='block' })
    c.addEventListener('mouseleave', () => { c.style.borderColor = 'var(--border)'; c.querySelector('.ald-del').style.display='none' })
    c.addEventListener('click', e => { if (!e.target.classList.contains('ald-del')) showConsole(c.dataset.id) })
  })
  document.querySelectorAll('.ald-del').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation()
    if (!confirm(`Delete $${b.dataset.sym}? This removes the project permanently.`)) return
    await ipcRenderer.invoke('launch-delete-project', b.dataset.id).catch(()=>{})
    await aldLoadProjects()
  }))
}
async function showConsole(id) {
  document.getElementById('ald-overview').style.display = 'none'
  document.getElementById('ald-console').style.display = 'block'
  const picker = document.getElementById('ald-proj-picker')
  if(!picker) return
  if (picker) picker.value = id
  await aldRenderProject(id)
}
async function aldRenderProject(id) {
  const p = await ipcRenderer.invoke('launch-get-project', id).catch(() => null)
  if (!p) return
  _aldProject = p
  setEl('ald-proj-name','textContent',`${p.name || p.symbol} — ${p.status}`)
  const h = p.health || {}
  setEl('ald-health','textContent',h.price ? `Price $${h.price} | Liq $${((h.liq||0)/1000).toFixed(0)}K | Vol $${((h.vol||0)/1000).toFixed(0)}K` : 'No live data yet (add CA for health tracking)')
  document.getElementById('ald-bb-enabled').checked = !!p.buyback.enabled
  const _mode = p.buyback.executionMode || 'approve'
  document.getElementById('ald-bb-mode-approve').checked = _mode === 'approve'
  document.getElementById('ald-bb-mode-auto').checked = _mode === 'auto'
  document.getElementById('ald-bb-auto-note').style.display = _mode === 'auto' ? 'block' : 'none'
  setEl('ald-bb-trigger','value',p.buyback.triggerType)
  setEl('ald-bb-amount','value',p.buyback.buyAmountUsd)
  setEl('ald-bb-max','value',p.buyback.maxPerDay)
  setEl('ald-bb-cooldown','value',p.buyback.cooldownMin || 30)
  setEl('ald-bb-volthresh','value',p.buyback.volumeThreshold)
  setEl('ald-bb-drop','value',p.buyback.priceDropPct)
  setEl('ald-bb-schedhrs','value',p.buyback.scheduleHours || 24)
  document.getElementById('ald-g-enabled').checked = !!p.growth.enabled
  setEl('ald-g-cadence','value',p.growth.raidCadenceHours)
  document.getElementById('ald-g-callers').checked = !!p.growth.callerOutreach
  document.getElementById('ald-g-rewards').checked = !!p.growth.holderRewards
  setEl('ald-status-set','value',p.status === 'paused' ? 'paused' : p.status === 'ended' ? 'ended' : 'live')
  setEl('ald-log','innerHTML',(p.log||[]).slice(0,20).map(l => `• ${l.msg}`).join('<br>') || 'No activity yet')
  // populate editable identity
  const setv=(id,v)=>{const el=document.getElementById(id); if(el) el.value=v||''}
  setv('aed-name',p.name); setv('aed-symbol',p.symbol); setv('aed-ca',p.ca); setv('aed-tagline',p.tagline)
  setv('aed-description',p.description); setv('aed-twitter',p.twitter); setv('aed-telegram',p.telegram)
  setv('aed-tgchat',p.telegramChatId); setv('aed-siteurl',p.siteUrl)
}
document.getElementById('ald-proj-picker')?.addEventListener('change', function() { aldRenderProject(this.value) })
document.getElementById('ald-back')?.addEventListener('click', () => showOverview())
document.getElementById('ald-bb-mode-auto')?.addEventListener('change', () => { document.getElementById('ald-bb-auto-note').style.display='block' })
document.getElementById('ald-bb-mode-approve')?.addEventListener('change', () => { document.getElementById('ald-bb-auto-note').style.display='none' })

document.getElementById('aed-save')?.addEventListener('click', async function() {
  if (!_aldProject) return
  const g=(id)=>document.getElementById(id).value.trim()
  const patch = { name:g('aed-name'), symbol:g('aed-symbol'), ca:g('aed-ca'), tagline:g('aed-tagline'), description:g('aed-description'), twitter:g('aed-twitter'), telegram:g('aed-telegram'), telegramChatId:g('aed-tgchat'), siteUrl:g('aed-siteurl') }
  this.textContent = '💾 Saving...'
  const r = await ipcRenderer.invoke('launch-update-project', { id:_aldProject.id, patch }).catch(()=>null)
  this.textContent = '💾 Save details'
  const st=document.getElementById('aed-status'); st.style.display='block'
  if (r?.success) {
    st.textContent = '✅ Saved'
    _aldProject = r.project || _aldProject
    await aldRenderProject(_aldProject.id)   // refresh console
    const list = await ipcRenderer.invoke('launch-list-projects').catch(()=>[]); _aldList = list  // refresh overview data
  } else {
    st.textContent = '❌ ' + (r?.error||'failed — check the fields')
  }
})
document.getElementById('aed-deploy-site')?.addEventListener('click', async function() {
  if (!_aldProject) return
  const st=document.getElementById('aed-status'); st.style.display='block'; st.textContent='Deploying...'
  const r = await ipcRenderer.invoke('deploy-site', { projectId:_aldProject.id }).catch(()=>null)
  if (r?.success) st.textContent = '🌐 LIVE: ' + r.url
  else if (r?.error==='no_token') st.textContent = '📋 ' + r.guide
  else st.textContent = '❌ ' + (r?.error||'failed')
})

document.getElementById('ald-save')?.addEventListener('click', async function() {
  if (!_aldProject) return
  this.textContent = '💾...'
  const patch = {
    buyback: {
      enabled: document.getElementById('ald-bb-enabled').checked,
      executionMode: document.getElementById('ald-bb-mode-auto').checked ? 'auto' : 'approve',
      triggerType: document.getElementById('ald-bb-trigger').value,
      buyAmountUsd: parseFloat(document.getElementById('ald-bb-amount').value) || 200,
      maxPerDay: parseFloat(document.getElementById('ald-bb-max').value) || 1000,
      cooldownMin: parseFloat(document.getElementById('ald-bb-cooldown').value) || 30,
      volumeThreshold: parseFloat(document.getElementById('ald-bb-volthresh').value) || 50000,
      priceDropPct: parseFloat(document.getElementById('ald-bb-drop').value) || 8,
      scheduleHours: parseFloat(document.getElementById('ald-bb-schedhrs').value) || 24
    },
    growth: {
      enabled: document.getElementById('ald-g-enabled').checked,
      raidCadenceHours: parseFloat(document.getElementById('ald-g-cadence').value) || 4,
      callerOutreach: document.getElementById('ald-g-callers').checked,
      holderRewards: document.getElementById('ald-g-rewards').checked
    },
    status: document.getElementById('ald-status-set').value
  }
  await ipcRenderer.invoke('buyback-set-rules', { projectId: _aldProject.id, rules: { ...patch.buyback, autoApprove: document.getElementById('ald-bb-autoapprove').checked } }).catch(()=>{})
  const r = await ipcRenderer.invoke('launch-update-project', { id: _aldProject.id, patch }).catch(() => null)
  this.textContent = '💾 Save Changes'
  if (r?.success) { aldRenderProject(_aldProject.id); aldSay('✅ Saved — changes are live') }
})
setTimeout(() => aldLoadProjects().catch(() => {}), 2500)

// ── Website type selector ─────────────────────────────────────────────────
let _wzType = 'crypto'
let _wzVibe = 'animated'
document.querySelectorAll('.wz-vibe').forEach(b => b.addEventListener('click', () => {
  _wzVibe = b.dataset.vibe
  document.querySelectorAll('.wz-vibe').forEach(x => { const on = x.dataset.vibe === _wzVibe; x.style.border = on ? '2px solid #7c3aed' : '1px solid #334155'; x.style.background = on ? 'rgba(124,58,237,0.15)' : 'rgba(30,41,59,0.5)' })
}))
const _typeLabels = {
  crypto: { name:'Token name', tagline:'Vibe / tagline', desc:'What is this coin about?' },
  business: { name:'Business name', tagline:'Slogan / what you do', desc:'Describe your business, services, who you serve' },
  portfolio: { name:'Your name', tagline:'What you do (e.g. Designer)', desc:'About you, your work, your style' },
  event: { name:'Event name', tagline:'Date + location', desc:'What is the event, who is it for, what happens' },
  personal: { name:'Your name', tagline:'A line about you', desc:'About you, interests, what this page is for' },
  resume: { name:'Your name', tagline:'Your title (e.g. Software Engineer)', desc:'Your background, experience, skills' }
}
function applyWzType(type) {
  _wzType = type
  document.querySelectorAll('.wz-type').forEach(b => {
    const on = b.dataset.type === type
    b.style.border = on ? '2px solid #7c3aed' : '1px solid #334155'
    b.style.background = on ? 'rgba(124,58,237,0.15)' : 'rgba(30,41,59,0.5)'
  })
  // Show/hide crypto-only fields
  document.querySelectorAll('.crypto-only').forEach(el => el.style.display = (type === 'crypto') ? '' : 'none')
  // Update placeholders
  const L = _typeLabels[type]
  const setPh = (id,ph)=>{ const el=document.getElementById(id); if(el) el.placeholder=ph }
  setPh('wz-name', L.name); setPh('wz-tagline', L.tagline); setPh('wz-description', L.desc)
}
document.querySelectorAll('.wz-type').forEach(b => b.addEventListener('click', () => applyWzType(b.dataset.type)))
applyWzType('crypto')


// Domain handling in wizard — simple yes/no
document.querySelectorAll('.wz-dom-choice').forEach(b => b.addEventListener('click', async function() {
  const out = document.getElementById('wz-domain-out')
  if(!out) return
  const ownBox = document.getElementById('wz-domain-own')
  if(!ownBox) return
  if (this.dataset.c === 'yes') {
    ownBox.style.display = 'block'; ownBox.focus()
    out.style.display = 'none'
  } else {
    ownBox.style.display = 'none'
    out.style.display = 'block'; out.textContent = '🌐 Creating your domain...'
    const name = (document.getElementById('wz-name').value || document.getElementById('wz-symbol').value || '').trim()
    if (!name) { out.textContent = 'Enter a name first'; return }
    const list = await ipcRenderer.invoke('launch-list-projects').catch(()=>[])
    const proj = list[list.length-1]
    const r = await ipcRenderer.invoke('domain-auto-create', { projectId: proj?.id, name }).catch(()=>null)
    out.textContent = r?.success ? (r.testMode ? '🧪 ' + r.note : '✅ Your domain is ready: ' + r.domain) : '❌ ' + (r?.error||'failed')
  }
}))
document.getElementById('wz-domain-own')?.addEventListener('change', async function() {
  const domain = this.value.trim(); if (!domain) return
  const out = document.getElementById('wz-domain-out'); out.style.display='block'; out.textContent='Connecting ' + domain + '...'
  const list = await ipcRenderer.invoke('launch-list-projects').catch(()=>[])
  const proj = list[list.length-1]
  const r = await ipcRenderer.invoke('domain-connect', { projectId: proj?.id, domain }).catch(()=>null)
  out.textContent = r?.instructions || r?.note || (r?.success ? '✅ Domain connected!' : '❌ Failed')
})


// Post marketing to TG (needs a created project with matching symbol)
document.querySelectorAll('.ls-post').forEach(b => b.addEventListener('click', async function() {
  const what = this.dataset.what
  const st = document.getElementById('ls-post-status'); st.style.display = 'block'; st.textContent = 'Posting...'
  const sym = (document.getElementById('ls-symbol')?.value || document.getElementById('wz-symbol')?.value || '').toUpperCase()
  const list = await ipcRenderer.invoke('launch-list-projects').catch(()=>[])
  let proj = list.find(p => (p.symbol||'').toUpperCase() === sym) || list[list.length-1]
  if (!proj) { st.textContent = 'Create the project first (Wizard → Create Project)'; return }
  const r = await ipcRenderer.invoke('post-marketing', { projectId: proj.id, what }).catch(()=>null)
  st.textContent = r?.success ? r.results.join(' · ') : '❌ ' + (r?.error || 'failed')
}))


// ── Project Wizard ────────────────────────────────────────────────────────
let _wzImageData = null
function wzCtx() {
  const v = id => (document.getElementById(id)?.value || '').trim()
  const vr = id => document.getElementById(id)?.value || ''
  return {
    name: v('wz-name'),
    symbol: v('wz-symbol'),
    tagline: v('wz-tagline'),
    description: v('wz-description'),
    chain: vr('wz-chain'),
    supply: v('wz-supply'),
    twitter: v('wz-twitter'),
    telegram: v('wz-telegram'),
    telegramChatId: document.getElementById('wz-tg-chatid')?.value.trim() || '',
    siteUrl: v('wz-site-url'),
    customBrief: document.getElementById('wz-brief')?.value.trim() || ''
  }
}
function wzSay(m) { const s = document.getElementById('wz-status'); s.style.display='block'; s.textContent = m }
document.querySelectorAll('.wz-ai').forEach(b => b.addEventListener('click', async function() {
  const field = this.dataset.f; const orig = this.textContent; this.textContent = '⏳'
  const r = await ipcRenderer.invoke('wizard-assist', { field, ctx: wzCtx() }).catch(()=>null)
  this.textContent = orig
  if (r?.success) { const el = document.getElementById('wz-' + field); if (el) el.value = r.value }
}))
document.getElementById('wz-fill-all')?.addEventListener('click', async function() {
  this.textContent = '✨ Thinking...'
  const r = await ipcRenderer.invoke('wizard-assist-all', wzCtx()).catch(()=>null)
  this.textContent = '✨ AI Fill All'
  if (r?.success) {
    const f = r.fields
    const set = (id,v)=>{ const el=document.getElementById(id); if(el&&v) el.value=v }
    set('wz-name',f.name); set('wz-symbol',f.symbol); set('wz-tagline',f.tagline); set('wz-description',f.description)
    set('wz-supply',f.tokenomics?.supply); set('wz-twitter',f.twitter); set('wz-telegram',f.telegram)
    wzSay('✨ Filled! Edit anything you like, then Create or Deploy.')
  } else wzSay('❌ ' + (r?.error||'failed'))
})
document.getElementById('wz-img-upload')?.addEventListener('click', ()=>document.getElementById('wz-img-file').click())
document.getElementById('wz-img-file')?.addEventListener('change', function() {
  const file = this.files[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = () => { _wzImageData = reader.result; const p = document.getElementById('wz-img-preview'); p.style.display='block'; p.textContent = '✅ Image uploaded: ' + file.name }
  reader.readAsDataURL(file)
})
document.getElementById('wz-img-ai')?.addEventListener('click', async function() {
  this.textContent = '🎨...'
  const r = await ipcRenderer.invoke('launch-generate-art', wzCtx()).catch(()=>null)
  this.textContent = '🎨 AI Generate Logo'
  const p = document.getElementById('wz-img-preview'); p.style.display='block'
  p.textContent = r?.success ? '✅ Logo generated: ' + r.path : '⚠️ ' + (r?.error||'needs GEMINI_API_KEY image access')
})

document.getElementById('wz-create')?.addEventListener('click', async function() {
  const c = wzCtx()
  // GENERAL (non-crypto) site path
  if (_wzType !== 'crypto') {
    if (!c.name) { wzSay('Add a name first!'); return }
    this.textContent = '🌐 building...'; wzSay('Building your ' + _wzType + ' website... (~30s)')
    let logoDataUri = _wzImageData || null
    const r = await ipcRenderer.invoke('build-general-site', {
      siteType: _wzType, vibe: _wzVibe, name: c.name, tagline: c.tagline, description: c.description,
      customBrief: c.customBrief, contact: c.twitter, socials: (c.twitter||'') + ' ' + (c.telegram||''),
      logoDataUri, wantLogo: !logoDataUri
    }).catch(()=>null)
    this.textContent = '🌐 Create Website'
    wzSay(r?.success ? '✅ Your ' + _wzType + ' website is built!\n' + r.path + '\n\nGo to 🤖 Auto-Desk to deploy it live.' : '❌ ' + (r?.error||'failed'))
    return
  }
  // CRYPTO path (original)
  if (!c.name && !c.symbol) { wzSay('Fill in at least a token name or symbol first!'); return }
  this.textContent = '🎨 making logo...'
  wzSay('Building your website... (~30s)')
  // Logo first (uploaded wins, else AI), embed into site
  let logoDataUri = _wzImageData || null
  if (!logoDataUri) { const art = await ipcRenderer.invoke('launch-generate-art', c).catch(()=>null); if (art?.dataUri) logoDataUri = art.dataUri }
  this.textContent = '🌐 building site...'
  const site = await ipcRenderer.invoke('launch-generate-site', { name:c.name, symbol:c.symbol, tagline:c.tagline, chain:c.chain, twitter:c.twitter, telegram:c.telegram, ca:c.ca, customBrief:c.customBrief, vibe:_wzVibe, logoDataUri }).catch(()=>null)
  // Save the project too (so Auto-Desk can manage it)
  const proj = await ipcRenderer.invoke('launch-create-project', { ...c, mode:'manual', sitePath: site?.path }).catch(()=>null)
  this.textContent = '🌐 Create Website'
  if (site?.success) {
    wzSay('✅ Website built' + (logoDataUri ? ' with your logo' : '') + '!\n' + site.path + '\n\nGo to the 🤖 Auto-Desk tab to deploy it live + run buyback/marketing.')
    if (proj?.success) aldLoadProjects(proj.project.id)
  } else wzSay('❌ ' + (site?.error || 'Site build failed — try again'))
})


// Buyback wallet mode UI
document.getElementById('ald-wallet-mode')?.addEventListener('change', function() {
  document.getElementById('ald-wallet-connect').style.display = this.value === 'connect' ? 'block' : 'none'
  document.getElementById('ald-wallet-burner').style.display = this.value === 'burner' ? 'block' : 'none'
})
document.getElementById('ald-connect-btn')?.addEventListener('click', async () => {
  if (!_aldProject) return
  const addr = document.getElementById('ald-connect-addr').value.trim()
  const r = await ipcRenderer.invoke('buyback-set-connect', { projectId: _aldProject.id, address: addr }).catch(()=>null)
  aldSay(r?.success ? '🔗 Connect mode set — she\'ll ask you to approve each buyback' : '❌ ' + (r?.error||'failed'))
})
document.getElementById('ald-burner-btn')?.addEventListener('click', async () => {
  if (!_aldProject) return
  const key = document.getElementById('ald-burner-key').value.trim()
  const pin = document.getElementById('ald-burner-pin').value.trim()
  const r = await ipcRenderer.invoke('buyback-set-burner', { projectId: _aldProject.id, privateKey: key, pin }).catch(()=>null)
  if (r?.success) { setEl('ald-burner-key','value',''); aldSay('🔑 Burner armed + encrypted. Unlock with your PIN to enable auto-execution.') }
  else aldSay('❌ ' + (r?.error||'failed'))
})



// ── Launch suite: ticker check + marketing pack ───────────────────────────
document.getElementById('ls-ticker-btn')?.addEventListener('click', async function() {
  const sym = document.getElementById('ls-ticker-check').value.trim()
  const out = document.getElementById('ls-ticker-out')
  if(!out) return
  if (!sym) return
  this.textContent = '⏳'; out.style.display = 'block'; out.textContent = 'Searching DexScreener...'
  const r = await ipcRenderer.invoke('launch-check-ticker', sym).catch(() => null)
  this.textContent = '🔎 Check Ticker'
  if (!r?.success) { out.textContent = '❌ ' + (r?.error || 'Check failed'); return }
  out.innerHTML = `<b>${r.verdict}</b>` + (r.matches?.length ? '<br>' + r.matches.map(m => `• ${m.name} (${m.chain}) — liq $${(m.liq/1000).toFixed(0)}K, vol $${(m.vol/1000).toFixed(0)}K`).join('<br>') : '')
})
document.getElementById('ls-marketing-btn')?.addEventListener('click', async function() {
  const out = document.getElementById('ls-marketing-out')
  const form = {
    ca: (document.getElementById('wz-name') ? '' : ''),
    name: document.getElementById('wz-name')?.value.trim() || '',
    symbol: document.getElementById('wz-symbol')?.value.trim() || '',
    tagline: document.getElementById('wz-tagline')?.value.trim() || ''
  }
  if (!form.name && !form.symbol) { out.style.display = 'block'; out.textContent = 'Fill in the Wizard above first (name + symbol)!'; return }
  this.textContent = '📣 Asuka is writing the campaign...'
  out.style.display = 'block'; out.textContent = 'Building the full pack (~20s)...'
  const r = await ipcRenderer.invoke('launch-marketing-pack', form).catch(() => null)
  this.textContent = '📣 Generate Marketing Pack (8-tweet thread + TG post + shill kit)'
  if (!r?.success) { out.textContent = '❌ ' + (r?.error || 'Failed'); return }
  const p = r.pack
  document.getElementById('ls-post-row').style.display = 'flex'
  out.textContent = '🧵 LAUNCH THREAD\n\n' + (p.thread || []).map((t, i) => `${i+1}/ ${t}`).join('\n\n') +
    '\n\n━━━━━━━━━━\n📌 TELEGRAM PINNED POST\n\n' + (p.tgAnnouncement || '') +
    '\n\n━━━━━━━━━━\n💬 SHILL REPLIES\n' + (p.shillReplies || []).map(s => '• ' + s).join('\n') +
    '\n\n⚡ ONE-LINERS\n' + (p.oneLiners || []).map(s => '• ' + s).join('\n') +
    '\n\n#️⃣ ' + (p.hashtags || []).join(' ')
})


// ── Whiteboard renderer — animates her draw commands like handwriting ──────
let _wbQueue = [], _wbBusy = false


// ── Voice Routines editor ─────────────────────────────────────────────────
let _routines = []
async function loadRoutinesUI() {
  try {
    const r = await ipcRenderer.invoke('get-routines')
    _routines = r?.routines || []
    const list = document.getElementById('routines-list')
    if (!list) return
    list.innerHTML = _routines.map((rt, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(15,23,42,0.5);border-radius:8px;margin-bottom:4px;border:1px solid var(--border);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;font-weight:700;">"${rt.trigger.split('|')[0]}"</div>
          <div style="font-size:9px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${rt.actions.join(' → ') || 'no actions'}</div>
        </div>
        <button data-rt-del="${i}" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:4px;">✕</button>
      </div>`).join('') || '<div style="font-size:11px;color:var(--text2);text-align:center;padding:8px;">No routines yet</div>'
    list.querySelectorAll('[data-rt-del]').forEach(b => b.addEventListener('click', async function() {
      _routines.splice(parseInt(this.dataset.rtDel), 1)
      await ipcRenderer.invoke('save-routines', _routines)
      loadRoutinesUI()
    }))
  } catch(e) {}
}
document.getElementById('rt-add-btn')?.addEventListener('click', async () => {
  const trigger = document.getElementById('rt-trigger').value.trim()
  const actions = document.getElementById('rt-actions').value.split('\n').map(a => a.trim()).filter(Boolean)
  const reply = document.getElementById('rt-reply').value.trim()
  const st = document.getElementById('rt-status')
  if(!st) return
  if (!trigger) { st.style.display='block'; st.style.color='var(--red)'; st.textContent='Need a trigger phrase'; return }
  _routines.push({ trigger: trigger.toLowerCase(), actions, reply: reply || 'Done! ✨' })
  const r = await ipcRenderer.invoke('save-routines', _routines)
  st.style.display = 'block'
  st.style.color = r?.success ? 'var(--green)' : 'var(--red)'
  st.textContent = r?.success ? `✅ Saved! Say "${trigger.split('|')[0]}" to trigger it` : '❌ Failed'
  setEl('rt-trigger','value','')
  setEl('rt-actions','value','')
  setEl('rt-reply','value','')
  loadRoutinesUI()
})
setTimeout(loadRoutinesUI, 2200)


// ── Position Doctor ───────────────────────────────────────────────────────
document.getElementById('pd-btn')?.addEventListener('click', async function() {
  const coin = document.getElementById('pd-coin').value.trim()
  const entry = document.getElementById('pd-entry').value
  const out = document.getElementById('pd-out')
  if(!out) return
  if (!coin || !entry) { out.style.display='block'; out.textContent='Need coin + entry price'; return }
  this.textContent = '⏳ Examining...'
  out.style.display = 'block'; out.textContent = 'Checking live price, flow, regime...'
  const r = await ipcRenderer.invoke('position-doctor', {
    coin, direction: document.getElementById('pd-dir').value,
    entry, leverage: document.getElementById('pd-lev').value || 1,
    sizeUsd: document.getElementById('pd-size').value
  }).catch(() => null)
  this.textContent = '🩺 Diagnose My Position'
  out.textContent = r?.success ? `Now: $${r.price} | P&L ${r.pnlLev >= 0 ? '+' : ''}${r.pnlLev}% | Liq ${r.liqDist}% away\n\n${r.verdict}` : '❌ ' + (r?.error || 'Failed')
})

// ── Strategy Sandbox ──────────────────────────────────────────────────────
document.getElementById('sb-btn')?.addEventListener('click', async function() {
  const out = document.getElementById('sb-out')
  if(!out) return
  this.disabled = true; this.textContent = '⚔️ Simulating 1000 hours...'
  out.style.display = 'block'; out.style.color = 'var(--accent)'; out.textContent = 'Running both strategies on real history...'
  const r = await ipcRenderer.invoke('backtest-strategy', {
    coin: document.getElementById('sb-coin').value.trim() || 'BTC',
    rsiBuy: document.getElementById('sb-rsi').value || 30,
    tpPct: document.getElementById('sb-tp').value || 2.5,
    slPct: document.getElementById('sb-sl').value || 1.5
  }).catch(() => null)
  this.disabled = false; this.textContent = "⚔️ Battle My Settings vs Asuka's"
  if (r?.success) {
    out.style.color = 'var(--text)'
    out.innerHTML = `<b>${r.coin}</b> — You: <b style="color:${r.yours.wr >= r.hers.wr ? '#34d399' : '#ef4444'};">${r.yours.wr}%</b> (${r.yours.wins}/${r.yours.total}) vs Asuka: <b>${r.hers.wr}%</b> (${r.hers.wins}/${r.hers.total})<br>${r.verdict}`
  } else { out.style.color = 'var(--red)'; out.textContent = '❌ ' + (r?.error || 'Failed') }
})

// ── Tax export ────────────────────────────────────────────────────────────
document.getElementById('tax-btn')?.addEventListener('click', async () => {
  const st = document.getElementById('tax-status')
  if(!st) return
  const r = await ipcRenderer.invoke('export-tax-csv').catch(() => null)
  if (st && r && r.error !== 'canceled') {
    st.style.display = 'block'
    st.style.color = r.success ? 'var(--green)' : 'var(--red)'
    st.textContent = r.success ? `✅ ${r.count} trades exported → ${r.path}` : '❌ ' + r.error
  }
})


// ── Launch Suite ──────────────────────────────────────────────────────────
document.getElementById('ls-ca')?.addEventListener('blur', async function() {
  const ca = this.value.trim()
  if (!ca || ca.length < 20) return
  const r = await ipcRenderer.invoke('snipe-analyze', ca).catch(() => null)
  if (r?.found) {
    const n = document.getElementById('wz-name'), s = document.getElementById('wz-symbol')
    if (n && !n.value) n.value = r.name || ''
    if (s && !s.value) s.value = r.symbol || ''
  }
})
document.getElementById('ls-callers-btn')?.addEventListener('click', async () => {
  const out = document.getElementById('ls-callers-out')
  if(!out) return
  const r = await ipcRenderer.invoke('launch-caller-guide').catch(() => null)
  if (!r?.callers?.length) { out.innerHTML = '<div style="font-size:11px;color:var(--text2);">No caller data yet — track TG signals first, the guide builds itself from real outcomes</div>'; return }
  out.innerHTML = r.callers.map((c, i) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(15,23,42,0.5);border-radius:8px;margin-bottom:4px;border:1px solid var(--border);">
      <div style="font-size:11px;"><b>#${i+1} @${c.name}</b><div style="font-size:9px;color:var(--text2);">${c.total} signals tracked</div></div>
      <div style="text-align:right;"><div style="font-size:12px;font-weight:800;color:${c.winRate >= 60 ? '#34d399' : c.winRate >= 45 ? '#fbbf24' : '#ef4444'};">${c.winRate}%</div><div style="font-size:9px;">${c.verdict}</div></div>
    </div>`).join('')
})
document.getElementById('ls-ask-btn')?.addEventListener('click', async function() {
  const q = document.getElementById('ls-question').value.trim()
  const box = document.getElementById('ls-advice')
  if(!box) return
  if (!q) return
  this.textContent = '⏳'
  box.style.display = 'block'; box.textContent = 'Thinking through the launch...'
  const r = await ipcRenderer.invoke('launch-advisor', { ca: document.getElementById('wz-name')?.value.trim() || '', question: q }).catch(() => null)
  this.textContent = 'Ask'
  box.textContent = r?.success ? r.advice : '❌ ' + (r?.error || 'Failed')
})
document.getElementById('ls-question')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('ls-ask-btn').click() })


// CSV bulk import
document.getElementById('csv-import-btn')?.addEventListener('click', async function() {
  const st = document.getElementById('feed-status')
  this.textContent = '⏳ Importing...'
  const r = await ipcRenderer.invoke('import-trade-csv').catch(() => null)
  this.textContent = '📊 Import Trade History CSV (1000+ trades OK)'
  if (st && r && r.error !== 'canceled') {
    st.style.display = 'block'
    st.style.color = r.success ? 'var(--green)' : 'var(--red)'
    st.textContent = r.success ? `✅ ${r.trades} trades → ${r.lessons} pattern lessons learned` : `❌ ${r.error}`
  }
})
// Study progress display
async function showStudyProgress() {
  try {
    const prog = await ipcRenderer.invoke('get-study-progress')
    const books = await ipcRenderer.invoke('get-books')
    const line = document.getElementById('study-progress-line')
    if (!line || !books?.books?.length) return
    const active = books.books.find(b => b.id === _activeBookId) || books.books[0]
    const p = prog?.[active?.id]
    if (p?.lastPage) {
      line.style.display = 'block'
      line.innerHTML = `📖 <b>${active.name}</b> — last studied page ${p.lastPage}/${active.pageCount} (${p.sessions || 0} sessions). Say <b>"continue studying"</b> to resume!`
    }
  } catch(e) {}
}
setTimeout(showStudyProgress, 2500)


// ── Intelligence Lab ──────────────────────────────────────────────────────
document.getElementById('feed-trade-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('feed-coin')?.value.trim()
  const note = document.getElementById('feed-note')?.value.trim()
  const st = document.getElementById('feed-status')
  if(!st) return
  if (!coin || !note) { if (st) { st.style.display='block'; st.style.color='var(--red)'; st.textContent='Need coin + what happened' } return }
  const r = await ipcRenderer.invoke('feed-trade-lesson', {
    coin, direction: document.getElementById('feed-dir').value,
    won: (document.getElementById('feed-won')||{}).value === '1', note
  }).catch(() => null)
  if (st) {
    st.style.display = 'block'
    st.style.color = r?.success ? 'var(--green)' : 'var(--red)'
    st.textContent = r?.success ? `✅ Asuka learned it (${r.total} lessons total)` : '❌ Failed'
  }
  if (r?.success) { setEl('feed-coin','value',''); const fn=document.getElementById('feed-note'); if(fn) fn.value='' }
})

document.getElementById('backtest-btn')?.addEventListener('click', async function() {
  const st = document.getElementById('backtest-status')
  if(!st) return
  this.disabled = true; this.textContent = '🏋️ Training... (30-60s)'
  if (st) { st.style.display='block'; st.style.color='var(--accent)'; st.textContent='Replaying 1000 hours per coin...' }
  const r = await ipcRenderer.invoke('run-backtest-training').catch(() => null)
  this.disabled = false; this.textContent = '🏋️ Train on Historical Data (free)'
  if (st && r?.success) {
    const total = r.results.reduce((s, x) => s + x.lessonsWritten, 0)
    st.style.color = 'var(--green)'
    st.textContent = `✅ ${total} data-driven lessons written from ${r.results.length} coins — she's smarter now`
  } else if (st) { st.style.color='var(--red)'; st.textContent='❌ Training failed' }
})

document.getElementById('brain-export-btn')?.addEventListener('click', async () => {
  const st = document.getElementById('brain-status')
  if(!st) return
  const r = await ipcRenderer.invoke('export-brain').catch(() => null)
  if (st) { st.style.display='block'; st.style.color = r?.success ? 'var(--green)' : 'var(--red)'
    st.textContent = r?.success ? `✅ Brain exported (${r.lessons} lessons) → ${r.path}` : (r?.error==='canceled'?'':'❌ Export failed') }
})
document.getElementById('brain-import-btn')?.addEventListener('click', async () => {
  const st = document.getElementById('brain-status')
  if(!st) return
  const r = await ipcRenderer.invoke('import-brain').catch(() => null)
  if (st) { st.style.display='block'; st.style.color = r?.success ? 'var(--green)' : 'var(--red)'
    st.textContent = r?.success ? `✅ Brain merged — ${r.lessons} total lessons now` : (r?.error==='canceled'?'':'❌ Import failed') }
})

// ── DEX Sniper ────────────────────────────────────────────────────────────
let _lastSnipeCA = null
document.getElementById('snipe-analyze-btn')?.addEventListener('click', async () => {
  const ca = document.getElementById('snipe-ca')?.value.trim()
  const box = document.getElementById('snipe-result')
  if(!box) return
  if (!ca || !box) return
  box.style.display = 'block'
  box.innerHTML = '<div style="font-size:11px;color:var(--accent);">⏳ Analyzing...</div>'
  const r = await ipcRenderer.invoke('snipe-analyze', ca).catch(() => null)
  if (!r?.found) { box.innerHTML = '<div style="font-size:11px;color:var(--red);">❌ Token not found on any DEX</div>'; return }
  _lastSnipeCA = ca
  const ch = r.change || {}
  const pct = v => v == null ? '—' : `<span style="color:${v >= 0 ? '#34d399' : '#ef4444'};">${v >= 0 ? '+' : ''}${v}%</span>`
  box.innerHTML = `
    <div style="background:rgba(15,23,42,0.6);border:1px solid var(--border);border-radius:10px;padding:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:13px;font-weight:800;">${r.symbol} <span style="font-size:9px;color:var(--text2);font-weight:400;">${r.name} • ${r.chain}</span></div>
        <div style="font-size:13px;font-weight:800;">$${r.priceUsd < 0.01 ? r.priceUsd.toExponential(2) : r.priceUsd.toLocaleString()}</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0;font-size:10px;color:var(--text2);">
        <div>Liq: <b style="color:var(--text);">$${(r.liquidity/1000).toFixed(0)}K</b></div>
        <div>Vol24h: <b style="color:var(--text);">$${(r.volume24h/1000).toFixed(0)}K</b></div>
        <div>Age: <b style="color:var(--text);">${r.ageHours ? r.ageHours < 48 ? r.ageHours.toFixed(0)+'h' : (r.ageHours/24).toFixed(0)+'d' : '—'}</b></div>
        <div>1h: ${pct(ch.h1)}</div><div>6h: ${pct(ch.h6)}</div><div>24h: ${pct(ch.h24)}</div>
      </div>
      ${r.flags?.length ? `<div style="font-size:10px;color:#fbbf24;margin-bottom:8px;">${r.flags.join('<br>')}</div>` : '<div style="font-size:10px;color:var(--green);margin-bottom:8px;">✅ No red flags detected</div>'}
      <div style="display:flex;gap:6px;">
        <button class="tg-add-btn snipe-buy-btn" data-usd="25" style="flex:1;">⚡ Snipe $25</button>
        <button class="tg-add-btn snipe-buy-btn" data-usd="50" style="flex:1;">⚡ Snipe $50</button>
        <button class="tg-add-btn snipe-buy-btn" data-usd="100" style="flex:1;">⚡ Snipe $100</button>
      </div>
    </div>`
  box.querySelectorAll('.snipe-buy-btn').forEach(b => b.addEventListener('click', async function() {
    this.textContent = '⏳'
    const res = await ipcRenderer.invoke('snipe-buy', { ca: _lastSnipeCA, usd: parseInt(this.dataset.usd) }).catch(() => null)
    this.textContent = res?.success ? '✅ Sniped!' : '❌'
    loadSnipePositions()
  }))
})
document.getElementById('snipe-ca')?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('snipe-analyze-btn').click() })

async function loadSnipePositions() {
  const el = document.getElementById('snipe-positions')
  if (!el) return
  const r = await ipcRenderer.invoke('snipe-positions').catch(() => null)
  if (!r?.positions?.length) { el.innerHTML = '<div style="font-size:11px;color:var(--text2);text-align:center;padding:10px;">No snipes yet</div>'; return }
  el.innerHTML = r.positions.map(p => {
    const pnl = p.pnlPct != null ? p.pnlPct : 0
    const color = pnl >= 0 ? '#34d399' : '#ef4444'
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(15,23,42,0.5);border-radius:8px;margin-bottom:4px;border:1px solid var(--border);">
      <div><div style="font-size:11px;font-weight:700;">${p.symbol || '?'} <span style="font-size:9px;color:var(--text2);">${p.chain || ''} • $${p.amountUsd}</span></div>
      <div style="font-size:9px;color:var(--text2);">${p.status === 'open' ? 'entry' : 'closed'} $${p.entryPrice < 0.01 ? p.entryPrice.toExponential(2) : p.entryPrice}</div></div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span style="font-size:12px;font-weight:800;color:${color};">${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%</span>
        ${p.status === 'open' ? `<button data-sell="${p.id}" style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;">Sell</button>` : '<span style="font-size:9px;color:var(--text2);">closed</span>'}
      </div></div>`
  }).join('')
  el.querySelectorAll('[data-sell]').forEach(b => b.addEventListener('click', async function() {
    await ipcRenderer.invoke('snipe-sell', parseInt(this.dataset.sell)).catch(() => null)
    loadSnipePositions()
  }))
}
setInterval(() => { if (document.getElementById('tab-sniper')?.classList.contains('active')) loadSnipePositions() }, 20000)
document.querySelector('[data-tab="sniper"]')?.addEventListener('click', () => setTimeout(loadSnipePositions, 300))

// ── Sponsor banner ────────────────────────────────────────────────────────
ipcRenderer.invoke('get-sponsored').then(c => {
  if (!c || localStorage.getItem('sponsor_dismissed') === String(c.name)) return
  const b = document.getElementById('sponsor-banner')
  if (!b) return
  setEl('sponsor-text','textContent',c.banner || c.name)
  if (c.url) {
    const lb = document.getElementById('sponsor-link-btn')
    if(!lb) return
    lb.style.display = 'block'
    lb.addEventListener('click', () => ipcRenderer.invoke('open-url', c.url).catch(() => {}))
  }
  document.getElementById('sponsor-close')?.addEventListener('click', () => {
    b.style.display = 'none'; localStorage.setItem('sponsor_dismissed', String(c.name))
  })
  b.style.display = 'block'
}).catch(() => {})


// ── Overview Quick-Glance Strip ───────────────────────────────────────────
async function updateOverviewStrip() {
  try {
    // Regime (chip + popover + panel)
    const regime = await ipcRenderer.invoke('get-market-regime').catch(() => null)
    if (regime?.regime) applyRegimeToUi(regime)

    // Trades data
    const trades = await ipcRenderer.invoke('get-paper-trades').catch(() => null)
    if (trades?.trades) {
      const open = trades.trades.filter(t => t.status === 'open')
      const today = new Date().toDateString()
      const todayClosed = trades.trades.filter(t => t.closeTime && new Date(t.closeTime).toDateString() === today)
      const todayPnl = todayClosed.reduce((s, t) => s + (t.pnl || 0), 0)

      const openEl = document.getElementById('ov-open')
      if(!openEl) return
      if (openEl) openEl.textContent = open.length

      const pnlEl = document.getElementById('ov-today-pnl')
      if(!pnlEl) return
      if (pnlEl) {
        pnlEl.textContent = (todayPnl >= 0 ? '+' : '') + '$' + todayPnl.toFixed(2)
        pnlEl.style.color = todayPnl > 0 ? '#34d399' : todayPnl < 0 ? '#ef4444' : 'var(--text)'
        pnlEl.style.textShadow = todayPnl > 0 ? '0 0 12px rgba(52,211,153,0.4)' : todayPnl < 0 ? '0 0 12px rgba(239,68,68,0.4)' : 'none'
      }

      // Glow on hero P&L too
      const heroPnl = document.getElementById('pt-pnl')
      if(!heroPnl) return
      if (heroPnl) {
        const total = trades.trades.filter(t => t.status !== 'open').reduce((s,t) => s + (t.pnl||0), 0)
        heroPnl.classList.remove('profit', 'loss')
        if (total > 0) heroPnl.classList.add('profit')
        else if (total < 0) heroPnl.classList.add('loss')
      }
    }
  } catch(e) {}
}
setInterval(updateOverviewStrip, 15000)
setTimeout(updateOverviewStrip, 1500)

// Regime chip: hover shows details; click pins / unpins; scroll to full panel on second intent
;(function wireRegimeChip() {
  const chip = document.getElementById('ov-regime-chip')
  if (!chip) return
  const setOpen = (on) => {
    chip.classList.toggle('is-open', on)
    chip.setAttribute('aria-expanded', on ? 'true' : 'false')
  }
  chip.addEventListener('click', (e) => {
    e.stopPropagation()
    const pinning = !chip.classList.contains('is-open')
    setOpen(pinning)
    if (pinning) {
      loadMarketRegime()
      const section = document.getElementById('market-regime-section')
      // Soft highlight the full panel so users notice more detail below
      if (section) {
        section.style.outline = '1px solid rgba(59,130,246,0.35)'
        section.style.outlineOffset = '2px'
        setTimeout(() => { section.style.outline = ''; section.style.outlineOffset = '' }, 1600)
      }
    }
  })
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      chip.click()
    }
  })
  document.addEventListener('click', (e) => {
    if (!chip.contains(e.target)) setOpen(false)
  })
})()

// ── What-If Simulator ─────────────────────────────────────────────────────
document.getElementById('wi-calc-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('wi-coin').value.trim()
  const out = document.getElementById('wi-out')
  if(!out) return
  if (!coin) { out.style.display='block'; out.textContent='Enter a coin!'; return }
  out.style.display = 'block'; out.textContent = '🧮 Calculating...'
  const r = await ipcRenderer.invoke('what-if', {
    coin, buyPrice: document.getElementById('wi-buy').value,
    sellPrice: document.getElementById('wi-sell').value,
    amountUsd: document.getElementById('wi-amount').value || 100,
    leverage: document.getElementById('wi-lev').value || 1
  }).catch(() => null)
  if (!r?.success) { out.textContent = '❌ ' + (r?.error || 'Failed'); return }
  const col = parseFloat(r.pnl) >= 0 ? '#34d399' : '#ef4444'
  out.innerHTML = `<b>${r.coin}</b> — buy $${r.buy} → sell $${r.sell} (now: $${r.current})<br>` +
    `You'd get ${r.tokens} ${r.coin}<br>` +
    `<b style="color:${col};font-size:14px;">${parseFloat(r.pnl) >= 0 ? '+' : ''}$${r.pnl} (${r.pnlPct}%)</b>` +
    (r.liqPrice ? `<br>⚠️ Liquidation at $${r.liqPrice}${r.liquidated ? ' — <b style="color:#ef4444;">YOU GOT LIQUIDATED in this scenario!</b>' : ''}` : '')
})
document.getElementById('wi-demo-btn')?.addEventListener('click', async function() {
  const coin = document.getElementById('wi-coin').value.trim()
  const out = document.getElementById('wi-out')
  if(!out) return
  if (!coin) { out.style.display='block'; out.textContent='Enter a coin!'; return }
  this.textContent = '⏳'
  const r = await ipcRenderer.invoke('open-demo-trade', {
    coin, direction: 'long',
    amountUsd: document.getElementById('wi-amount').value || 100,
    leverage: document.getElementById('wi-lev').value || 1
  }).catch(() => null)
  this.textContent = '▶️ Open as Demo Trade'
  out.style.display = 'block'
  out.textContent = r?.success ? `✅ Demo trade opened at $${r.trade.entry} — track it in Positions, she manages TP/SL like a real trade!` : '❌ ' + (r?.error || 'Failed')
})


// ── Asuka Score chip — composite 0-100 for the top coin ───────────────────
async function updateAsukaScore() {
  try {
    const s = await ipcRenderer.invoke('get-settings').catch(() => null)
    const coin = (s?.tradingCoins || ['BTC'])[0]
    const r = await ipcRenderer.invoke('asuka-score', coin).catch(() => null)
    const el = document.getElementById('ov-asuka-score')
    if(!el) return
    if (!el || !r) return
    el.textContent = `${coin} ${r.score}`
    el.style.color = r.score >= 65 ? '#34d399' : r.score <= 35 ? '#ef4444' : '#fbbf24'
    el.style.textShadow = `0 0 12px ${r.score >= 65 ? 'rgba(52,211,153,0.4)' : r.score <= 35 ? 'rgba(239,68,68,0.4)' : 'rgba(251,191,36,0.4)'}`
    { const _e=document.getElementById('ov-score-chip'); if(_e) _e.title = r.summary || 'Asuka Score' }
  } catch(e) {}
}
setTimeout(updateAsukaScore, 3000)
setInterval(updateAsukaScore, 120000)


// ── Daily greeting + streak + market mood ─────────────────────────────────
async function showDailyGreeting() {
  try {
    const s = await ipcRenderer.invoke('check-streak')
    const mood = await ipcRenderer.invoke('market-mood')
    const box = document.getElementById('daily-greeting')
    const h = new Date().getHours()
    const greet = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
    setEl('greeting-text','textContent',`${greet}! 💕`)
    if (s?.streak > 1) setEl('streak-badge','textContent',`🔥 ${s.streak} day streak`)
    if (mood) {
      const fg = mood.fearGreed
      const parts = []
      if (fg) parts.push(`Market: ${fg.value || fg} ${fg.classification ? '(' + fg.classification + ')' : ''}`)
      if (mood.regime) parts.push(`${mood.regime} regime`)
      setEl('mood-text','textContent',parts.join(' • '))
    }
    if (box) box.style.display = 'block'
  } catch(e) {}
}
setTimeout(showDailyGreeting, 1800)


async function updateAsukaLevel() {
  try {
    const l = await ipcRenderer.invoke('get-asuka-level')
    if (!l) return
    setEl('asuka-level','textContent','Lv.' + l.level)
    setEl('asuka-xp','textContent',l.xp.toLocaleString() + ' XP')
    document.getElementById('asuka-xp-bar').style.width = l.progress + '%'
    if (l.breakdown) setEl('asuka-xp-detail','textContent',`${l.breakdown.lessons} lessons • ${l.breakdown.trades} trades • ${l.breakdown.studySessions} study sessions`)
  } catch(e) {}
}
setTimeout(updateAsukaLevel, 2000)
setInterval(updateAsukaLevel, 60000)


// ── Risk Protection toggles ───────────────────────────────────────────────
const RP_KEYS = { 'rp-autopilot':'riskAutoPilot', 'rp-profitlock':'profitLockEnabled', 'rp-antitilt':'antiTiltEnabled', 'rp-volsizing':'volSizingEnabled' }
Object.entries(RP_KEYS).forEach(([elId, key]) => {
  document.getElementById(elId)?.addEventListener('change', function() {
    ipcRenderer.send('set-setting', key, this.checked)
    if (elId === 'rp-autopilot' && this.checked) {
      // Visual: autopilot covers everything
      ;['rp-profitlock','rp-antitilt','rp-volsizing'].forEach(id => {
        const el = document.getElementById(id)
        if (el) el.parentElement.style.opacity = '0.5'
      })
    } else if (elId === 'rp-autopilot') {
      ;['rp-profitlock','rp-antitilt','rp-volsizing'].forEach(id => {
        const el = document.getElementById(id)
        if (el) el.parentElement.style.opacity = '1'
      })
    }
  })
})
// Trade guards — default ON, unchecking disables
const RP_GUARDS = { 'rp-bench':'benchEnabled', 'rp-cooldown':'cooldownEnabled', 'rp-ragelock':'rageLockEnabled', 'rp-maxpos':'maxPositionsEnabled' }
Object.entries(RP_GUARDS).forEach(([elId, key]) => {
  document.getElementById(elId)?.addEventListener('change', function() {
    ipcRenderer.send('set-setting', key, this.checked)
  })
})
// Restore saved states
ipcRenderer.invoke('get-settings').then(s => {
  if (!s) return
  Object.entries(RP_KEYS).forEach(([elId, key]) => {
    const el = document.getElementById(elId)
    if (el && s[key]) el.checked = true
  })
  Object.entries(RP_GUARDS).forEach(([elId, key]) => {
    const el = document.getElementById(elId)
    if (el) el.checked = s[key] !== false
  })
  if (s.riskAutoPilot) ['rp-profitlock','rp-antitilt','rp-volsizing'].forEach(id => {
    const el = document.getElementById(id); if (el) el.parentElement.style.opacity = '0.5'
  })
}).catch(() => {})


// ── Equity Curve Sparkline ────────────────────────────────────────────────
async function drawEquitySpark() {
  try {
    const canvas = document.getElementById('equity-spark')
    if (!canvas) return
    const data = await ipcRenderer.invoke('get-paper-trades').catch(() => null)
    if (!data?.trades) return
    const closed = data.trades.filter(t => t.status !== 'open' && t.closeTime)
      .sort((a,b) => new Date(a.closeTime) - new Date(b.closeTime))
    if (closed.length < 2) { canvas.style.display = 'none'; return }
    canvas.style.display = 'block'

    // Build equity curve from starting balance
    const start = 100000
    let bal = start
    const pts = [bal]
    closed.forEach(t => { bal += (t.pnl || 0); pts.push(bal) })

    const ctx = canvas.getContext('2d')
    const W = canvas.width, H = canvas.height
    ctx.clearRect(0, 0, W, H)
    const min = Math.min(...pts), max = Math.max(...pts)
    const range = (max - min) || 1
    const stepX = W / (pts.length - 1)
    const y = v => H - 8 - ((v - min) / range) * (H - 16)

    const up = pts[pts.length-1] >= start
    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, up ? 'rgba(52,211,153,0.25)' : 'rgba(239,68,68,0.25)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.beginPath()
    ctx.moveTo(0, y(pts[0]))
    pts.forEach((p, i) => ctx.lineTo(i * stepX, y(p)))
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath()
    ctx.fillStyle = grad; ctx.fill()
    // Line
    ctx.beginPath()
    ctx.moveTo(0, y(pts[0]))
    pts.forEach((p, i) => ctx.lineTo(i * stepX, y(p)))
    ctx.strokeStyle = up ? '#34d399' : '#ef4444'
    ctx.lineWidth = 2
    ctx.shadowColor = up ? 'rgba(52,211,153,0.6)' : 'rgba(239,68,68,0.6)'
    ctx.shadowBlur = 6
    ctx.stroke()
    ctx.shadowBlur = 0
  } catch(e) {}
}
setInterval(drawEquitySpark, 30000)
setTimeout(drawEquitySpark, 2000)

// ── Engine chip — live scanner status + interval ──────────────────────────
async function updateEngineChip() {
  try {
    const s = await ipcRenderer.invoke('get-scanner-status').catch(() => null)
    const el = document.getElementById('ov-engine')
    if(!el) return
    if (!el || !s) return
    if (s.paused) {
      el.innerHTML = '<span style="color:#ef4444;">⏸ Paused</span>'
    } else if (s.running) {
      el.innerHTML = `<span class="scan-pulse"></span>${s.intervalMin}min`
      el.title = `Scanning every ${s.intervalMin} min` + (s.scalpEnabled ? ' + scalp' : '')
    } else {
      el.innerHTML = '<span style="color:#fbbf24;">○ Off</span>'
    }
  } catch(e) {}
}
setInterval(updateEngineChip, 20000)
setTimeout(updateEngineChip, 2000)


// ── Close All (panic button) — only visible when positions open ──────────
document.getElementById('ov-close-all-btn')?.addEventListener('click', async function() {
  if (!confirm('Close ALL open positions at market price?')) return
  this.textContent = '⏳ Closing...'
  const r = await ipcRenderer.invoke('close-all-trades').catch(() => null)
  this.textContent = r?.success ? `✅ Closed ${r.closed} positions` : '❌ Failed'
  setTimeout(() => { this.textContent = '🛑 Close ALL Open Positions'; updateOverviewStrip() }, 2500)
})

// Show/hide panic button based on open count
const _ovOpenObserver = setInterval(() => {
  const open = parseInt(document.getElementById('ov-open')?.textContent || '0')
  const btn = document.getElementById('ov-close-all-btn')
  if(!btn) return
  if (btn) btn.style.display = open > 0 ? 'block' : 'none'
}, 5000)



// ── Renamed duplicate-ID elements wiring ─────────────────────────────────
document.getElementById('trade-add-alert-btn')?.addEventListener('click', () => {
  // Reuse the same alert-add path as page 1 widget
  document.getElementById('add-alert-btn')?.click()
  setTimeout(() => {
    const src = document.getElementById('alerts-list')
    if(!src) return
    const dst = document.getElementById('trade-alerts-list')
    if(!dst) return
    if (src && dst) dst.innerHTML = src.innerHTML
  }, 400)
})

// Mirror lessons into Others → Memory journal when populated
const _origLessonsObserver = new MutationObserver(() => {
  const src = document.getElementById('pt-lessons-list')
  if(!src) return
  const dst = document.getElementById('memory-lessons-list')
  if(!dst) return
  if (src && dst) dst.innerHTML = src.innerHTML
})
const _ptl = document.getElementById('pt-lessons-list')
if (_ptl) _origLessonsObserver.observe(_ptl, { childList: true, subtree: true })


// ── Second Brain ─────────────────────────────────────────────────────────
async function loadMemories() {
  const memories = await ipcRenderer.invoke('get-memories')
  const list = document.getElementById('memories-list')
  if(!list) return
  if (!memories?.length) {
    list.innerHTML = '<div style="color:var(--text2);">No memories saved yet</div>'
    return
  }
  list.innerHTML = memories.slice(-5).reverse().map(m => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border2);">
      <div>
        <div style="font-size:12px;">${m.text}</div>
        <div style="font-size:10px;color:var(--text2);">${m.date}</div>
      </div>
      <button onclick="deleteMemory(${m.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;">×</button>
    </div>
  `).join('')
}

async function deleteMemory(id) {
  await ipcRenderer.invoke('delete-memory', id)
  loadMemories()
}

document.getElementById('save-memory-btn')?.addEventListener('click', async () => {
  const input = document.getElementById('memory-input')
  if(!input) return
  const text = input.value.trim()
  if (!text) return
  await ipcRenderer.invoke('add-memory-ipc', text)
  input.value = ''
  loadMemories()
})

// ── Morning Briefing ─────────────────────────────────────────────────────
document.getElementById('morning-briefing-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'morningBriefing', this.classList.contains('on'))
})

// Restore all new settings
async function restoreNewSettings() {
  try {
    const settings = await ipcRenderer.invoke('get-settings')
    if (settings?.rageLockEnabled) {
      const rlt = document.getElementById('rage-lock-toggle')
      if(!rlt) return
      const rls = document.getElementById('rage-lock-settings')
      if(!rls) return
      if (rlt) rlt.classList.add('on')
      if (rls) rls.style.display = 'block'
    }
    const mbt = document.getElementById('morning-briefing-toggle')
    if(!mbt) return
    if (settings?.morningBriefing && mbt) mbt.classList.add('on')
    loadMemories()
    loadPsychScore()
  } catch(e) { console.error('restoreNewSettings error:', e) }
}

async function toggleTrustedCaller(caller) {
  ipcRenderer.send('toggle-trusted-caller', caller)
  // Refresh after toggle
  setTimeout(async () => {
    const tgStats = await ipcRenderer.invoke('telegram-get-stats')
    renderLeaderboard(tgStats?.stats || {})
  }, 300)
}

} catch(eNewFeatures) { console.error('New features setup error:', eNewFeatures) }

// ── Spot Trading ──────────────────────────────────────────────────────────
let spotSellPct = 25

async function loadSpotBalances() {
  const list = document.getElementById('spot-balances-list')
  if (!list) return
  list.innerHTML = '<span style="color:var(--text2)">Loading...</span>'
  try {
    const balances = await ipcRenderer.invoke('get-spot-balances')
    if (!balances?.length) {
      list.innerHTML = '<span style="color:var(--text2)">No holdings — buy some coins!</span>'
      return
    }
    list.innerHTML = balances.map(b => {
      const val = b.coin === 'USDT' ? `$${b.total.toFixed(2)}` : `${b.total.toFixed(4)} ${b.coin}`
      return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border2);">
        <span>${b.coin}</span>
        <span style="color:var(--text)">${val}</span>
      </div>`
    }).join('')
  } catch(e) {
    list.innerHTML = '<span style="color:var(--red)">Error loading balances</span>'
  }
}

// Sell percentage buttons
document.querySelectorAll('.spot-sell-pct-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.spot-sell-pct-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    spotSellPct = parseInt(this.dataset.pct)
  })
})

// Refresh balances
document.getElementById('refresh-spot-btn')?.addEventListener('click', loadSpotBalances)

// Market Buy
document.getElementById('spot-buy-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('spot-buy-coin').value
  const amount = parseFloat(document.getElementById('spot-buy-amount').value)
  const status = document.getElementById('spot-status')
  if(!status) return
  if (!amount || amount <= 0) { status.textContent = 'Enter amount'; status.style.color = 'var(--red)'; return }
  status.textContent = `Buying $${amount} of ${coin}...`
  status.style.color = 'var(--text2)'
  try {
    const order = await ipcRenderer.invoke('spot-buy', { coin, amount })
    if (order) {
      status.textContent = `✅ Bought ${order.quantity} ${coin} at ~$${parseFloat(order.price||0).toLocaleString()}`
      status.style.color = 'var(--green)'
      setEl('spot-buy-amount','value','')
      setTimeout(loadSpotBalances, 1000)
    } else {
      status.textContent = '❌ Buy failed — check balance'
      status.style.color = 'var(--red)'
    }
  } catch(e) {
    status.textContent = `❌ Error: ${e.message?.slice(0,40)}`
    status.style.color = 'var(--red)'
  }
})

// Market Sell
document.getElementById('spot-sell-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('spot-sell-coin').value
  const status = document.getElementById('spot-status')
  if(!status) return
  status.textContent = `Selling ${spotSellPct}% of ${coin}...`
  status.style.color = 'var(--text2)'
  try {
    const order = await ipcRenderer.invoke('spot-sell', { coin, percent: spotSellPct })
    if (order) {
      status.textContent = `✅ Sold ${order.quantity} ${coin} at ~$${parseFloat(order.price||0).toLocaleString()}`
      status.style.color = 'var(--green)'
      setTimeout(loadSpotBalances, 1000)
    } else {
      status.textContent = `❌ Sell failed — no ${coin} balance?`
      status.style.color = 'var(--red)'
    }
  } catch(e) {
    status.textContent = `❌ Error: ${e.message?.slice(0,40)}`
    status.style.color = 'var(--red)'
  }
})

// Limit Buy
document.getElementById('spot-limit-buy-btn')?.addEventListener('click', async () => {
  const coin = document.getElementById('spot-limit-coin').value
  const price = parseFloat(document.getElementById('spot-limit-price').value)
  const amount = parseFloat(document.getElementById('spot-limit-amount').value)
  const status = document.getElementById('spot-status')
  if(!status) return
  if (!price || !amount) { status.textContent = 'Enter price and amount'; status.style.color = 'var(--red)'; return }
  const order = await ipcRenderer.invoke('spot-limit-buy', { coin, amount, price })
  if (order) {
    status.textContent = `✅ Limit buy set: ${order.quantity} ${coin} at $${price.toLocaleString()}`
    status.style.color = 'var(--green)'
    setEl('spot-limit-price','value','')
    setEl('spot-limit-amount','value','')
    loadOpenLimitOrders()
  } else {
    status.textContent = '❌ Limit order failed'
    status.style.color = 'var(--red)'
  }
})

async function loadOpenLimitOrders() {
  const list = document.getElementById('open-limit-orders-list')
  if (!list) return
  try {
    const orders = await ipcRenderer.invoke('get-open-spot-orders')
    if (!orders?.length) { list.innerHTML = 'None'; return }
    list.innerHTML = orders.map(o => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border2);">
        <span>${o.side} ${o.symbol} × ${o.origQty} @ $${parseFloat(o.price).toLocaleString()}</span>
        <button onclick="cancelLimitOrder('${o.symbol}', ${o.orderId})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;">✕</button>
      </div>
    `).join('')
  } catch(e) { list.innerHTML = 'Error loading orders' }
}

async function cancelLimitOrder(symbol, orderId) {
  const cancelled = await ipcRenderer.invoke('cancel-spot-order', { symbol, orderId })
  if (cancelled) {
    setEl('spot-status','textContent','✅ Order cancelled')
    document.getElementById('spot-status').style.color = 'var(--green)'
    loadOpenLimitOrders()
  }
}

// Load spot data when trading page opens
ipcRenderer.on('page-changed', (e, page) => {
  if (page === 3) {
    loadSpotBalances()
    loadOpenLimitOrders()
  }
})

// Max drawdown protection
function saveMaxDrawdown(val) {
  if (!val || val <= 0) return
  ipcRenderer.send('set-setting', 'maxDrawdown', val)
  setEl('max-drawdown-input', 'value', val)
  setEl('tg-max-drawdown-input', 'value', val)
  setEl('drawdown-hint', 'textContent', `Auto-close if trade loses more than ${val}%`)
  const dh = document.getElementById('drawdown-hint')
  if (dh) dh.style.color = 'var(--red)'
}
function disableMaxDrawdown() {
  setEl('max-drawdown-input', 'value', '')
  setEl('tg-max-drawdown-input', 'value', '')
  ipcRenderer.send('set-setting', 'maxDrawdown', null)
  setEl('drawdown-hint', 'textContent', 'Disabled — trades close only at SL or target')
  const dh = document.getElementById('drawdown-hint')
  if (dh) dh.style.color = 'var(--text2)'
}
document.getElementById('save-drawdown-btn')?.addEventListener('click', () => {
  saveMaxDrawdown(parseFloat(document.getElementById('max-drawdown-input')?.value))
})
document.getElementById('tg-save-drawdown-btn')?.addEventListener('click', () => {
  saveMaxDrawdown(parseFloat(document.getElementById('tg-max-drawdown-input')?.value))
})
document.getElementById('disable-drawdown-btn')?.addEventListener('click', disableMaxDrawdown)

// Custom position size
function loadSettings() {
  return window._cachedSettings || {}
}

document.getElementById('save-size-btn')?.addEventListener('click', () => {
  const size = parseFloat(document.getElementById('trade-size-input').value)
  if (!size || size <= 0) return
  
  // Validate against leverage
  const leverage = loadSettings()?.paperLeverage || 1
  const position = size * leverage
  const hintEl = document.getElementById('size-hint')
  
  ipcRenderer.send('set-setting', 'paperTradeSize', size)
  
  if (position > 10000) {
    hintEl.textContent = `⚠️ $${size} × ${leverage}x = $${position.toLocaleString()} position — may exceed Binance testnet limits. Try reducing size or leverage.`
    hintEl.style.color = 'var(--red)'
  } else if (position > 5000) {
    hintEl.textContent = `⚡ $${size} × ${leverage}x = $${position.toLocaleString()} position — borderline for testnet`
    hintEl.style.color = 'var(--gold)'
  } else {
    hintEl.textContent = `✅ $${size} × ${leverage}x = $${position.toLocaleString()} position — good for testnet`
    hintEl.style.color = 'var(--green)'
  }
})

// reset-size-btn removed - not in HTML

// Auto refresh trading page when trade opens/closes
ipcRenderer.on('trade-opened', () => {
  const tab = document.querySelector('.page-tab[data-page="3"]')
  if (tab) loadTradingUI() // Always refresh regardless of current page
})

// Auto refresh every 30 seconds if on trading page
setInterval(() => {
  const tab = document.querySelector('.page-tab[data-page="3"]')
  if (tab?.classList.contains('active')) loadTradingUI()
}, 30000)

// Leverage selector


// removed bad global leverage-btn handler

// Toggles
document.getElementById('auto-trade-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'autoPaperTrade', this.classList.contains('on'))
  try { refreshBotStatusCards() } catch(e) {}
})

// Scan interval buttons
document.querySelectorAll('.interval-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const minutes = parseInt(this.dataset.min)
    document.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    ipcRenderer.send('set-setting', 'scanIntervalMinutes', minutes)
    ipcRenderer.send('restart-scanner')

    // Cost estimate
    const scansPerDay = 1440 / minutes
    const coinsCount = document.querySelectorAll('.coin-btn[data-coin].active').length || 4
    const dailyCost = (scansPerDay * coinsCount * 0.18 * 0.009 + coinsCount * 0.007).toFixed(2)
    setEl('scan-interval-hint','textContent',`Every ${minutes} min — ${scansPerDay} scans/day`)
    setEl('scan-cost-hint','textContent',`Est. precision cost: ~$${dailyCost}/day (~$${(dailyCost * 30).toFixed(0)}/month)`)
  })
})

document.getElementById('independent-scanner-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'independentScanner', this.classList.contains('on'))
  const on = this.classList.contains('on')
  if (on) ipcRenderer.send('start-independent-scanner')
})

// ── Trading UI ──
async function renderLeaderboard(stats) {
  const list = document.getElementById('pt-leaderboard')
  if(!list) return
  if (!stats || !Object.keys(stats).length) { list.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No data yet</div>'; return }
  const sorted = Object.entries(stats).sort((a, b) => b[1].winRate - a[1].winRate)
  const trustedCallers = await ipcRenderer.invoke('get-trusted-callers')
  list.innerHTML = sorted.map(([caller, s], i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`
    const rateClass = s.winRate >= 65 ? 'win-rate-good' : s.winRate >= 45 ? 'win-rate-ok' : 'win-rate-bad'
    const isTrusted = trustedCallers.includes(caller)
    return `
    <div class="caller-item">
      <div style="font-size:16px;width:24px">${medal}</div>
      <div style="flex:1">
        <div class="caller-name">${caller}</div>
        <div class="caller-stats">${s.total} calls • ${s.wins}W/${s.losses}L</div>
        ${isTrusted ? '<div style="font-size:10px;color:#fbbf24;font-weight:700;">⭐ AUTO-COPY ON</div>' : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="caller-stats ${rateClass}" style="font-size:16px;font-weight:700">${s.winRate}%</div>
        <button onclick="toggleTrustedCaller('${caller}')" style="background:${isTrusted ? 'rgba(251,191,36,0.2)' : 'var(--bg3)'};color:${isTrusted ? '#fbbf24' : 'var(--text2)'};border:1px solid ${isTrusted ? 'rgba(251,191,36,0.4)' : 'var(--border)'};border-radius:6px;padding:4px 8px;font-size:10px;cursor:pointer;font-weight:700;">
          ${isTrusted ? '⭐ Trusted' : 'Trust?'}
        </button>
      </div>
    </div>`
  }).join('')
}


function renderOpenPositions(stats) {
  const openList = document.getElementById('pt-open-list')
  if (!openList) return
  const openTrades = stats.trades.filter(t => t.status === 'open' && t.useBinance)
  if (!openTrades.length) {
    openList.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No open positions</div>'
    return
  }
  openList.innerHTML = openTrades.map(t => {
    const pnlClass = (t.unrealizedPnl || 0) >= 0 ? 'trade-pnl-pos' : 'trade-pnl-neg'
    const pnlStr = t.unrealizedPnl !== undefined ? `${t.unrealizedPnl >= 0 ? '+' : ''}$${t.unrealizedPnl} (${t.unrealizedPct >= 0 ? '+' : ''}${t.unrealizedPct}%)` : 'Live...'
    const conf = t.confidence || 0
    const confClass = conf >= 65 ? 'high' : conf >= 40 ? 'med' : 'low'
    const scalpBadge = t.isScalp ? `<span style="background:rgba(251,191,36,0.2);color:#fbbf24;border:1px solid rgba(251,191,36,0.4);border-radius:4px;font-size:10px;padding:1px 6px;font-weight:700;">⚡ SCALP</span>` : ''
    const remaining = t.isScalp && t.scalpExpiry ? Math.max(0, t.scalpExpiry - Date.now()) : 0
    const countdown = remaining > 0 ? `<div class="trade-info" style="color:#fbbf24;">Auto-closes in ${Math.floor(remaining/60000)}m ${Math.floor((remaining%60000)/1000)}s</div>` : ''
    return `<div class="trade-item" style="flex-direction:column;gap:6px;align-items:flex-start;${t.isScalp ? 'border-left:2px solid #fbbf24;' : ''}">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="trade-coin">${t.coin} ${t.direction?.toUpperCase()} ${t.leverage > 1 ? t.leverage+'x' : ''}</div>
          <span class="conf-badge conf-badge-${confClass}">${conf}%</span>${scalpBadge}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="${pnlClass}" style="font-size:15px;">${pnlStr}</div>
          <button class="tg-remove-btn" onclick="closeTrade(${t.id},${t.currentPrice||t.entry})">Close</button>
        </div>
      </div>
      <div class="conf-meter"><div class="conf-meter-fill conf-${confClass}" style="width:${conf}%"></div></div>
      <div class="trade-info">Entry: $${t.entry} | Target: $${t.target} | SL: $${t.stopLoss}</div>
      <div class="trade-info">Size: $${t.size} | Liq: $${t.liquidationPrice} | ${new Date(t.openTime).toLocaleTimeString()}</div>
      ${countdown}
    </div>`
  }).join('')

  // Update stats
  const closed = stats.trades.filter(t => t.status !== 'open' && t.useBinance)
  const wins = closed.filter(t => t.pnl > 0).length
  const total = closed.length
  const winRate = total > 0 ? Math.round(wins/total*100) : 0
  const pnl = closed.reduce((s,t) => s+(t.pnl||0), 0)
  const unrealized = openTrades.reduce((s,t) => s+(t.unrealizedPnl||0), 0)

  const wrEl = document.getElementById('pt-winrate')
  if(!wrEl) return
  const pnlEl = document.getElementById('pt-pnl')
  if(!pnlEl) return
  const totalEl = document.getElementById('pt-total')
  if(!totalEl) return
  const balEl = document.getElementById('pt-balance')
  if(!balEl) return
  if (wrEl) { wrEl.textContent = `${winRate}%`; wrEl.style.color = winRate>=60?'var(--green)':winRate>=40?'var(--text)':'var(--red)' }
  if (pnlEl) { const d = pnl+unrealized; pnlEl.textContent = `${d>=0?'+':''}$${d.toFixed(2)}`; pnlEl.style.color = d>=0?'var(--green)':'var(--red)' }
  if (totalEl) totalEl.textContent = total
  if (balEl) balEl.textContent = `$${Number(stats.balance||100000).toLocaleString()}`
}

async function renderTradeHistory(stats) {
  const histList = document.getElementById('pt-history-list')
  if (!histList) return
  const closed = stats.trades.filter(t => t.status !== 'open' && t.useBinance).slice(-50).reverse()
  histList.innerHTML = closed.length ? closed.map(t => {
    const conf = t.confidence || 0
    const confClass = conf >= 65 ? 'high' : conf >= 40 ? 'med' : 'low'
    return `<div class="trade-item">
      <div class="trade-left">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="trade-coin">${t.coin} ${t.direction?.toUpperCase()} ${t.leverage>1?t.leverage+'x':''}</div>
          <span class="conf-badge conf-badge-${confClass}">${conf}%</span>
        </div>
        <div class="trade-info">$${t.entry} → $${t.closePrice||'?'} • ${t.closeReason||''}</div>
        <div class="trade-info">${new Date(t.closeTime||t.openTime).toLocaleDateString()}</div>
      </div>
      <div class="${t.status==='win'?'trade-pnl-pos':'trade-pnl-neg'}">${t.pnl>=0?'+':''}$${t.pnl}</div>
    </div>`
  }).join('')
  : '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No trades yet</div>'

  // Render lessons
  const lessonsList = document.getElementById('pt-lessons-list')
  if(!lessonsList) return
  if (lessonsList) {
    const lessons = await ipcRenderer.invoke('get-lessons').catch(() => [])
    if (lessons.length) {
      lessonsList.innerHTML = lessons.slice(-10).reverse().map(l => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border2);font-size:12px;">
          <div style="color:var(--accent);margin-bottom:3px;">📋 ${l.rule||l.lesson||''}</div>
          <div style="color:var(--text2);font-size:11px;">${new Date(l.timestamp||Date.now()).toLocaleDateString()}</div>
        </div>`).join('')
    } else {
      lessonsList.innerHTML = '<div style="color:var(--text2);font-size:12px;text-align:center;padding:16px;">No lessons yet — still learning</div>'
    }
  }
}

async function loadTradingUI() {
  // Never hang forever on a stuck main-process IPC
  const settings = await ipcTimeout('get-settings', undefined, 5000) || {}
  window._cachedSettings = settings

  try { applySettingsToUI(settings) } catch(e) { console.error('applySettingsToUI error:', e.message) }

  // Populate main/overview widgets without blocking each other
  try { loadMainTradeTab() } catch(e) {}
  try { loadOverviewTab() } catch(e) {}
  loadOpenPositions()
  loadTradeHistory()

  setTimeout(loadMarketRegime, 400)
  setTimeout(loadTradeAnalytics, 800)
  setTimeout(loadUsageStats, 500)
  setTimeout(loadDailySignals, 600)

  let tgStats = { stats: {} }
  try { tgStats = await ipcTimeout('telegram-get-stats', undefined, 4000) || { stats: {} } } catch(e) {}

  try {
    const stats = await ipcTimeout('get-paper-stats', undefined, 5000)
    if (stats) {
      updateStatsDisplay(stats, tgStats)
      try { renderMainTrades(stats) } catch(e) {}
    }
  } catch(e) {}
}

async function loadOpenPositions() {
  const list = document.getElementById('pt-open-list')
  if (!list) return
  try {
    const trades = await Promise.race([
      ipcRenderer.invoke('get-paper-trades'),
      new Promise(r => setTimeout(() => r(null), 5000))
    ])
    if (!trades) {
      list.innerHTML = '<div style="color:var(--text2);text-align:center;padding:16px;font-size:12px;">No open positions</div>'
      return
    }
    renderOpenPositions(trades)
    renderTradeHistory(trades)
  } catch(e) {
    list.innerHTML = '<div style="color:var(--text2);text-align:center;padding:16px;font-size:12px;">No open positions</div>'
  }
}

async function loadTradeHistory() {
  const list = document.getElementById('pt-history-list')
  if (!list) return
  try {
    const trades = await ipcRenderer.invoke('get-paper-trades').catch(() => null)
    if (trades) renderTradeHistory(trades)
  } catch(e) {}
}

function applySettingsToUI(settings) {
  if (!settings) return
  try {
    // Toggles — never early-return; missing nodes must not abort the rest of the restore
    const autoEl = document.getElementById('auto-trade-toggle')
    const scanEl = document.getElementById('independent-scanner-toggle')
    const chartEl = chartAnalysisToggleEl()
    const scalpEl = document.getElementById('scalp-toggle')
    if (autoEl) autoEl.classList.toggle('on', !!settings.autoPaperTrade)
    if (scanEl) scanEl.classList.toggle('on', !!settings.independentScanner)
    if (chartEl) chartEl.classList.toggle('on', !!settings.chartAnalysis)
    if (scalpEl) scalpEl.classList.toggle('on', !!settings.scalpTrading)

    // Main leverage - ONLY .lev-btn
    if (settings.paperLeverage) {
      document.querySelectorAll('.lev-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.lev) === settings.paperLeverage)
      )
      const warn = document.getElementById('lev-warning')
      if (warn) warn.textContent = levWarnings[settings.paperLeverage] || ''
    }

    // Scalp leverage
    if (settings.scalpLeverage) {
      document.querySelectorAll('.scalp-lev-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.lev) === settings.scalpLeverage)
      )
    }

    // Scalp duration
    if (settings.scalpDuration) {
      document.querySelectorAll('.scalp-dur-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.min) === settings.scalpDuration)
      )
    }

    // Scan interval
    if (settings.scanInterval) {
      document.querySelectorAll('.interval-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.min) === settings.scanInterval)
      )
    }

    // Max scalps
    if (settings.maxScalpTrades) {
      document.querySelectorAll('.scalp-max-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.val) === settings.maxScalpTrades)
      )
    }

    // Trade size
    const sizeEl = document.getElementById('trade-size-input')
    if (sizeEl && settings.paperTradeSize) sizeEl.value = settings.paperTradeSize

    // Scalp size
    const scalpSizeEl = document.getElementById('scalp-size-input')
    if (scalpSizeEl && settings.scalpSize) scalpSizeEl.value = settings.scalpSize

    // Drawdown
    const ddEl = document.getElementById('max-drawdown-input')
    if (ddEl && settings.maxDrawdown) ddEl.value = settings.maxDrawdown

    // TP/SL mode
    if (settings.tpSlMode) showTpSlPanel(settings.tpSlMode)
    if (settings.tpSlRatio) {
      document.querySelectorAll('.ratio-btn').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.ratio) === settings.tpSlRatio)
      )
    }
    if (settings.customTpPct) { const el = document.getElementById('custom-tp-input'); if(el) el.value = settings.customTpPct }
    if (settings.customSlPct) { const el = document.getElementById('custom-sl-input'); if(el) el.value = settings.customSlPct }

    // TA mode
    if (settings.taMode === 'manual') {
      document.getElementById('ta-manual-btn')?.classList.add('active')
      document.getElementById('ta-auto-btn')?.classList.remove('active')
      const panel = document.getElementById('ta-manual-panel')
      if (panel) panel.style.display = 'block'
    }

    // Indicators
    const taInds = settings.enabledIndicators || {}
    Object.entries({'ta-rsi-toggle':'rsi','ta-ma-toggle':'ma','ta-macd-toggle':'macd','ta-bb-toggle':'bb','ta-sr-toggle':'sr','ta-ob-toggle':'ob','ta-corr-toggle':'corr','ta-time-toggle':'time','ta-ichimoku-toggle':'ichimoku','ta-atr-toggle':'atr','ta-vwap-toggle':'vwap','ta-stochrsi-toggle':'stochRsi','ta-emacross-toggle':'emaCross','ta-fundingextreme-toggle':'fundingExtreme','ta-pivots-toggle':'pivots'}).forEach(([id,key]) => {
      const el = document.getElementById(id)
      if (el) el.classList.toggle('on', taInds[key] !== false)
    })

    const scalpInds = settings.scalpIndicators || {}
    Object.entries({'scalp-rsi-toggle':'rsi','scalp-bb-toggle':'bb','scalp-sr-toggle':'sr','scalp-ob-toggle':'ob'}).forEach(([id,key]) => {
      const el = document.getElementById(id)
      if (el) el.classList.toggle('on', scalpInds[key] !== false)
    })

    // Coin selection
    restoreCoinSelections(settings)

    // Build indicator sections with toggle + advanced
    buildIndicatorSections(settings)

    // Advanced trading settings
    restoreAdvancedSettings(settings)

    // Daily loss limit restore
    if (settings?.dailyLossLimit) {
      const matchBtn = [...document.querySelectorAll('.daily-loss-btn')].find(b => parseFloat(b.dataset.val) === settings.dailyLossLimit)
      if (matchBtn) { document.querySelectorAll('.daily-loss-btn').forEach(b => b.classList.remove('active')); matchBtn.classList.add('active') }
      else { const el = document.getElementById('custom-loss-limit'); if(el) el.value = settings.dailyLossLimit }
    }
    if (settings?.maxOpenPositions !== undefined) {
      document.querySelectorAll('.max-pos-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.val) === settings.maxOpenPositions))
    }

    // Load DCA and alerts
    setTimeout(() => { loadDCAPlans(); loadAlerts(); }, 200)

    // Daily trade bot settings
    restoreDailySettings(settings)

    // Confidence thresholds
    restoreConfidenceSettings()

    // Scalp panel visibility
    const scalpPanel = document.getElementById('scalp-settings-panel')
    if (scalpPanel) scalpPanel.style.display = settings.scalpTrading ? 'block' : 'none'

    // Rage lock settings
    if (settings.rageLockThreshold) {
      document.querySelectorAll('.rage-thresh-btn').forEach(b =>
        b.classList.toggle('active', parseInt(b.dataset.val) === settings.rageLockThreshold)
      )
    }

  } catch(e) { console.error('applySettingsToUI error:', e) }
}

function updateStatsDisplay(stats, tgStats) {
  try {
    const wins = stats.stats?.wins || 0
    const losses = stats.stats?.losses || 0
    const total = wins + losses
    const winRate = total > 0 ? Math.round(wins/total*100) : 0
    const pnl = stats.stats?.totalPnl || 0
    const balance = stats.balance || 100000

    const wrEl = document.getElementById('pt-winrate')
    const pnlEl = document.getElementById('pt-pnl')
    const totalEl = document.getElementById('pt-total')
    const balEl = document.getElementById('pt-balance')

    if (wrEl) { wrEl.textContent = `${winRate}%`; wrEl.style.color = winRate >= 60 ? 'var(--green)' : winRate >= 40 ? 'var(--text)' : 'var(--red)' }
    if (pnlEl) { pnlEl.textContent = `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`; pnlEl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)' }
    if (totalEl) totalEl.textContent = total
    if (balEl) balEl.textContent = `$${balance.toLocaleString()}`
  } catch(e) {}
}

async function _loadTradingUI_old() {
  // kept for reference - replaced by loadTradingUI above
}

async function _old_stats_block() {

  // Restore confidence settings first (safe — always exists)
  restoreConfidenceSettings()

  // Restore all toggles
  try {
    const autoEl = document.getElementById('auto-trade-toggle')
    if(!autoEl) return
    const scanEl = document.getElementById('independent-scanner-toggle')
    if(!scanEl) return
    const chartEl = chartAnalysisToggleEl()
    if(!chartEl) return
    if (autoEl) autoEl.classList.toggle('on', !!settings?.autoPaperTrade)
    if (scanEl) scanEl.classList.toggle('on', !!settings?.independentScanner)
    if (chartEl) chartEl.classList.toggle('on', !!settings?.chartAnalysis)
  } catch(e) { console.error('Toggle restore error:', e) }

  // Restore leverage - ONLY target .lev-btn not all .leverage-btn
  if (settings?.paperLeverage) {
    document.querySelectorAll('.lev-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.lev) === settings.paperLeverage)
    })
    if(document.getElementById('lev-warning')) setEl('lev-warning','textContent',levWarnings[settings.paperLeverage] || `${settings.paperLeverage}x leverage`)
  }

  // Restore trade size
  if (settings?.paperTradeSize) {
    setEl('trade-size-input','value',settings.paperTradeSize)
    setEl('size-hint','textContent',`Fixed size: $${settings.paperTradeSize} per trade`)
  }

  // Restore scan interval
  const intervalMin = settings?.scanIntervalMinutes || 30
  document.querySelectorAll('.interval-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.min) === intervalMin)
  })
  const scansPerDay = Math.round(1440 / intervalMin)
  setEl('scan-interval-hint','textContent',`Every ${intervalMin} min — ${scansPerDay} scans/day`)

  // Restore coin selections
  restoreCoinSelections(settings)

  // Restore scalp settings
  if (settings?.scalpTrading) {
    document.getElementById('scalp-toggle').classList.add('on')
    document.getElementById('scalp-settings-panel').style.display = 'block'
  }
  if (settings?.scalpLeverage) {
    document.querySelectorAll('.scalp-lev-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.lev) === settings.scalpLeverage)
    })
  }
  if (settings?.scalpDuration) {
    document.querySelectorAll('.scalp-dur-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.min) === settings.scalpDuration)
    })
  }
  if (settings?.scalpSize) {
    setEl('scalp-size-input','value',settings.scalpSize)
    setEl('scalp-hint','textContent',`Scalp size: $${settings.scalpSize} per trade`)
  }

  // Restore max drawdown
  if (settings?.maxDrawdown) {
    setEl('max-drawdown-input','value',settings.maxDrawdown)
    setEl('tg-max-drawdown-input','value',settings.maxDrawdown)
    setEl('drawdown-hint','textContent',`Auto-close if trade loses more than ${settings.maxDrawdown}%`)
    const dh = document.getElementById('drawdown-hint')
    if (dh) dh.style.color = 'var(--red)'
  }

  // Hero stats — Binance trades only
  const binanceTrades = stats.trades.filter(t => t.useBinance)
  const binanceClosed = binanceTrades.filter(t => t.status !== 'open')
  const binanceWins = binanceClosed.filter(t => t.pnl > 0).length
  const binanceLosses = binanceClosed.filter(t => t.pnl <= 0).length
  const binanceWinRate = binanceClosed.length > 0 ? Math.round(binanceWins / binanceClosed.length * 100) : 0
  const binancePnl = binanceClosed.reduce((s, t) => s + (t.pnl || 0), 0)

  setEl('pt-winrate','textContent',`${binanceWinRate}%`)
  setEl('pt-total','textContent',binanceClosed.length)
  setEl('pt-balance','textContent',`$${Number(stats.balance || 100000).toLocaleString('en-US', {maximumFractionDigits:2})}`)
  
  // Show Binance testnet indicator
  const binanceBar = document.getElementById('binance-status-bar')
  if(!binanceBar) return
  if (stats.source === 'binance') {
    binanceBar.style.display = 'flex'
    setEl('binance-balance','textContent',`$${Number(stats.balance).toFixed(2)}`)
    setEl('binance-positions','textContent',stats.openTrades)
  }

  const pnlEl = document.getElementById('pt-pnl')
  if(!pnlEl) return
  const unrealized = openTrades.reduce((s, t) => s + (t.unrealizedPnl || 0), 0)
  const totalDisplay = binancePnl + unrealized
  pnlEl.textContent = `${totalDisplay >= 0 ? '+' : ''}$${totalDisplay.toFixed(2)}`
  pnlEl.style.webkitTextFillColor = totalDisplay >= 0 ? 'var(--green)' : 'var(--red)'

  // Open positions
  const openList = document.getElementById('pt-open-list')
  if(!openList) return
  const openTrades = stats.trades.filter(t => t.status === 'open' && t.useBinance)
  openList.innerHTML = openTrades.length ? openTrades.map(t => {
    const pnlClass = (t.unrealizedPnl || 0) >= 0 ? 'trade-pnl-pos' : 'trade-pnl-neg'
    const pnlStr = t.unrealizedPnl !== undefined ? `${t.unrealizedPnl >= 0 ? '+' : ''}$${t.unrealizedPnl} (${t.unrealizedPct >= 0 ? '+' : ''}${t.unrealizedPct}%)` : 'Loading...'
    const currentStr = t.currentPrice ? `$${t.currentPrice}` : '...'
    const conf = t.confidence || 0
    const confClass = conf >= 65 ? 'high' : conf >= 40 ? 'med' : 'low'
    const badgeClass = `conf-badge-${confClass}`
    const fillClass = `conf-${confClass}`
    
    // Scalp badge + countdown
    const scalpBadge = t.isScalp ? `<span style="background:rgba(251,191,36,0.2);color:#fbbf24;border:1px solid rgba(251,191,36,0.4);border-radius:4px;font-size:10px;padding:1px 6px;font-weight:700;">⚡ SCALP</span>` : ''
    const scalpCountdown = t.isScalp && t.scalpExpiry ? (() => {
      const remaining = Math.max(0, t.scalpExpiry - Date.now());
      const mins = Math.floor(remaining / 60000);
      const secs = Math.floor((remaining % 60000) / 1000);
      return `<span style="font-size:10px;color:#fbbf24;">Auto-closes in ${mins}m ${secs}s</span>`
    })() : ''

    return `
    <div class="trade-item" style="flex-direction:column;gap:6px;align-items:flex-start;${t.isScalp ? 'border-left:2px solid #fbbf24;' : ''}">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="trade-coin">${t.coin} ${t.direction?.toUpperCase()} ${t.leverage > 1 ? `${t.leverage}x` : ''}</div>
          <span class="conf-badge ${badgeClass}">${conf}%</span>
          ${scalpBadge}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="${pnlClass}" style="font-size:15px;">${pnlStr}</div>
          <button class="tg-remove-btn" onclick="closeTrade(${t.id}, ${t.currentPrice || t.entry})">Close</button>
        </div>
      </div>
      <div class="conf-meter"><div class="conf-meter-fill ${fillClass}" style="width:${conf}%"></div></div>
      <div class="trade-info">Entry: $${t.entry} → Current: ${currentStr} | Target: $${t.target} | SL: $${t.stopLoss}</div>
      <div class="trade-info">Liq: $${t.liquidationPrice} | Size: $${t.size} | Opened: ${new Date(t.openTime).toLocaleTimeString()}</div>
      <div class="trade-info" style="color:var(--accent);">@${t.caller} • ${t.groupName}</div>
      ${scalpCountdown ? `<div class="trade-info">${scalpCountdown}</div>` : ''}
    </div>`
  }).join('')
  : '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No open positions</div>'

  // History
  const histList = document.getElementById('pt-history-list')
  if(!histList) return
  const closed = stats.trades.filter(t => t.status !== 'open' && t.useBinance)
  histList.innerHTML = closed.length ? closed.map(t => {
    const conf = t.confidence || 0
    const confClass = conf >= 65 ? 'high' : conf >= 40 ? 'med' : 'low'
    return `
    <div class="trade-item">
      <div class="trade-left">
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="trade-coin">${t.coin} ${t.direction?.toUpperCase()} ${t.leverage > 1 ? `${t.leverage}x` : ''}</div>
          <span class="conf-badge conf-badge-${confClass}">${conf}%</span>
        </div>
        <div class="conf-meter" style="width:120px;"><div class="conf-meter-fill conf-${confClass}" style="width:${conf}%"></div></div>
        <div class="trade-info">$${t.entry} → $${t.closePrice} • ${t.closeReason}</div>
        <div class="trade-info">@${t.caller}</div>
      </div>
      <div class="${t.status === 'win' ? 'trade-pnl-pos' : 'trade-pnl-neg'}">${t.pnl >= 0 ? '+' : ''}$${t.pnl}</div>
    </div>`
  }).join('')
  : '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">No trades yet</div>'

  // Leaderboard from Telegram caller stats
  // Load lessons
  const lessonsData = await ipcRenderer.invoke('get-trading-lessons')
  const lessonsList = document.getElementById('lessons-list')
  if(!lessonsList) return
  const lessons = lessonsData?.lessons || []
  if (lessons.length) {
    lessonsList.innerHTML = lessons.slice(-10).reverse().map(l => `
      <div style="padding:10px 12px;background:var(--bg3);border-radius:8px;margin-bottom:6px;border-left:3px solid ${l.won ? 'var(--green)' : 'var(--red)'};">
        <div style="font-size:12px;font-weight:600;margin-bottom:4px;">${l.won ? '✅' : '❌'} ${l.coin} ${l.direction?.toUpperCase()} — ${l.won ? '+' : ''}$${l.pnl}</div>
        <div style="font-size:12px;color:var(--text);">${l.lesson}</div>
        ${l.rule ? `<div style="font-size:11px;color:var(--accent);margin-top:4px;">📋 Rule: ${l.rule}</div>` : ''}
      </div>
    `).join('')

    // Show winning patterns
    const patterns = lessonsData?.patterns?.filter(p => p.count >= 2) || []
    if (patterns.length) {
      lessonsList.innerHTML += `<div style="margin-top:10px;font-size:11px;font-weight:600;color:var(--text2);margin-bottom:6px;">PATTERNS IDENTIFIED</div>`
      lessonsList.innerHTML += patterns.map(p => {
        const wr = Math.round(p.wins/p.count*100)
        return `<div style="font-size:11px;padding:6px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px;color:${wr >= 60 ? 'var(--green)' : 'var(--red)'};">${wr >= 60 ? '✅' : '❌'} ${p.pattern} (${wr}% — ${p.count} trades)</div>`
      }).join('')
    }
  }

  renderLeaderboard(tgStats.stats)

  // Restore new feature settings at end (safe — all elements loaded)
  try { restoreNewSettings() } catch(e) { console.error('restoreNewSettings:', e) }
}

chartAnalysisToggleEl()?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'chartAnalysis', this.classList.contains('on'))
})

// Listen for independent signal
ipcRenderer.on('independent-signal', (e, signal) => {
  // Refresh trading page if open
  const tab = document.querySelector('.page-tab[data-page="3"]')
  if (tab?.classList.contains('active')) loadTradingUI()
  // Show notification
  const notif = new Notification('🤖 Asuka Independent Signal', {
    body: `${signal.direction?.toUpperCase()} ${signal.coin} — ${signal.confidence}% confidence\n${signal.reason}`
  })
})

// Listen for paper trade closed
ipcRenderer.on('paper-trade-closed', (e, trade) => {
  const tab = document.querySelector('.page-tab[data-page="3"]')
  if (tab?.classList.contains('active')) loadTradingUI()
  new Notification(`${trade.status === 'win' ? '✅' : '❌'} Paper Trade ${trade.status?.toUpperCase()}`, {
    body: `${trade.direction?.toUpperCase()} ${trade.coin} — P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl} (${trade.closeReason})`
  })
})
ipcRenderer.on('telegram-signal', (event, signal) => {
  const tgTab = document.querySelector('.page-tab[data-page="7"]')
  if (tgTab?.classList.contains('active')) loadTelegramUI()
  // Add to intel feed
  addToIntelFeed({
    type: 'signal',
    source: `@${signal.caller} in ${signal.groupName}`,
    body: `${signal.direction?.toUpperCase()} ${signal.coin} — Entry: $${signal.entry} → Target: $${signal.target} | SL: $${signal.stopLoss}`,
    note: `${signal.confidence}% confidence${signal.chartNote ? ' · chart' : ''}`,
    action: 'Signal logged',
    notify: true
  })
})

// Buyback approve-mode: surface CA + amount so you can execute in your own wallet
ipcRenderer.on('buyback-signal', (event, sig) => {
  const ca = sig?.ca || ''
  const body = `$${sig?.symbol || '?'} · buy ~$${sig?.amount || '?'} · ${sig?.reason || ''}${ca ? '\nCA: ' + ca : ''}`
  addToIntelFeed({
    type: 'warning',
    source: 'Buyback',
    body,
    note: sig?.needsUnlock ? 'Unlock burner PIN in Auto-Desk' : 'Approve mode — execute in your wallet',
    action: ca ? 'CA ready to copy' : 'Open Auto-Desk',
    notify: true,
    ca,
  })
  try {
    new Notification('🔔 Buyback signal', { body: body.slice(0, 180) })
  } catch (_) {}
  if (ca && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(ca).catch(()=>{})
  }
  try { aldSay?.(`🔔 Buyback signal: $${sig.symbol} ~$${sig.amount}\n${sig.reason || ''}${ca ? '\nCA copied: ' + ca : ''}`) } catch (_) {}
})

// Intelligence feed
const INTEL_KEY = 'asuka_intel_feed'
function getIntelFeed() {
  try { return JSON.parse(localStorage.getItem(INTEL_KEY) || '[]') } catch(e) { return [] }
}
function addToIntelFeed(item) {
  const feed = getIntelFeed()
  feed.unshift({ ...item, time: Date.now() })
  if (feed.length > 100) feed.splice(100)
  localStorage.setItem(INTEL_KEY, JSON.stringify(feed))
  renderIntelFeed()

  // Trade notifications (signals, wins, losses)
  const tradeTypes = ['signal', 'win', 'loss']
  const tradeNotifyOn = document.getElementById('trade-notify-toggle')?.classList.contains('on')
  const intelNotifyOn = document.getElementById('intel-notify-toggle')?.classList.contains('on')

  const isTradeEvent = tradeTypes.includes(item.type)
  const shouldNotify = isTradeEvent ? tradeNotifyOn : intelNotifyOn

  if (shouldNotify && item.notify !== false) {
    ipcRenderer.send('tg-intel-notify', item)
  }
  if (shouldNotify && (item.type === 'signal' || item.type === 'warning' || item.type === 'win' || item.type === 'loss')) {
    new Notification(
      item.type === 'signal' ? '📡 New Signal' :
      item.type === 'win' ? '✅ Trade Won' :
      item.type === 'loss' ? '❌ Trade Lost' : '⚠️ Warning',
      { body: item.body }
    )
  }
}

function renderIntelFeed() {
  const feed = getIntelFeed()
  const container = document.getElementById('intel-feed')
  if (!container) return
  if (!feed.length) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text2);text-align:center;padding:20px 0;">Feed will populate as she reads groups and scans market</div>'
    return
  }
  const typeLabels = { signal:'🟢 SIGNAL', warning:'⚠️ WARNING', news:'📰 NEWS', whale:'🐋 WHALE', scan:'📊 SCAN', win:'✅ WIN', loss:'❌ LOSS', note:'💭 NOTE' }
  container.innerHTML = feed.map(item => {
    const time = new Date(item.time).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' })
    const label = typeLabels[item.type] || item.type?.toUpperCase()
    return `
    <div class="intel-item ${item.type || ''}">
      <div class="intel-header">
        <span class="intel-type intel-type-${item.type || 'note'}">${label}${item.source ? ` | ${item.source}` : ''}</span>
        <span class="intel-time">${time}</span>
      </div>
      <div class="intel-body">${item.body}</div>
      ${item.note ? `<div class="intel-note">💭 ${item.note}</div>` : ''}
      ${item.action ? `<div class="intel-action">${item.action}</div>` : ''}
    </div>`
  }).join('')
}

// Notification toggles
document.getElementById('trade-notify-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'tradeNotifications', this.classList.contains('on'))
})

document.getElementById('intel-notify-toggle')?.addEventListener('click', function() {
  this.classList.toggle('on')
  ipcRenderer.send('set-setting', 'intelNotifications', this.classList.contains('on'))
})

// Listen for intel events from main process
ipcRenderer.on('intel-event', (e, item) => addToIntelFeed(item))

// Listen for paper trade events — add to feed
ipcRenderer.on('trade-opened', (e, trade) => {
  addToIntelFeed({
    type: 'signal',
    source: `@${trade.caller}`,
    body: `${trade.direction?.toUpperCase()} ${trade.coin} ${trade.leverage > 1 ? trade.leverage + 'x' : ''} — Entry: $${trade.entry} | Target: $${trade.target} | SL: $${trade.stopLoss}`,
    note: `${trade.confidence}% confidence | Size: $${trade.size}`,
    action: 'Paper Trade Opened'
  })
})

ipcRenderer.on('paper-trade-closed', (e, trade) => {
  const isWin = trade.status === 'win'
  addToIntelFeed({
    type: isWin ? 'win' : 'loss',
    source: `@${trade.caller}`,
    body: `${trade.direction?.toUpperCase()} ${trade.coin} closed at $${trade.closePrice}`,
    note: `P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl} | ${trade.closeReason}`,
    action: isWin ? '✅ WIN' : '❌ LOSS',
    notify: true
  })
  const tab = document.querySelector('.page-tab[data-page="3"]')
  if (tab) loadTradingUI()
  new Notification(`${isWin ? '✅' : '❌'} Paper Trade ${trade.status?.toUpperCase()}`, {
    body: `${trade.direction?.toUpperCase()} ${trade.coin} — P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl} (${trade.closeReason})`
  })
})

ipcRenderer.on('independent-signal', (e, signal) => {
  addToIntelFeed({
    type: 'scan',
    source: 'Asuka Independent Scan',
    body: `${signal.direction?.toUpperCase()} ${signal.coin} — Entry: $${signal.entry} | Target: $${signal.target}`,
    note: `${signal.confidence}% confidence — ${signal.reason}`,
    action: 'Auto Paper Trade'
  })
  const tab = document.querySelector('.page-tab[data-page="3"]')
  if (tab) loadTradingUI()
})

// Also render feed when Telegram page loads
function loadIntelFeedUI() {
  renderIntelFeed()
  const settings2 = ipcRenderer.invoke('get-settings').then(s => {
    if (s?.intelNotifications) document.getElementById('intel-notify-toggle').classList.add('on')
  })
}

// ── Portfolio ──────────────────────────────────────────────────────────────
async function loadPortfolio() {
  const wallets = settings.wallets || [];
  if (!wallets.length) {
    setEl('tokens-section','innerHTML','<div class="empty-state">No wallets connected</div>')
    setEl('txns-section','innerHTML','<div class="empty-state">Connect a wallet to see transactions</div>')
    setEl('port-value','textContent','$0.00')
    return;
  }

  // Only show "Loading" on FIRST load — afterwards keep showing last data while refreshing
  if (!window._lastPortfolio) {
    setEl('tokens-section','innerHTML','<div class="empty-state">Loading...</div>')
    setEl('txns-section','innerHTML','<div class="empty-state">Loading...</div>')
  }

  let totalValue = 0;
  let allTokens = [];
  let allTxns = [];
  let anyStale = false;

  // PARALLEL fetch — 3 wallets load in the time of 1
  const results = await Promise.all(wallets.map(w =>
    ipcRenderer.invoke('get-wallet-data', w.address, w.chain)
      .then(data => ({ wallet: w, data }))
      .catch(() => ({ wallet: w, data: null }))
  ));

  for (const { wallet, data } of results) {
    if (data?.stale) anyStale = true;
    if (data?.tokens) {
      allTokens = allTokens.concat(data.tokens.map(t => ({ ...t, walletLabel: wallet.label })));
      totalValue += data.totalUsd || 0;
    }
    if (data?.txns) {
      allTxns = allTxns.concat(data.txns.map(t => ({ ...t, walletLabel: wallet.label })));
    }
  }

  // If EVERYTHING failed, keep last good snapshot instead of zeroing out
  if (!allTokens.length && window._lastPortfolio) {
    ({ totalValue, allTokens, allTxns } = window._lastPortfolio);
    anyStale = true;
  } else if (allTokens.length) {
    window._lastPortfolio = { totalValue, allTokens, allTxns };
  }

  // Update total value
  if (window.countMoney) window.countMoney(document.getElementById('port-value'), totalValue);
  else setEl('port-value','textContent',`$${totalValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  { const _e=document.getElementById('port-value'); if(_e) _e.style.opacity = anyStale ? '0.6' : '1' }
  { const _e=document.getElementById('port-value'); if(_e) _e.title = anyStale ? 'Refreshing — showing last known values' : ''; }

  // Render tokens
  if (allTokens.length) {
    setEl('tokens-section','innerHTML',allTokens.slice(0, 20).map(t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border2);">
        <div>
          <div style="font-size:13px;font-weight:600;">${t.symbol || 'Unknown'}</div>
          <div style="font-size:11px;color:var(--text2);">${t.walletLabel}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:600;">$${(t.usdValue || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
          <div style="font-size:11px;color:var(--text2);">${parseFloat(t.balance || 0).toFixed(4)} ${t.symbol}</div>
        </div>
      </div>`).join(''));
  } else {
    setEl('tokens-section','innerHTML','<div class="empty-state">No tokens found</div>')
  }

  // Render transactions
  if (allTxns.length) {
    setEl('txns-section','innerHTML',allTxns.slice(0, 20).map(t => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border2);">
        <div>
          <div style="font-size:12px;font-weight:600;">${t.type || 'Transfer'} ${t.symbol || ''}</div>
          <div style="font-size:11px;color:var(--text2);">${t.walletLabel} • ${t.date || ''}</div>
        </div>
        <div style="font-size:12px;color:${t.type === 'receive' ? 'var(--green)' : 'var(--text2)'};">
          ${t.type === 'receive' ? '+' : '-'}${parseFloat(t.amount || 0).toFixed(4)} ${t.symbol || ''}
        </div>
      </div>`).join(''));
  } else {
    setEl('txns-section','innerHTML','<div class="empty-state">No recent transactions</div>')
  }
}

// ── Edit page ──
let editModel = null
let selectedCharId = 'asuka'

function getCharCatalog() {
  return (window.AsukaCharacters && window.AsukaCharacters.CHARACTERS) || [
    { id:'asuka', name:'Asuka', emoji:'🌸', free:true, model:'./assets/model/huohuo.model3.json', previewScaleDivisor:8500, motionGroup:'idle', scale:0.07, offsetY:0 },
    { id:'alexia', name:'Alexia', emoji:'💜', free:true, model:'./assets/model/alexia/Alexia.model3.json', previewScaleDivisor:8500, motionGroup:'', scale:0.07, offsetY:28 },
  ]
}

document.getElementById('edit-btn')?.addEventListener('click',()=>{
  document.getElementById('edit-page').classList.add('open')
  buildCharRow(); initEditWaifu()
})
document.getElementById('back-from-edit')?.addEventListener('click',()=>document.getElementById('edit-page').classList.remove('open'))

function buildCharRow() {
  const row=document.getElementById('char-row')
  if(!row) return
  const chars = getCharCatalog()
  const activeId = settings.characterId || selectedCharId || 'asuka'
  row.innerHTML=chars.map((c)=>`<div class="char-card ${(!c.free || !c.model)?'locked':''} ${c.id===activeId?'active':''}" data-id="${c.id}">
    <div class="char-badge ${c.free && c.model?'free':'pro'}">${c.free && c.model?'Free':'Pro'}</div>
    <div class="char-emoji">${c.emoji}</div>
    <div class="char-name">${c.name}</div>
  </div>`).join('')
  row.querySelectorAll('.char-card:not(.locked)').forEach(card=>{
    card.addEventListener('click', async ()=>{
      row.querySelectorAll('.char-card').forEach(c=>c.classList.remove('active')); card.classList.add('active')
      const id = card.dataset.id
      selectedCharId = id
      const ch = getCharCatalog().find(x => x.id === id)
      if (!ch) return
      setEl('edit-char-name','textContent',ch.name)
      setEl('waifu-name','textContent',ch.name)
      setEl('c-name','value',ch.name)
      await applySelectedCharacter(ch)
    })
  })
}

async function applySelectedCharacter(ch) {
  try {
    const r = await ipcRenderer.invoke('set-character', { id: ch.id, name: ch.name })
    if (!r?.ok) return
    settings.characterId = r.id
    settings.characterName = r.name
    await loadPreviewModel(editApp, 'edit', r)
    reloadDashboardWaifuFrame(r)
  } catch (e) { console.error('set-character:', e) }
}

async function loadPreviewModel(app, kind, ch) {
  if (!app || !ch?.model) return
  try {
    if (!(await ensurePixiLive2D())) return
    const { Live2DModel } = PIXI.live2d
    if (kind === 'edit' && editModel) {
      try { app.stage.removeChild(editModel); editModel.destroy?.(true); } catch (_) {}
      editModel = null
    }
    const canvas = document.getElementById(kind === 'edit' ? 'edit-canvas' : 'cust-canvas')
    const w = canvas.width || 220, h = canvas.height || 360
    const m = await Live2DModel.from(ch.model)
    app.stage.addChild(m)
    m.x = w / 2
    m.y = h + (ch.offsetY || 0) * 0.35
    m.scale.set(h / (ch.previewScaleDivisor || 8500))
    m.anchor.set(0.5, 1)
    try {
      if (ch.motionGroup) m.motion(ch.motionGroup)
      else m.motion('', 0)
    } catch (_) {}
    if (kind === 'edit') editModel = m
  } catch (e) { console.error('preview model:', e) }
}

function reloadDashboardWaifuFrame(ch) {
  const f = document.getElementById('waifu-frame')
  if (!f) return
  const model = encodeURIComponent(ch?.model || './assets/model/huohuo.model3.json')
  const scale = encodeURIComponent(String(ch?.previewScaleDivisor || 8500))
  const motion = encodeURIComponent(ch?.motionGroup == null ? 'idle' : ch.motionGroup)
  const oy = encodeURIComponent(String(ch?.offsetY || 0))
  f.style.display = 'block'
  f.src = `dashboard-waifu.html?model=${model}&scaleDiv=${scale}&motion=${motion}&offsetY=${oy}&t=${Date.now()}`
  const hint = document.getElementById('waifu-load-hint')
  if (hint) hint.style.display = 'none'
}

ipcRenderer.on('character-changed', (_e, ch) => {
  if (!ch) return
  settings.characterId = ch.id
  settings.characterName = ch.name
  setEl('waifu-name','textContent', ch.name)
  setEl('edit-char-name','textContent', ch.name)
  reloadDashboardWaifuFrame(ch)
  try { refreshCustomizeForCharacter(ch) } catch (e) {}
})

async function buildCustomizeCharPicker() {
  const host = document.getElementById('customize-char-picker')
  if (!host) return
  const list = await ipcRenderer.invoke('list-characters').catch(() => null)
  const chars = (list || getCharCatalog() || []).filter(c => c.free && (c.hasModel || c.model))
  const activeId = settings.characterId || selectedCharId || 'asuka'
  host.innerHTML = chars.map(c => `
    <button type="button" class="customize-char-card${c.id === activeId ? ' active' : ''}" data-char-id="${c.id}"
      style="flex:0 0 auto;min-width:88px;padding:10px 12px;border-radius:14px;border:1px solid ${c.id===activeId?'var(--accent)':'var(--border)'};background:${c.id===activeId?'color-mix(in srgb, var(--accent) 14%, transparent)':'var(--bg2)'};cursor:pointer;text-align:center;">
      <div style="font-size:22px;line-height:1;">${c.emoji || '✨'}</div>
      <div style="font-size:11px;font-weight:700;margin-top:6px;">${c.name}</div>
      <div style="font-size:9px;color:var(--text3);margin-top:2px;">${c.id===activeId?'Active':'Tap to switch'}</div>
    </button>`).join('')
  host.querySelectorAll('[data-char-id]').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.charId
      if (!id || id === activeId) return
      btn.style.opacity = '0.6'
      const ch = chars.find(x => x.id === id) || { id, name: id }
      await applySelectedCharacter(ch)
      await refreshCustomizeForCharacter(ch)
      buildCustomizeCharPicker()
    }
  })
  setEl('customize-active-label', 'textContent', (settings.characterName || chars.find(c=>c.id===activeId)?.name || '—'))
}

async function refreshCustomizeForCharacter(ch) {
  const name = ch?.name || settings.characterName || 'Asuka'
  setEl('customize-active-label', 'textContent', name)
  setEl('customize-personality-title', 'textContent', `💬 ${name}'s personality`)
  setEl('customize-wallpaper-title', 'textContent', `🖼️ Wallpapers (behind ${name})`)
  // Reload memory after profile swap so toggles match this girl
  try {
    const mem = await ipcRenderer.invoke('get-memory').catch(() => null)
    if (mem) {
      memory = { ...memory, ...mem }
      document.querySelectorAll('[data-personality]').forEach(c =>
        c.classList.toggle('active', c.dataset.personality === (memory.personality || 'chill')))
      document.querySelectorAll('.speed-btn').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.speed) === (memory.voiceSpeed || 1)))
    }
    const prof = await ipcRenderer.invoke('get-character-profile').catch(() => null)
    if (prof?.profile?.sliders) {
      const s = prof.profile.sliders
      const tease = document.getElementById('her-teasing')
      const sweet = document.getElementById('her-sweet')
      const chatty = document.getElementById('her-chatty')
      if (tease && s.teasing != null) tease.value = s.teasing
      if (sweet && s.sweetness != null) sweet.value = s.sweetness
      if (chatty && s.chattiness != null) chatty.value = s.chattiness
    }
  } catch (e) {}
}

async function loadCustomizePage() {
  await buildCustomizeCharPicker()
  await refreshCustomizeForCharacter({
    id: settings.characterId || 'asuka',
    name: settings.characterName || 'Asuka',
  })
  try { window.loadHerTab?.() } catch (e) {}
  try { window.loadWallpapers?.() } catch (e) {}
  try { loadRules() } catch (e) {}
  try { loadRoutinesUI() } catch (e) {}
}
window.loadCustomizePage = loadCustomizePage

async function initEditWaifu() {
  try {
    if (!(await ensurePixiLive2D())) return
    const { Live2DModel } = PIXI.live2d
    const canvas=document.getElementById('edit-canvas')
    const w=220,h=360; canvas.width=w; canvas.height=h
    if (!editApp) editApp=new PIXI.Application({view:canvas,autoStart:true,transparent:true,backgroundAlpha:0,width:w,height:h})
    const ch = await ipcRenderer.invoke('get-character').catch(()=>null)
      || window.AsukaCharacters?.resolveFromSettings?.(settings)
      || getCharCatalog().find(c => c.id === 'asuka')
    selectedCharId = ch.id
    setEl('edit-char-name','textContent', ch.name || 'Asuka')
    await loadPreviewModel(editApp, 'edit', ch)
  } catch(e){ console.error('initEditWaifu:', e) }
}

// ── Customize ──
document.getElementById('customize-btn')?.addEventListener('click',()=>{
  document.getElementById('edit-page').classList.remove('open')
  document.getElementById('customize-page').classList.add('open')
  initCustWaifu(); loadCustSettings()
})
document.getElementById('back-from-customize')?.addEventListener('click',()=>document.getElementById('customize-page').classList.remove('open'))

async function initCustWaifu() {
  if (custApp) return
  try {
    if (!(await ensurePixiLive2D())) return
    const { Live2DModel } = PIXI.live2d
    const canvas=document.getElementById('cust-canvas')
    const w=220,h=360; canvas.width=w; canvas.height=h
    custApp=new PIXI.Application({view:canvas,autoStart:true,transparent:true,backgroundAlpha:0,width:w,height:h})
    const ch = await ipcRenderer.invoke('get-character').catch(()=>null) || getCharCatalog().find(c => c.id === 'asuka')
    const m=await Live2DModel.from(ch.model)
    custApp.stage.addChild(m); m.x=w/2; m.y=h+(ch.offsetY||0)*0.35; m.scale.set(h/(ch.previewScaleDivisor||8500)); m.anchor.set(0.5,1)
    try { ch.motionGroup ? m.motion(ch.motionGroup) : m.motion('', 0) } catch(_){}
  } catch(e){}
}

async function loadCustSettings() {
  if (settings.characterName) setEl('c-name','value',settings.characterName)
  if (memory.wakeName) setEl('c-wake','value',memory.wakeName)
  if (memory.voiceSpeed) { setEl('c-speed','value',memory.voiceSpeed*100); updateSpeedVal() }
  document.querySelectorAll('[data-personality]').forEach(c=>c.classList.toggle('active',c.dataset.personality===(memory.personality||'chill')))
  document.querySelectorAll('[data-level]').forEach(c=>c.classList.toggle('active',c.dataset.level===(memory.learningLevel||'intermediate')))
  document.querySelectorAll('[data-ai]').forEach(c=>c.classList.toggle('active',c.dataset.ai===(settings.aiMode||'balanced')))
}

document.querySelectorAll('[data-personality]').forEach(c=>c.addEventListener('click', async ()=>{
  document.querySelectorAll('[data-personality]').forEach(x=>x.classList.remove('active'))
  c.classList.add('active')
  // Persist for the active character only
  try {
    memory.personality = c.dataset.personality || 'chill'
    await ipcRenderer.invoke('save-memory', memory)
    ipcRenderer.send('set-setting', 'personality', memory.personality)
    await ipcRenderer.invoke('patch-character-profile', { personality: memory.personality }).catch(() => {})
  } catch (e) {}
}))
document.querySelectorAll('[data-level]').forEach(c=>c.addEventListener('click',()=>{ document.querySelectorAll('[data-level]').forEach(x=>x.classList.remove('active')); c.classList.add('active') }))
document.querySelectorAll('[data-ai]').forEach(c=>c.addEventListener('click',()=>{ document.querySelectorAll('[data-ai]').forEach(x=>x.classList.remove('active')); c.classList.add('active') }))
document.querySelectorAll('.swatch').forEach(s=>s.addEventListener('click',()=>{ document.querySelectorAll('.swatch').forEach(x=>x.classList.remove('active')); s.classList.add('active') }))
document.querySelectorAll('.item-card:not(.locked)').forEach(s=>s.addEventListener('click',()=>{
  const grp=s.closest('.item-wrap'); grp.querySelectorAll('.item-card').forEach(x=>x.classList.remove('active')); s.classList.add('active')
}))
document.getElementById('c-speed')?.addEventListener('input',updateSpeedVal)
function updateSpeedVal() { const e=document.getElementById('c-speed'); if(e) setEl('c-speed-val','textContent',(e.value/100).toFixed(1)+'×') }

document.getElementById('cust-save')?.addEventListener('click',async()=>{
  const name=document.getElementById('c-name').value||'Asuka'
  const wake=document.getElementById('c-wake').value||'asuka'
  const speed=parseInt(document.getElementById('c-speed').value)/100
  const personality=document.querySelector('[data-personality].active')?.dataset.personality||'chill'
  const level=document.querySelector('[data-level].active')?.dataset.level||'intermediate'
  const aiMode=document.querySelector('[data-ai].active')?.dataset.ai||'balanced'
  const charId = settings.characterId || selectedCharId || 'asuka'
  await ipcRenderer.invoke('set-character', { id: charId, name }).catch(()=>{})
  settings.characterName=name; settings.characterId=charId; settings.aiMode=aiMode
  memory.wakeName=wake; memory.voiceSpeed=speed; memory.personality=personality; memory.learningLevel=level
  await ipcRenderer.invoke('save-settings',settings)
  await ipcRenderer.invoke('save-memory',memory)
  await ipcRenderer.invoke('patch-character-profile', {
    displayName: name,
    wakeName: wake,
    voiceSpeed: speed,
    personality,
    learningLevel: level,
  }).catch(()=>{})
  document.getElementById('customize-page').classList.remove('open')
  setEl('waifu-name','textContent',name)
  setEl('cust-name','textContent',name)
  try { buildCustomizeCharPicker() } catch (e) {}
  const msg=`Got it! You can call me ${name} now.`
  setEl('waifu-speech','textContent',msg)
  await playAudio(await ipcRenderer.invoke('get-voice',msg))
  setEl('waifu-speech','textContent','')
})

// ── Settings ──

// ── Settings: app mode switcher ───────────────────────────────────────────
async function refreshModeDisplay() {
  const r = await ipcRenderer.invoke('get-app-mode').catch(()=>({mode:null}))
  const el = document.getElementById('s-current-mode')
  if(!el) return
  if (el) el.textContent = r.mode === 'trading' ? '📈 Trading PRO' : r.mode === 'companion' ? '🌸 Companion' : 'not chosen'
}
document.getElementById('s-mode-companion')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('set-app-mode', 'companion').catch(()=>{})
  applyMode('companion'); refreshModeDisplay()
})
document.getElementById('s-mode-trading')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('set-app-mode', 'trading').catch(()=>{})
  applyMode('trading'); refreshModeDisplay()
})

document.getElementById('s-mode-reset')?.addEventListener('click', async () => {
  await ipcRenderer.invoke('set-app-mode', 'companion').catch(()=>{}) // set then clear via picker
  // force the picker by clearing through a dedicated call
  await ipcRenderer.invoke('reset-app-mode').catch(()=>{})
  document.getElementById('mode-picker').style.display = 'flex'
})
document.getElementById('settings-open-btn')?.addEventListener('click', () => setTimeout(refreshModeDisplay, 100))

// ── Connections section ──
const ALLOC_META = { daily:['📅','Daily RSI'], main:['🎯','Main scanner'], scalp:['⚡','Scalp'], manual:['🎤','Manual'], other:['📡','Signals/Copy'] }
let _allocEdit = false
async function renderAllocations(){
  const [alloc, usage] = await Promise.all([
    ipcRenderer.invoke('get-allocations').catch(()=>null),
    ipcRenderer.invoke('get-bucket-usage').catch(()=>null)
  ])
  if (!alloc) return
  const rows = document.getElementById('alloc-rows'); if (!rows) return
  rows.innerHTML = Object.keys(ALLOC_META).map(k => {
    const [ico, name] = ALLOC_META[k]
    const b = usage?.buckets?.[k]
    const usedPct = b && b.cap > 0 ? Math.min(100, Math.round(b.used / b.cap * 100)) : 0
    const pnl = b ? (b.pnl >= 0 ? '+' : '') + '$' + b.pnl.toFixed(0) : ''
    const wr = b && (b.wins + b.losses) ? Math.round(b.wins/(b.wins+b.losses)*100) + '% WR' : ''
    const edit = _allocEdit ? `<input type="range" min="0" max="100" step="5" value="${alloc[k]}" data-alloc="${k}" style="flex:1;">
        <input type="number" min="0" max="100" value="${alloc[k]}" data-allocn="${k}" style="width:48px;padding:3px;font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:7px;color:var(--text);text-align:center;"><span style="font-size:10px;color:var(--text2);">%</span>`
      : `<span style="font-size:11px;font-weight:700;color:var(--text);">${alloc[k]}%</span>`
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border2);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
        <div style="font-size:11.5px;flex:1;white-space:nowrap;">${ico} ${name} <span style="font-size:9.5px;color:${b&&b.pnl>=0?'var(--green)':'var(--red)'};">${pnl}</span> <span style="font-size:9px;color:var(--text3);">${wr}</span></div>
        ${edit}
      </div>
      ${b ? `<div style="height:4px;background:var(--bg3);border-radius:4px;margin-top:5px;overflow:hidden;"><div style="height:100%;width:${usedPct}%;background:${usedPct>90?'var(--red)':'var(--accent)'};border-radius:4px;"></div></div>
      <div style="font-size:9px;color:var(--text3);margin-top:2px;">$${Math.round(b.used).toLocaleString()} / $${Math.round(b.cap).toLocaleString()} in use${b.openCount?` · ${b.openCount} open`:''}</div>` : ''}
    </div>`
  }).join('')
  const sync = () => {
    let sum = 0
    document.querySelectorAll('[data-allocn]').forEach(n => sum += Number(n.value)||0)
    const res = document.getElementById('alloc-reserve'); if (res) res.textContent = Math.max(0, 100 - sum) + '%'
    const w = document.getElementById('alloc-warn'); if (w) w.style.display = sum > 100 ? 'block' : 'none'
  }
  if (_allocEdit) {
    document.querySelectorAll('[data-alloc]').forEach(r => r.oninput = () => { document.querySelector(`[data-allocn="${r.dataset.alloc}"]`).value = r.value; sync() })
    document.querySelectorAll('[data-allocn]').forEach(n => n.oninput = () => { const r = document.querySelector(`[data-alloc="${n.dataset.allocn}"]`); if (r) r.value = n.value; sync() })
  }
  sync()
}
document.getElementById('alloc-edit')?.addEventListener('click', () => {
  _allocEdit = !_allocEdit
  document.getElementById('alloc-edit').textContent = _allocEdit ? 'Cancel' : 'Edit'
  document.getElementById('alloc-editbar').style.display = _allocEdit ? 'block' : 'none'
  renderAllocations()
})
document.getElementById('alloc-save')?.addEventListener('click', async () => {
  const out = {}
  document.querySelectorAll('[data-allocn]').forEach(n => out[n.dataset.allocn] = Number(n.value)||0)
  const r = await ipcRenderer.invoke('save-allocations', out).catch(()=>null)
  document.getElementById('alloc-st').textContent = r ? '✓ Saved — applies to each system\'s next entry' : 'Save failed'
  _allocEdit = false
  document.getElementById('alloc-edit').textContent = 'Edit'
  document.getElementById('alloc-editbar').style.display = 'none'
  renderAllocations()
})
try { renderAllocations() } catch(e) { console.error('alloc render:', e) }
try { setInterval(() => { try { renderAllocations() } catch(e){} }, 30000) } catch(e) {}

async function refreshConnections(){
  const st = await ipcRenderer.invoke('butler-status').catch(()=>null); if(!st) return
  const paint = (id, val) => { const el = document.getElementById(id); if(!el) return
    const ok = String(val).startsWith('connected') || val==='ready' || val==='configured'
    el.textContent = ok ? '✓ Connected' : (val==='no_permission' ? 'Needs Disk Access' : val==='not_installed' ? 'Not installed' : val==='not_configured' ? 'Not set up' : val==='qr' ? 'Scan QR' : String(val))
    el.style.color = ok ? 'var(--green)' : 'var(--gold)' }
  paint('cs-imessage', st.imessage); paint('cs-notifications', st.notifications)
  paint('cs-notes', st.notes); paint('cs-whatsapp', st.whatsapp)
  const gs = document.getElementById('conn-gmail-st'); if (gs) gs.textContent = st.gmail==='configured' ? '✓ Configured — she can check your inbox' : 'Not set up yet'
}
document.getElementById('settings-open-btn')?.addEventListener('click', () => setTimeout(refreshConnections, 150))
document.querySelectorAll('.conn-test').forEach(b => b.onclick = async () => {
  b.textContent = '…'
  const svc = b.dataset.svc
  let r = null
  if (svc==='imsg') r = await ipcRenderer.invoke('imessage-recent',{limit:3}).catch(e=>({error:e.message}))
  if (svc==='notif') r = await ipcRenderer.invoke('notifications-recent',{limit:3}).catch(e=>({error:e.message}))
  if (svc==='notes') r = await ipcRenderer.invoke('notes-list',{limit:5}).catch(e=>({error:e.message}))
  b.textContent = (r && !r.error) ? '✓' : '✗'
  setTimeout(()=>{ b.textContent='Test'; refreshConnections() }, 1600)
})
document.getElementById('conn-wa-link')?.addEventListener('click', async () => {
  document.getElementById('conn-wa-link').textContent = '…'
  await ipcRenderer.invoke('whatsapp-start').catch(()=>{})
  setTimeout(()=>{ document.getElementById('conn-wa-link').textContent = 'Link'; refreshConnections() }, 2500)
})
ipcRenderer.on('butler-wa-qr', (e, dataUrl) => {
  if (!dataUrl) return
  const box = document.getElementById('conn-wa-qr'); if (!box) return
  box.style.display = 'block'; document.getElementById('conn-wa-qr-img').src = dataUrl
})
ipcRenderer.on('butler-wa-ready', () => { const box = document.getElementById('conn-wa-qr'); if (box) box.style.display='none'; refreshConnections() })
document.getElementById('conn-gmail-save')?.addEventListener('click', async () => {
  const user = document.getElementById('conn-gmail-user').value.trim()
  const pass = document.getElementById('conn-gmail-pass').value.trim()
  if (!user || !pass) { document.getElementById('conn-gmail-st').textContent = 'Fill both fields'; return }
  const r = await ipcRenderer.invoke('butler-save-gmail', { user, pass }).catch(e=>({error:e.message}))
  document.getElementById('conn-gmail-st').textContent = r?.ok ? '✓ Saved — restart the app to apply' : 'Save failed: ' + (r?.error||'unknown')
})
document.getElementById('conn-open-fda')?.addEventListener('click', () => {
  ipcRenderer.invoke('open-url', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles').catch(()=>{})
})

async function populateSettingsForm() {
  try {
    if (!window._cachedSettings || !Object.keys(window._cachedSettings).length) {
      settings = await ipcRenderer.invoke('get-settings').catch(() => ({})) || {}
      window._cachedSettings = settings
    }
    if (!window._cachedMemory || !Object.keys(window._cachedMemory).length) {
      memory = await ipcRenderer.invoke('get-memory').catch(() => ({})) || {}
      window._cachedMemory = memory
    }
  } catch (e) {}
  const s = window._cachedSettings || settings || {}
  const mem = window._cachedMemory || memory || {}
  if (s.coingeckoKey) setEl('s-coingecko','value',s.coingeckoKey)
  if (s.moralisKey)   setEl('s-moralis','value',s.moralisKey)
  if (s.youtubeKey)   setEl('s-youtube','value',s.youtubeKey)
  if (s.etherscanKey) setEl('s-etherscan','value',s.etherscanKey)
  if (s.binanceKey)   setEl('s-binance-key','value',s.binanceKey)
  if (s.binanceSecret) setEl('s-binance-secret','value',s.binanceSecret)
  if (s.bybitKey)     setEl('s-bybit-key','value',s.bybitKey)
  if (s.binanceKey && s.binanceSecret) {
    const st = document.getElementById('binance-conn-status')
    if (st) { st.textContent = 'Saved — click to re-test'; st.style.color = 'var(--text2)' }
  }
  if (mem.alarmTime)  setEl('s-alarm','value',mem.alarmTime)
  if (mem.sleepHour)  setEl('s-sleep','value',mem.sleepHour)
  if (mem.waterReminderMinutes) setEl('s-water','value',mem.waterReminderMinutes)
}
window.populateSettingsForm = populateSettingsForm

document.getElementById('settings-open-btn')?.addEventListener('click',()=>{
  document.getElementById('settings-page').classList.add('open')
  populateSettingsForm().catch(() => {})
})

document.getElementById('back-from-settings')?.addEventListener('click',()=>{
  document.getElementById('settings-page').classList.remove('open')
  // Restore the active page properly
  const activeTab = document.querySelector('.page-tab.active')
  const pageNum = activeTab ? parseInt(activeTab.dataset.page) : 1
  const pageId = PAGE_IDS?.[pageNum] || ('page-' + pageNum)
  const pageEl = document.getElementById(pageId) || document.getElementById('page-1')
  if (pageEl) {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none')
    pageEl.style.display = 'flex'
  }
})
document.getElementById('settings-save-btn')?.addEventListener('click',async()=>{
  settings.coingeckoKey=document.getElementById('s-coingecko').value
  settings.moralisKey=document.getElementById('s-moralis').value
  settings.youtubeKey=document.getElementById('s-youtube').value
  settings.etherscanKey=document.getElementById('s-etherscan').value
  settings.binanceKey=document.getElementById('s-binance-key').value
  settings.binanceSecret=document.getElementById('s-binance-secret').value
  settings.bybitKey=document.getElementById('s-bybit-key').value
  memory.alarmTime=document.getElementById('s-alarm').value
  memory.sleepHour=parseInt(document.getElementById('s-sleep').value)||null
  memory.waterReminderMinutes=parseInt(document.getElementById('s-water').value)||null
  await ipcRenderer.invoke('save-settings',settings)
  await ipcRenderer.invoke('save-memory',memory)
  document.getElementById('settings-page').classList.remove('open')
  const msg='Settings saved!'
  setEl('waifu-speech','textContent',msg)
  await playAudio(await ipcRenderer.invoke('get-voice',msg))
  setEl('waifu-speech','textContent','')
})
document.getElementById('binance-connect-btn')?.addEventListener('click', async () => {
  const st = document.getElementById('binance-conn-status')
  const key = document.getElementById('s-binance-key').value.trim()
  const sec = document.getElementById('s-binance-secret').value.trim()
  if (!key || !sec) { st.textContent = 'Enter key + secret first'; st.style.color = 'var(--gold)'; return }
  st.textContent = 'Saving & testing…'; st.style.color = 'var(--text2)'
  // save first so the backend can read them
  settings.binanceKey = key; settings.binanceSecret = sec
  await ipcRenderer.invoke('save-settings', settings).catch(()=>{})
  const r = await ipcRenderer.invoke('test-binance').catch(e => ({ ok:false, error:e.message }))
  if (r && r.ok) {
    if (r.canWithdraw) { st.innerHTML = '⚠️ Connected — but this key CAN WITHDRAW. Make a new key with withdrawals off.'; st.style.color = 'var(--red)' }
    else { st.innerHTML = '✓ Connected' + (r.balance!=null ? ' · $'+r.balance.toLocaleString(undefined,{maximumFractionDigits:2}) : '') + ' · withdrawal-safe'; st.style.color = 'var(--green)' }
  } else { st.textContent = '✗ ' + (r?.error || 'Connection failed'); st.style.color = 'var(--red)' }
})
document.getElementById('export-btn')?.addEventListener('click',()=>ipcRenderer.invoke('export-data'))

// ── Dev Controls in Settings ──────────────────────────────────────────────
let _devToken = localStorage.getItem('dev_token') || ''

function devApiCall(action, extra = {}) {
  return fetch('http://localhost:3001/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _devToken },
    body: JSON.stringify({ action, ...extra })
  }).catch(() => null)
}

document.getElementById('dev-unlock-btn')?.addEventListener('click', async () => {
  const pwd = document.getElementById('settings-dev-pwd-input')?.value?.trim()
  const err = document.getElementById('dev-unlock-err')
  if (!pwd) return

  const unlock = (token) => {
    _devToken = token
    localStorage.setItem('dev_token', token)
    document.getElementById('dev-lock-state').style.display = 'none'
    document.getElementById('dev-unlocked-state').style.display = 'block'
    if (err) err.textContent = ''
  }

  const ipcRes = await ipcRenderer.invoke('dev-verify-password', pwd).catch(() => null)
  if (ipcRes === true || ipcRes?.ok === true) { unlock('ipc-ok'); return }

  try {
    const res = await fetch('http://127.0.0.1:3001/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd })
    })
    const data = await res.json()
    if (data.success && data.token) { unlock(data.token); return }
    if (err) err.textContent = '❌ ' + (data.error || 'Wrong password')
  } catch (e2) {
    if (err) err.textContent = ipcRes?.error === 'not_configured'
      ? '❌ Set DEV_PANEL_PASSWORD or unlock via http://127.0.0.1:3001 (check terminal for generated password)'
      : '❌ Wrong password or dev panel not running'
  }
})

document.getElementById('dev-lock-again-btn')?.addEventListener('click', () => {
  localStorage.removeItem('dev_token')
  _devToken = ''
  document.getElementById('dev-lock-state').style.display = 'block'
  document.getElementById('dev-unlocked-state').style.display = 'none'
  const devPwdEl = document.getElementById('settings-dev-pwd-input'); if(devPwdEl) devPwdEl.value = ''
})

document.getElementById('dev-pause-all-btn')?.addEventListener('click', () => devApiCall('pauseAll'))
document.getElementById('dev-resume-all-btn')?.addEventListener('click', () => devApiCall('resumeAll'))

document.querySelectorAll('.dev-coin-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.dev-coin-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    devApiCall('setCoinOverride', { value: this.dataset.val })
  })
})

document.querySelectorAll('.dev-interval-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.dev-interval-btn').forEach(b => b.classList.remove('active'))
    this.classList.add('active')
    devApiCall('setInterval', { value: parseInt(this.dataset.val) || null })
  })
})

document.getElementById('dev-save-pwd-btn')?.addEventListener('click', async () => {
  const pwd = document.getElementById('dev-new-pwd')?.value
  if (!pwd || pwd.length < 8) return
  const ok = await ipcRenderer.invoke('dev-change-password', pwd).catch(() => false)
  await devApiCall('changePassword', { value: pwd })
  if (ok) {
    setEl('dev-new-pwd','value','')
    alert('Password changed!')
  } else {
    alert('Password not saved (min 8 chars; cannot use the old default)')
  }
})

// Auto-unlock if token saved
if (_devToken) {
  fetch('http://localhost:3001/api/stats', { headers: { Authorization: 'Bearer ' + _devToken } })
    .then(r => {
      if (r.ok) {
        document.getElementById('dev-lock-state').style.display = 'none'
        document.getElementById('dev-unlocked-state').style.display = 'block'
      }
    }).catch(() => {})
}
document.getElementById('import-btn')?.addEventListener('click',()=>{
  const inp=document.createElement('input'); inp.type='file'; inp.accept='.json'
  inp.onchange=async e=>{
    const txt=await e.target.files[0].text()
    const result=await ipcRenderer.invoke('restore-backup',txt)
    setEl('waifu-speech','textContent',result)
    await playAudio(await ipcRenderer.invoke('get-voice',result))
    setEl('waifu-speech','textContent','')
  }; inp.click()
})

// ── Close ──
document.getElementById('close-btn')?.addEventListener('click',()=>{ ipcRenderer.send('dashboard-closed'); window.close() })

// ── Auto refresh ──
setInterval(loadPrices, 30000)

// ── Init ──

// ── App mode picker (first launch) ────────────────────────────────────────
async function initAppMode() {
  try {
    const r = await ipcRenderer.invoke('get-app-mode').catch(()=>({mode:null}))
    if (!r.mode) {
      document.getElementById('mode-picker').style.display = 'flex'
    } else {
      applyMode(r.mode)
    }
  } catch(e) {}
}
async function loadWebsitePage() {
  try {
    const r = await ipcRenderer.invoke('get-app-mode').catch(() => ({ mode: 'companion' }))
    applyMode(r?.mode || 'companion')
  } catch (e) {}
}

function applyMode(mode) {
  const companion = (mode === 'companion')
  const tgTab = document.querySelector('.page-tab[data-page="7"]')
  const tradingTab = document.querySelector('.page-tab[data-page="3"]')
  const webTab = document.getElementById('website-tab')
  if (tgTab) tgTab.style.display = companion ? 'none' : ''
  if (tradingTab) tradingTab.style.display = companion ? 'none' : ''
  if (webTab) webTab.style.display = companion ? '' : 'none'
  const wiz = document.getElementById('website-wizard-section')
  if (wiz) {
    if (companion) {
      const host = document.getElementById('website-page-host')
      if (host && wiz.parentElement !== host) host.appendChild(wiz)
    } else {
      const launch = document.getElementById('tab-launch')
      if (launch && wiz.parentElement !== launch) launch.insertBefore(wiz, launch.firstChild)
    }
  }
  if (companion) {
    const active = document.querySelector('.page-tab.active')
    if (active && ['2','3'].includes(active.dataset.page)) {
      navigateToPage(1)
    }
  }
  requestAnimationFrame(() => {
    if (typeof window.moveTabGlider === 'function') window.moveTabGlider()
  })
}
document.querySelectorAll('.mode-card').forEach(c => {
  c.addEventListener('mouseover', () => c.style.transform = 'translateY(-4px)')
  c.addEventListener('mouseout', () => c.style.transform = 'translateY(0)')
  c.addEventListener('click', async () => {
    const mode = c.dataset.mode
    await ipcRenderer.invoke('set-app-mode', mode).catch(()=>{})
    document.getElementById('mode-picker').style.display = 'none'
    applyMode(mode)
  })
})

function dashAppFinishBoot() {
  setTimeout(initAppMode, 300)
  localStorage.setItem('asuka-model', '2d')
  ipcRenderer.invoke('close-3d').catch(() => {})
  restoreVoiceSettings().catch(() => {})
  if (document.getElementById('settings-page')?.classList.contains('open')) populateSettingsForm().catch(() => {})
  if (document.getElementById('connect-modal')?.style.display === 'flex') refreshConnStatus()
  setTimeout(() => { try { loadPage1() } catch(e) {} }, 200)
  setTimeout(() => { try { initDots() } catch(e) {} }, 400)
  setTimeout(() => loadData().catch(e => console.error('loadData error:', e)), 3000)
  setInterval(() => { try { loadPage1() } catch(e) {} }, 30000)
}
window.dashAppFinishBoot = dashAppFinishBoot
