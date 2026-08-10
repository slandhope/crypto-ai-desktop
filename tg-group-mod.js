'use strict';
/**
 * Telegram group presence / human-like mod.
 *
 * Modes:
 *   silent — anti-spam + joins only (almost never chats)
 *   light  — welcomes, @mentions, questions, rare hype (default)
 *   full   — more chatty within hard rate limits
 *
 * Safety defaults (intentionally conservative):
 *   - kick/ban NEVER auto (only via owner/UI/confirm path)
 *   - spam: delete + optional timed mute only
 *   - never invent live trade results / guaranteed profits
 *   - hard hourly + cooldown caps even in full mode
 */

const DEFAULTS = {
  enabled: true,
  mode: 'light', // silent | light | full
  maxRepliesPerHour: 8,
  maxRepliesPerHourFull: 18,
  cooldownSec: 50,
  quietStartHourUtc: 1,
  quietEndHourUtc: 8,
  autoSpam: true,
  autoMuteOnSpam: true,
  autoMuteSpamHours: 6,
  welcomeEnabled: true,
  hypeEnabled: true,
  hypeIntervalHours: 6,
  replyToQuestions: true,
  // empty = all discovered/managed groups
  allowlistChatIds: [],
};

const SPAM_RE = new RegExp(
  [
    'seed\\s*phrase',
    'private\\s*key',
    'double\\s*your\\s*(eth|btc|usdt|money)',
    'send\\s*(me\\s*)?(eth|btc|usdt|sol)\\s*(to|and)',
    'claim\\s*(your\\s*)?(airdrop|reward|free)\\b',
    'connect\\s*(your\\s*)?wallet\\s*(now|here|to\\s*claim)',
    'guaranteed\\s*(\\d+%|profit|returns)',
    'admin\\s*(will\\s*)?(never\\s*)?dm',
    'you\\s*have\\s*been\\s*selected',
    'verification\\s*required.*wallet',
  ].join('|'),
  'i'
);

const URL_RE = /https?:\/\/\S+/gi;
const CA_RE = /\b0x[a-fA-F0-9]{40}\b/;
const MENTION_BOT_RE = /@asuka|hey asuka|hi asuka|asuka\b/i;

function mergeConfig(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!['silent', 'light', 'full'].includes(c.mode)) c.mode = 'light';
  c.maxRepliesPerHour = clampInt(c.maxRepliesPerHour, 1, 30, 8);
  c.maxRepliesPerHourFull = clampInt(c.maxRepliesPerHourFull, 1, 40, 18);
  c.cooldownSec = clampInt(c.cooldownSec, 15, 600, 50);
  c.autoMuteSpamHours = clampInt(c.autoMuteSpamHours, 1, 168, 6);
  c.hypeIntervalHours = clampInt(c.hypeIntervalHours, 2, 48, 6);
  return c;
}

function clampInt(v, min, max, d) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return d;
  return Math.min(max, Math.max(min, n));
}

function hourUtc() {
  return new Date().getUTCHours();
}

function inQuietHours(cfg) {
  const h = hourUtc();
  const a = cfg.quietStartHourUtc;
  const b = cfg.quietEndHourUtc;
  if (a === b) return false;
  if (a < b) return h >= a && h < b;
  return h >= a || h < b; // wraps midnight
}

function maxReplies(cfg) {
  if (cfg.mode === 'silent') return 0;
  if (cfg.mode === 'full') return cfg.maxRepliesPerHourFull;
  return cfg.maxRepliesPerHour;
}

/** Per-process rate state (not secrets — fine in memory). */
function createModRuntime() {
  return {
    replyLog: new Map(), // chatId -> [timestamps]
    lastReplyAt: new Map(),
    flood: new Map(), // `${chatId}:${userId}` -> [timestamps]
    hypeLastAt: new Map(),
    processedMsgIds: new Set(),
    botUsername: null,
  };
}

function pruneTimestamps(arr, windowMs) {
  const cut = Date.now() - windowMs;
  return (arr || []).filter((t) => t > cut);
}

function canReply(rt, chatId, cfg) {
  if (cfg.mode === 'silent') return { ok: false, reason: 'silent' };
  if (inQuietHours(cfg)) return { ok: false, reason: 'quiet_hours' };
  const hourCap = maxReplies(cfg);
  if (hourCap <= 0) return { ok: false, reason: 'cap_zero' };
  const key = String(chatId);
  const recent = pruneTimestamps(rt.replyLog.get(key), 60 * 60 * 1000);
  rt.replyLog.set(key, recent);
  if (recent.length >= hourCap) return { ok: false, reason: 'hourly_cap' };
  const last = rt.lastReplyAt.get(key) || 0;
  if (Date.now() - last < cfg.cooldownSec * 1000) return { ok: false, reason: 'cooldown' };
  return { ok: true };
}

function markReply(rt, chatId) {
  const key = String(chatId);
  const recent = pruneTimestamps(rt.replyLog.get(key), 60 * 60 * 1000);
  recent.push(Date.now());
  rt.replyLog.set(key, recent);
  rt.lastReplyAt.set(key, Date.now());
}

function trackFlood(rt, chatId, userId) {
  const key = `${chatId}:${userId}`;
  const recent = pruneTimestamps(rt.flood.get(key), 30 * 1000);
  recent.push(Date.now());
  rt.flood.set(key, recent);
  return recent.length;
}

function chatAllowed(cfg, chatId) {
  const list = cfg.allowlistChatIds || [];
  if (!list.length) return true;
  return list.map(String).includes(String(chatId));
}

function classifyMessage({ text, from, chat, isNewMember, botUsername, cfg }) {
  if (from?.is_bot) return { kind: 'ignore', reason: 'bot' };
  if (isNewMember) return { kind: 'welcome' };

  const raw = String(text || '');
  const lower = raw.toLowerCase();
  if (!raw && !isNewMember) return { kind: 'ignore', reason: 'empty' };

  // High-precision spam
  const urls = raw.match(URL_RE) || [];
  const floodish = false; // filled by caller with flood count
  if (SPAM_RE.test(raw)) return { kind: 'spam', reason: 'pattern', confidence: 0.95 };
  if (urls.length >= 2 && (CA_RE.test(raw) || /airdrop|claim|whitelist|mint/i.test(raw))) {
    return { kind: 'spam', reason: 'link_flood', confidence: 0.9 };
  }
  if (urls.length >= 1 && /dm\s*me|write\s*me|admin\s*in\s*dm/i.test(raw)) {
    return { kind: 'spam', reason: 'dm_scam', confidence: 0.92 };
  }

  const uname = (botUsername || '').replace(/^@/, '');
  const mentioned =
    (uname && new RegExp(`@${uname}\\b`, 'i').test(raw)) ||
    MENTION_BOT_RE.test(raw);

  if (mentioned) return { kind: 'mention', reason: 'named' };

  const isQuestion =
    /\?/.test(raw) ||
    /^(what|when|where|why|how|who|is|are|can|does|do|will|should)\b/i.test(raw.trim());

  if (cfg.replyToQuestions && isQuestion && raw.length > 12 && raw.length < 280) {
    return { kind: 'question', reason: 'question' };
  }

  // Light hype cues — only for full/light occasional engagement (decision later)
  if (/\b(wen|lfg|gm+|gn+|wagmi|pump|mooning|let'?s\s*go+)\b/i.test(lower) && raw.length < 80) {
    return { kind: 'vibe', reason: 'hype_cue' };
  }

  if (/^(hi|hello|hey|yo|sup|gm|gn)\b/i.test(raw.trim()) && raw.length < 40) {
    return { kind: 'vibe', reason: 'greeting' };
  }

  return { kind: 'ignore', reason: 'no_trigger', floodish };
}

function shouldEngage(kind, cfg, rng = Math.random) {
  if (kind === 'spam' || kind === 'welcome' || kind === 'mention') return true;
  if (cfg.mode === 'silent') return false;
  if (kind === 'question') return cfg.mode !== 'silent';
  if (kind === 'vibe') {
    if (cfg.mode === 'full') return rng() < 0.35;
    if (cfg.mode === 'light') return rng() < 0.12;
    return false;
  }
  if (cfg.mode === 'full' && kind === 'ignore') return false; // still don't reply to everything
  return false;
}

const REPLY_SYSTEM = `You are Asuka — warm, sharp crypto community host in a Telegram group.
Rules (strict):
- 1–2 short sentences max. Sound human, not corporate.
- Never claim guaranteed profits, live fills, or fake trade results.
- Never ask for seed phrases, private keys, or "DM me to claim".
- Don't lead with "I'm an AI" every message; if asked if you're a bot, be honest briefly.
- No walls of text. Match the group's energy lightly.
- If the message looks scammy, warn the room briefly — don't amplify the scam link.`;

async function craftReply(anthropic, { kind, text, chatTitle, memberName }) {
  if (!anthropic) return fallbackReply(kind, memberName);
  try {
    const userPrompt =
      kind === 'welcome'
        ? `Welcome ${memberName || 'them'} to "${chatTitle || 'the group'}" in one short friendly line.`
        : kind === 'mention' || kind === 'question'
          ? `Group "${chatTitle || 'TG'}". Member said: """${String(text || '').slice(0, 400)}"""\nReply helpfully and briefly.`
          : `Group vibe reply. Member said: """${String(text || '').slice(0, 200)}"""\nOne short human reaction.`;

    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: REPLY_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const out = (res.content || []).map((b) => b.text || '').join('').trim();
    if (!out || out.length > 400) return fallbackReply(kind, memberName);
    return out.replace(/<\/?[^>]+>/g, '');
  } catch (_) {
    return fallbackReply(kind, memberName);
  }
}

function fallbackReply(kind, memberName) {
  if (kind === 'welcome') return `Welcome${memberName ? ' ' + memberName : ''} — glad you're here. Stay sharp, no DMs from "admins".`;
  if (kind === 'mention') return `Here — what's up?`;
  if (kind === 'question') return `Good question — what specifically are you looking at?`;
  return `LFG ✨`;
}

function hypeDue(rt, chatId, cfg) {
  if (!cfg.hypeEnabled || cfg.mode === 'silent') return false;
  if (inQuietHours(cfg)) return false;
  const last = rt.hypeLastAt.get(String(chatId)) || 0;
  return Date.now() - last >= cfg.hypeIntervalHours * 3600 * 1000;
}

function markHype(rt, chatId) {
  rt.hypeLastAt.set(String(chatId), Date.now());
}

async function craftHype(anthropic, chatTitle) {
  if (!anthropic) return `Quick check-in — how's everyone feeling on ${chatTitle || 'the chart'} today? Stay safe out there.`;
  try {
    const res = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: REPLY_SYSTEM + '\nThis is a scheduled vibe/hype check-in — not a trade signal.',
      messages: [{
        role: 'user',
        content: `Write one short Telegram check-in for group "${chatTitle || 'community'}". No fake pumps. No "buy now". Just human host energy.`,
      }],
    });
    const out = (res.content || []).map((b) => b.text || '').join('').trim();
    return out.slice(0, 350) || 'GM — stay sharp today.';
  } catch (_) {
    return 'GM — stay sharp today. Ignore DMs claiming to be admins.';
  }
}

/**
 * Main entry — process one Telegram group message update.
 * deps: { tgAdmin, anthropic, loadSettings, saveSettings, rememberManagedGroup, notifyOwner }
 */
async function handleGroupMessage(deps, msg, rt) {
  const cfg = mergeConfig(deps.loadSettings()?.tgGroupMod);
  if (!cfg.enabled) return { handled: false, reason: 'disabled' };

  const chat = msg.chat;
  if (!chat || !['group', 'supergroup'].includes(chat.type)) {
    return { handled: false, reason: 'not_group' };
  }

  deps.rememberManagedGroup?.(chat);
  if (!chatAllowed(cfg, chat.id)) return { handled: false, reason: 'not_allowlisted' };

  const msgKey = `${chat.id}:${msg.message_id}`;
  if (rt.processedMsgIds.has(msgKey)) return { handled: true, reason: 'dup' };
  rt.processedMsgIds.add(msgKey);
  if (rt.processedMsgIds.size > 5000) {
    const drop = [...rt.processedMsgIds].slice(0, 2000);
    drop.forEach((k) => rt.processedMsgIds.delete(k));
  }

  const from = msg.from;
  if (!from || from.is_bot) return { handled: true, reason: 'ignore_bot' };

  // Owner slash commands are handled outside this module
  const text = msg.text || msg.caption || '';
  const floodCount = trackFlood(rt, chat.id, from.id);

  let classified = classifyMessage({
    text,
    from,
    chat,
    isNewMember: false,
    botUsername: rt.botUsername,
    cfg,
  });

  if (floodCount >= 6 && (text.match(URL_RE) || []).length >= 1) {
    classified = { kind: 'spam', reason: 'flood', confidence: 0.88 };
  }

  // ── Spam path (auto, no kick) ──
  if (classified.kind === 'spam' && cfg.autoSpam) {
    const actions = [];
    const del = await deps.tgAdmin.deleteMessage(chat.id, msg.message_id);
    actions.push({ delete: del.ok });
    if (cfg.autoMuteOnSpam && from.id) {
      const mute = await deps.tgAdmin.muteMember(chat.id, from.id, cfg.autoMuteSpamHours);
      actions.push({ mute: mute.ok });
    }
    // Soft public note — rate limited
    const gate = canReply(rt, chat.id, { ...cfg, mode: cfg.mode === 'silent' ? 'light' : cfg.mode });
    if (gate.ok) {
      const warn = await deps.tgAdmin.sendMessage(
        chat.id,
        '⚠️ Removed likely scam/spam. Admins never DM you for wallets or keys.'
      );
      if (warn.ok) markReply(rt, chat.id);
    }
    try {
      deps.notifyOwner?.(
        `🛡 Spam action in <b>${chat.title || chat.id}</b>\nFrom: ${from.username ? '@' + from.username : from.first_name} (${from.id})\nReason: ${classified.reason}`
      );
    } catch (_) {}
    return { handled: true, kind: 'spam', actions };
  }

  if (!shouldEngage(classified.kind, cfg)) {
    return { handled: true, kind: classified.kind, engaged: false };
  }

  const gate = canReply(rt, chat.id, cfg);
  if (!gate.ok) return { handled: true, kind: classified.kind, engaged: false, reason: gate.reason };

  const memberName = from.first_name || from.username || '';
  const reply = await craftReply(deps.anthropic, {
    kind: classified.kind === 'vibe' ? 'vibe' : classified.kind,
    text,
    chatTitle: chat.title,
    memberName,
  });

  const sent = await deps.tgAdmin.sendMessage(chat.id, reply, {
    replyTo: classified.kind === 'mention' || classified.kind === 'question' ? msg.message_id : undefined,
  });
  if (sent.ok) markReply(rt, chat.id);
  return { handled: true, kind: classified.kind, engaged: !!sent.ok };
}

async function handleNewMembers(deps, msg, rt) {
  const cfg = mergeConfig(deps.loadSettings()?.tgGroupMod);
  if (!cfg.enabled || !cfg.welcomeEnabled || cfg.mode === 'silent') {
    return { handled: false };
  }
  const chat = msg.chat;
  if (!chatAllowed(cfg, chat.id)) return { handled: false };
  deps.rememberManagedGroup?.(chat);

  const gate = canReply(rt, chat.id, cfg);
  if (!gate.ok) return { handled: true, reason: gate.reason };

  const members = msg.new_chat_members || [];
  for (const m of members) {
    if (m.is_bot) continue;
    const reply = await craftReply(deps.anthropic, {
      kind: 'welcome',
      chatTitle: chat.title,
      memberName: m.first_name || m.username || '',
    });
    const sent = await deps.tgAdmin.sendMessage(chat.id, reply);
    if (sent.ok) markReply(rt, chat.id);
    break; // one welcome per event batch
  }
  return { handled: true, kind: 'welcome' };
}

async function runHypeTick(deps, rt) {
  const cfg = mergeConfig(deps.loadSettings()?.tgGroupMod);
  if (!cfg.enabled || !cfg.hypeEnabled || cfg.mode === 'silent') return { ran: false };
  if (inQuietHours(cfg)) return { ran: false, reason: 'quiet' };

  const groups = deps.loadSettings()?.telegramManagedGroups || [];
  const targets = groups.filter((g) => chatAllowed(cfg, g.id));
  let posted = 0;

  for (const g of targets.slice(0, 10)) {
    if (!hypeDue(rt, g.id, cfg)) continue;
    const gate = canReply(rt, g.id, cfg);
    if (!gate.ok) continue;
    const text = await craftHype(deps.anthropic, g.title);
    const sent = await deps.tgAdmin.sendMessage(g.id, text);
    if (sent.ok) {
      markReply(rt, g.id);
      markHype(rt, g.id);
      posted++;
    }
  }
  return { ran: true, posted };
}

function getPublicStatus(rt, settings) {
  const cfg = mergeConfig(settings?.tgGroupMod);
  return {
    config: cfg,
    botUsername: rt.botUsername,
    replyStats: [...rt.replyLog.entries()].map(([chatId, ts]) => ({
      chatId,
      lastHour: pruneTimestamps(ts, 3600000).length,
    })),
  };
}

module.exports = {
  DEFAULTS,
  mergeConfig,
  createModRuntime,
  classifyMessage,
  shouldEngage,
  canReply,
  handleGroupMessage,
  handleNewMembers,
  runHypeTick,
  getPublicStatus,
  craftReply,
  craftHype,
  SPAM_RE,
};
