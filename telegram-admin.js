'use strict';
/**
 * Telegram group admin via Bot API.
 * Requires TELEGRAM_BOT_TOKEN and the bot to be group admin with matching rights.
 */
const DEFAULT_API = 'https://api.telegram.org';

function token() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}

async function api(method, body = {}) {
  const t = token();
  if (!t) return { ok: false, error: 'missing_bot_token', hint: 'Set TELEGRAM_BOT_TOKEN in .env' };
  try {
    const res = await fetch(`${DEFAULT_API}/bot${t}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      return {
        ok: false,
        error: data.description || 'telegram_api_error',
        code: data.error_code,
        raw: data,
      };
    }
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function normalizeChatId(chatId) {
  if (chatId == null || chatId === '') return null;
  const s = String(chatId).trim();
  if (/^-?\d+$/.test(s)) return s;
  if (s.startsWith('@')) return s;
  if (/^[A-Za-z][\w\d_]{3,}$/.test(s)) return `@${s}`;
  return s;
}

async function getMe() {
  return api('getMe', {});
}

async function getChat(chatId) {
  const id = normalizeChatId(chatId);
  if (!id) return { ok: false, error: 'chat_id_required' };
  return api('getChat', { chat_id: id });
}

async function getChatMember(chatId, userId) {
  return api('getChatMember', { chat_id: normalizeChatId(chatId), user_id: userId });
}

async function getChatAdministrators(chatId) {
  return api('getChatAdministrators', { chat_id: normalizeChatId(chatId) });
}

async function sendMessage(chatId, text, extra = {}) {
  return api('sendMessage', {
    chat_id: normalizeChatId(chatId),
    text,
    parse_mode: extra.parse_mode || 'HTML',
    disable_web_page_preview: extra.disable_preview !== false,
    reply_to_message_id: extra.replyTo || undefined,
  });
}

async function deleteMessage(chatId, messageId) {
  return api('deleteMessage', {
    chat_id: normalizeChatId(chatId),
    message_id: messageId,
  });
}

async function pinMessage(chatId, messageId, silent = false) {
  return api('pinChatMessage', {
    chat_id: normalizeChatId(chatId),
    message_id: messageId,
    disable_notification: !!silent,
  });
}

async function unpinMessage(chatId, messageId) {
  const body = { chat_id: normalizeChatId(chatId) };
  if (messageId) body.message_id = messageId;
  return api(messageId ? 'unpinChatMessage' : 'unpinAllChatMessages', body);
}

async function banMember(chatId, userId, opts = {}) {
  return api('banChatMember', {
    chat_id: normalizeChatId(chatId),
    user_id: userId,
    until_date: opts.untilDate || undefined,
    revoke_messages: opts.revokeMessages !== false,
  });
}

async function unbanMember(chatId, userId, onlyIfBanned = true) {
  return api('unbanChatMember', {
    chat_id: normalizeChatId(chatId),
    user_id: userId,
    only_if_banned: onlyIfBanned,
  });
}

/** Kick = ban then unban (removes without permanent ban). */
async function kickMember(chatId, userId) {
  const ban = await banMember(chatId, userId, { revokeMessages: false });
  if (!ban.ok) return ban;
  return unbanMember(chatId, userId, true);
}

async function restrictMember(chatId, userId, permissions, untilDate) {
  return api('restrictChatMember', {
    chat_id: normalizeChatId(chatId),
    user_id: userId,
    permissions: permissions || {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
    },
    until_date: untilDate || undefined,
  });
}

async function muteMember(chatId, userId, hours = 24) {
  const until = Math.floor(Date.now() / 1000) + Math.max(1, hours) * 3600;
  return restrictMember(chatId, userId, null, until);
}

async function unmuteMember(chatId, userId) {
  return restrictMember(chatId, userId, {
    can_send_messages: true,
    can_send_audios: true,
    can_send_documents: true,
    can_send_photos: true,
    can_send_videos: true,
    can_send_video_notes: true,
    can_send_voice_notes: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_invite_users: true,
  });
}

async function promoteMember(chatId, userId, rights = {}) {
  return api('promoteChatMember', {
    chat_id: normalizeChatId(chatId),
    user_id: userId,
    can_manage_chat: rights.manageChat ?? false,
    can_delete_messages: rights.deleteMessages ?? true,
    can_manage_video_chats: rights.videoChats ?? false,
    can_restrict_members: rights.restrict ?? true,
    can_promote_members: rights.promote ?? false,
    can_change_info: rights.changeInfo ?? false,
    can_invite_users: rights.invite ?? true,
    can_pin_messages: rights.pin ?? true,
    is_anonymous: rights.anonymous ?? false,
  });
}

async function setTitle(chatId, title) {
  return api('setChatTitle', { chat_id: normalizeChatId(chatId), title: String(title).slice(0, 128) });
}

async function setDescription(chatId, description) {
  return api('setChatDescription', {
    chat_id: normalizeChatId(chatId),
    description: String(description || '').slice(0, 255),
  });
}

async function setPermissions(chatId, permissions) {
  return api('setChatPermissions', {
    chat_id: normalizeChatId(chatId),
    permissions,
  });
}

async function approveJoin(chatId, userId) {
  return api('approveChatJoinRequest', {
    chat_id: normalizeChatId(chatId),
    user_id: userId,
  });
}

async function declineJoin(chatId, userId) {
  return api('declineChatJoinRequest', {
    chat_id: normalizeChatId(chatId),
    user_id: userId,
  });
}

async function leaveChat(chatId) {
  return api('leaveChat', { chat_id: normalizeChatId(chatId) });
}

/**
 * Resolve @username → user id when possible (getChat works for public users/channels).
 * For private users, pass numeric id from a replied message.
 */
async function resolveUser(chatId, usernameOrId) {
  if (usernameOrId == null) return { ok: false, error: 'user_required' };
  const raw = String(usernameOrId).trim();
  if (/^\d+$/.test(raw)) return { ok: true, userId: Number(raw) };
  const uname = raw.replace(/^@/, '');
  // Try getChat on @username (works for public users in some cases)
  const chat = await getChat(`@${uname}`);
  if (chat.ok && chat.result?.id && chat.result.type === 'private') {
    return { ok: true, userId: chat.result.id, user: chat.result };
  }
  // Fallback: look up among admins / — caller should pass numeric id from reply
  return {
    ok: false,
    error: 'resolve_failed',
    hint: 'Use numeric user id, or reply to their message. @username only works for public accounts.',
  };
}

module.exports = {
  token,
  api,
  normalizeChatId,
  getMe,
  getChat,
  getChatMember,
  getChatAdministrators,
  sendMessage,
  deleteMessage,
  pinMessage,
  unpinMessage,
  banMember,
  unbanMember,
  kickMember,
  restrictMember,
  muteMember,
  unmuteMember,
  promoteMember,
  setTitle,
  setDescription,
  setPermissions,
  approveJoin,
  declineJoin,
  leaveChat,
  resolveUser,
};
