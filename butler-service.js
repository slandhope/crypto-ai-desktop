// ═══════════════════════════════════════════════════════════════════
// 🤵 BUTLER SERVICE — iMessage, macOS Notifications, Apple Notes, WhatsApp
// Registered from main.js:  require('./butler-service')(ipcMain)
// All local/on-device. iMessage + Notifications need Full Disk Access.
// WhatsApp needs:  npm install whatsapp-web.js qrcode
// ═══════════════════════════════════════════════════════════════════
const { execFile, exec } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const HOME = os.homedir();
const CHAT_DB = path.join(HOME, 'Library', 'Messages', 'chat.db');
const NOTIF_DB = path.join(HOME, 'Library', 'Group Containers', 'group.com.apple.usernoted', 'db2', 'db');

function sql(db, query) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-json', '-readonly', db, query], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(out.trim() ? JSON.parse(out) : []); } catch (e) { reject(e); }
    });
  });
}

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { maxBuffer: 4 * 1024 * 1024 }, (err, out, errout) => {
      if (err) return reject(new Error(errout || err.message));
      resolve(out.trim());
    });
  });
}

// Apple epoch (2001-01-01) → JS date; handles both seconds and nanoseconds storage
function appleDate(v) {
  if (!v) return null;
  let secs = Number(v);
  if (secs > 1e12) secs = secs / 1e9; // modern macOS stores ns
  return new Date((secs + 978307200) * 1000);
}

// ── iMessage / SMS ─────────────────────────────────────────────────
async function imessageRecent(limit = 15) {
  if (!fs.existsSync(CHAT_DB)) return { error: 'no_db' };
  try {
    const rows = await sql(CHAT_DB, `
      SELECT m.ROWID as id, m.text, m.date, m.is_from_me,
             h.id as handle,
             (SELECT c.display_name FROM chat c
                JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
               WHERE cmj.message_id = m.ROWID LIMIT 1) as chat_name
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.text IS NOT NULL AND m.text != ''
      ORDER BY m.date DESC LIMIT ${Math.min(50, limit)}`);
    return {
      messages: rows.map(r => ({
        id: r.id,
        from: r.is_from_me ? 'me' : (r.chat_name || r.handle || 'unknown'),
        handle: r.handle || '',
        text: String(r.text).slice(0, 500),
        when: appleDate(r.date)?.toLocaleString() || '',
        fromMe: !!r.is_from_me,
      })),
    };
  } catch (e) {
    if (/unable to open|authorization|SQLITE_CANTOPEN/i.test(e.message)) return { error: 'no_permission' };
    return { error: e.message };
  }
}

async function imessageUnreadCount() {
  if (!fs.existsSync(CHAT_DB)) return { error: 'no_db' };
  try {
    const rows = await sql(CHAT_DB, `SELECT COUNT(*) as c FROM message WHERE is_read = 0 AND is_from_me = 0 AND text IS NOT NULL`);
    return { unread: rows[0]?.c ?? 0 };
  } catch (e) {
    if (/unable to open|authorization|SQLITE_CANTOPEN/i.test(e.message)) return { error: 'no_permission' };
    return { error: e.message };
  }
}

async function imessageSend(to, text) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "${esc(to)}" of targetService
    send "${esc(text)}" to targetBuddy
  end tell`;
  try { await osascript(script); return { ok: true }; }
  catch (e) {
    // fallback: SMS via any service
    try {
      await osascript(`tell application "Messages" to send "${esc(text)}" to participant "${esc(to)}"`);
      return { ok: true };
    } catch (e2) { return { error: e2.message }; }
  }
}

// ── macOS Notification Center ──────────────────────────────────────
function extractStringsFromPlistBlob(buf) {
  // best-effort: pull readable UTF-8 runs out of the binary plist
  const out = [];
  let cur = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x20 && b < 0x7f) cur.push(b);
    else { if (cur.length >= 4) out.push(Buffer.from(cur).toString('utf8')); cur = []; }
  }
  if (cur.length >= 4) out.push(Buffer.from(cur).toString('utf8'));
  // filter plist keywords / junk
  return out.filter(s => !/^(bplist|NS\.|\$|X\$|T\$|_|Root|Objects|titl$|body$|app$|req$|date$|iden$)/.test(s) && s.length > 2).slice(0, 6);
}

async function notificationsRecent(limit = 20) {
  if (!fs.existsSync(NOTIF_DB)) return { error: 'no_db' };
  try {
    const rows = await sql(NOTIF_DB, `
      SELECT hex(rec.data) as hexdata, rec.delivered_date,
             (SELECT identifier FROM app WHERE app.app_id = rec.app_id) as app
      FROM record rec ORDER BY rec.delivered_date DESC LIMIT ${Math.min(40, limit)}`);
    return {
      notifications: rows.map(r => ({
        app: (r.app || 'unknown').replace(/^com\.[^.]+\./, ''),
        when: appleDate(r.delivered_date)?.toLocaleString() || '',
        snippets: extractStringsFromPlistBlob(Buffer.from(r.hexdata || '', 'hex')),
      })),
    };
  } catch (e) {
    if (/unable to open|authorization|SQLITE_CANTOPEN/i.test(e.message)) return { error: 'no_permission' };
    return { error: e.message };
  }
}

// ── Apple Notes ────────────────────────────────────────────────────
async function notesList(limit = 20) {
  try {
    const out = await osascript(`set o to ""
      tell application "Notes"
        set ns to notes of default account
        set n to count of ns
        repeat with i from 1 to (n)
          if i > ${Math.min(50, limit)} then exit repeat
          set o to o & (name of item i of ns) & "|||" & (modification date of item i of ns as string) & "@@@"
        end repeat
      end tell
      return o`);
    const items = out.split('@@@').filter(Boolean).map(s => {
      const [title, mod] = s.split('|||');
      return { title: (title || '').trim(), modified: (mod || '').trim() };
    });
    return { notes: items };
  } catch (e) { return { error: e.message }; }
}

async function noteRead(titleQuery) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    const out = await osascript(`tell application "Notes"
      set matches to (notes of default account whose name contains "${esc(titleQuery)}")
      if (count of matches) = 0 then return "NOT_FOUND"
      set n to item 1 of matches
      return (name of n) & "|||" & (body of n)
    end tell`);
    if (out === 'NOT_FOUND') return { error: 'not_found' };
    const [title, ...rest] = out.split('|||');
    const html = rest.join('|||');
    const text = html.replace(/<br[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    return { title: title.trim(), text: text.slice(0, 4000) };
  } catch (e) { return { error: e.message }; }
}

async function noteCreate(title, body) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '<br>');
  try {
    await osascript(`tell application "Notes" to make new note at default account with properties {name:"${esc(title)}", body:"${esc(title)}<br><br>${esc(body)}"}`);
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}

// ── WhatsApp (whatsapp-web.js — optional dependency) ───────────────
let waClient = null, waStatus = 'off', waQR = null;

async function whatsappStart(sendToWindow) {
  if (waClient) return { status: waStatus };
  let WWebJS, qrcode;
  try { WWebJS = require('whatsapp-web.js'); qrcode = require('qrcode'); }
  catch (e) { waStatus = 'not_installed'; return { error: 'not_installed' }; }
  const { Client, LocalAuth } = WWebJS;
  waStatus = 'starting';
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(HOME, '.asuka-wa') }),
    puppeteer: { headless: true, args: ['--no-sandbox'] },
  });
  waClient.on('qr', async (qr) => {
    waStatus = 'qr';
    try { waQR = await qrcode.toDataURL(qr); } catch (_) { waQR = null; }
    if (sendToWindow) sendToWindow('butler-wa-qr', waQR);
  });
  waClient.on('ready', () => { waStatus = 'ready'; waQR = null; if (sendToWindow) sendToWindow('butler-wa-ready'); });
  waClient.on('disconnected', () => { waStatus = 'off'; waClient = null; });
  waClient.initialize().catch((e) => { waStatus = 'error:' + e.message; });
  return { status: waStatus };
}

async function whatsappRecent(limit = 10) {
  if (!waClient || waStatus !== 'ready') return { error: waStatus === 'qr' ? 'scan_qr' : 'not_connected' };
  try {
    const chats = await waClient.getChats();
    const top = chats.slice(0, Math.min(15, limit));
    const out = [];
    for (const c of top) {
      const last = c.lastMessage;
      out.push({
        chat: c.name || c.id.user,
        unread: c.unreadCount || 0,
        last: last ? String(last.body || '[media]').slice(0, 300) : '',
        fromMe: last ? !!last.fromMe : false,
      });
    }
    return { chats: out };
  } catch (e) { return { error: e.message }; }
}

async function whatsappSend(to, text) {
  if (!waClient || waStatus !== 'ready') return { error: 'not_connected' };
  try {
    const chats = await waClient.getChats();
    const target = chats.find(c => (c.name || '').toLowerCase().includes(String(to).toLowerCase()));
    if (!target) return { error: 'chat_not_found' };
    await target.sendMessage(text);
    return { ok: true, chat: target.name };
  } catch (e) { return { error: e.message }; }
}

// ── Apple Calendar ─────────────────────────────────────────────────
async function calendarToday(days = 1) {
  try {
    const out = await osascript(`set o to ""
      set startDate to current date
      set time of startDate to 0
      set endDate to startDate + (${Math.min(14, Math.max(1, days))} * days)
      tell application "Calendar"
        repeat with cal in calendars
          repeat with ev in (every event of cal whose start date ≥ startDate and start date < endDate)
            set o to o & (summary of ev) & "|||" & (start date of ev as string) & "|||" & (location of ev as string) & "@@@"
          end repeat
        end repeat
      end tell
      return o`);
    const events = out.split('@@@').filter(Boolean).map(s => {
      const [title, start, location] = s.split('|||');
      return { title: (title||'').trim(), start: (start||'').trim(), location: (location||'missing value').trim().replace('missing value','') };
    }).sort((a,b) => a.start.localeCompare(b.start)).slice(0, 20);
    return { events };
  } catch (e) { return { error: e.message }; }
}

// ── Morning ritual: one combined briefing ──────────────────────────
async function morningRitual() {
  const parts = [];
  try { const m = await imessageUnreadCount(); if (!m.error) parts.push(m.unread ? `${m.unread} unread text${m.unread>1?'s':''}` : 'no unread texts'); } catch(_){}
  try {
    const msgs = await imessageRecent(5);
    if (msgs.messages) { const inc = msgs.messages.filter(x => !x.fromMe).slice(0,3);
      if (inc.length) parts.push('latest from ' + inc.map(x => `${x.from}: "${x.text.slice(0,60)}"`).join('; ')); }
  } catch(_){}
  try {
    const n = await notificationsRecent(6);
    if (n.notifications?.length) { const apps = [...new Set(n.notifications.map(x=>x.app))].slice(0,4);
      parts.push('overnight pings from ' + apps.join(', ')); }
  } catch(_){}
  try {
    const c = await calendarToday(1);
    if (c.events) parts.push(c.events.length ? ('today: ' + c.events.slice(0,4).map(ev => `${ev.title} at ${ev.start.replace(/^[A-Za-z]+, /,'').replace(/:\d\d [A-Z]+.*$/,'')}`).join('; ')) : 'calendar is clear today');
  } catch(_){}
  return { briefing: parts.length ? parts.join('. ') + '.' : 'All quiet — no texts, pings, or events. Fresh start.' };
}

// ── Connection status for the Butler panel ─────────────────────────
async function butlerStatus() {
  const st = { imessage: 'off', notifications: 'off', notes: 'off', whatsapp: waStatus, gmail: 'unknown' };
  try { const r = await imessageUnreadCount(); st.imessage = r.error ? r.error : 'connected'; } catch (e) { st.imessage = 'error'; }
  try { const r = await notificationsRecent(1); st.notifications = r.error ? r.error : 'connected'; } catch (e) { st.notifications = 'error'; }
  try { const r = await osascript('tell application "Notes" to return count of notes of default account'); st.notes = 'connected (' + r + ' notes)'; } catch (e) { st.notes = 'no_permission'; }
  try { st.gmail = (process.env.GMAIL_USER || process.env.GMAIL_EMAIL) ? 'configured' : 'not_configured'; } catch (_) {}
  return st;
}

// ── Register everything ────────────────────────────────────────────
module.exports = function registerButler(ipcMain, getMainWindow) {
  const sendToWindow = (ch, ...args) => {
    try { const w = getMainWindow && getMainWindow(); if (w && !w.isDestroyed()) w.webContents.send(ch, ...args); } catch (_) {}
  };
  const sec = require('./security-hardening');
  ipcMain.handle('butler-status', () => butlerStatus());
  ipcMain.handle('butler-save-gmail', (e, { user, pass }) => {
    // Never write Gmail secrets into plaintext .env — OS keychain via safeStorage
    try { return sec.saveGmailCreds(user, pass); }
    catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('imessage-recent', (e, { limit } = {}) => imessageRecent(limit));
  ipcMain.handle('imessage-unread', () => imessageUnreadCount());
  ipcMain.handle('imessage-send', async (e, { to, text }) => {
    const broker = require('./tool-broker');
    const gate = await broker.requestTool('imessage-send', {
      title: 'Send iMessage?',
      detail: `To: ${String(to || '').slice(0, 60)}\n"${String(text || '').slice(0, 160)}"`,
      danger: true,
    });
    if (!gate.allowed) return { cancelled: true, error: gate.error || 'cancelled' };
    return imessageSend(to, text);
  });
  ipcMain.handle('notifications-recent', (e, { limit } = {}) => notificationsRecent(limit));
  ipcMain.handle('notes-list', (e, { limit } = {}) => notesList(limit));
  ipcMain.handle('note-read', (e, { title }) => noteRead(title));
  ipcMain.handle('note-create', async (e, { title, body }) => {
    const broker = require('./tool-broker');
    const gate = await broker.requestTool('note-create', {
      title: 'Create Apple Note?',
      detail: `Title: ${String(title || '').slice(0, 80)}`,
      danger: false,
    });
    if (!gate.allowed) return { cancelled: true, error: gate.error || 'cancelled' };
    return noteCreate(title, body);
  });
  ipcMain.handle('whatsapp-start', () => whatsappStart(sendToWindow));
  ipcMain.handle('whatsapp-recent', (e, { limit } = {}) => whatsappRecent(limit));
  ipcMain.handle('whatsapp-send', async (e, { to, text }) => {
    const broker = require('./tool-broker');
    const gate = await broker.requestTool('whatsapp-send', {
      title: 'Send WhatsApp?',
      detail: `To: ${String(to || '').slice(0, 60)}\n"${String(text || '').slice(0, 160)}"`,
      danger: true,
    });
    if (!gate.allowed) return { cancelled: true, error: gate.error || 'cancelled' };
    return whatsappSend(to, text);
  });
  ipcMain.handle('calendar-today', (e, { days } = {}) => calendarToday(days));
  ipcMain.handle('morning-ritual', () => morningRitual());
  console.log('Butler service registered (send actions via tool-broker)');
};
