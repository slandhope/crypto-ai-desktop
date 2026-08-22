/**
 * Chat routing + Anthropic prompt caching.
 * Quality-first: companion + scanner use Sonnet; Haiku only for trivial acks.
 * Prompt caching is cost-only — zero quality impact.
 */
const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

const SIMPLE_RE = /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|k|yes|no|yep|nope|cool|nice|lol|haha|gm|gn|good morning|good night|bye)[\s!.?]*$/i;
const DEEP_RE = /\b(explain|teach me|lesson|analyze|analysis|essay|write me|draft|detailed|in depth|step by step|interview prep|whiteboard|launch|resume|portfolio review|compare .{0,40} thoroughly|why does .{0,80} work)\b/i;

function lastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') return m.content.trim();
  }
  return '';
}

/** simple | normal | deep */
function classifyChatTier(messages, system = '') {
  const text = lastUserText(messages);
  const sys = String(system || '');
  if (!text) return 'normal';
  if (text.length <= 48 && SIMPLE_RE.test(text)) return 'simple';
  if (DEEP_RE.test(text) || DEEP_RE.test(sys)) return 'deep';
  return 'normal';
}

/** Quality-first tiers — no aggressive token starvation. */
function applyChatTier(clamped, tier) {
  const base = { ...clamped, tier };
  const cap = Math.min(Math.max(Number(clamped.max_tokens) || 1024, 256), 2048);

  if (tier === 'simple') {
    return { ...base, model: HAIKU, max_tokens: Math.min(Math.max(cap, 256), 512) };
  }
  if (tier === 'deep') {
    return {
      ...base,
      model: SONNET,
      max_tokens: Math.min(Math.max(cap, 1024), 2048),
    };
  }
  // Normal companion chat — full Sonnet quality
  return {
    ...base,
    model: SONNET,
    max_tokens: Math.min(Math.max(cap, 512), 2048),
  };
}

function resolveChatRequest(body, clampFn) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tier = classifyChatTier(messages, body.system);
  const clamped = clampFn(body || {});
  return applyChatTier(clamped, tier);
}

/** Wrap system prompt with Anthropic ephemeral prompt cache (same output, lower cost). */
function buildCachedSystem(system) {
  if (!system) return undefined;
  if (Array.isArray(system)) {
    return system.map((block, i) => {
      if (typeof block === 'string') {
        return { type: 'text', text: block, cache_control: { type: 'ephemeral' } };
      }
      if (block && typeof block === 'object' && block.type === 'text') {
        if (block.cache_control || i > 0) return block;
        return { ...block, cache_control: { type: 'ephemeral' } };
      }
      return block;
    });
  }
  const text = String(system);
  if (text.length < 80) return text;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

function anthropicChatParams({ system, messages, model, max_tokens }) {
  return {
    model,
    max_tokens,
    system: buildCachedSystem(system),
    messages: messages || [{ role: 'user', content: 'Hello' }],
  };
}

module.exports = {
  HAIKU,
  SONNET,
  classifyChatTier,
  applyChatTier,
  resolveChatRequest,
  buildCachedSystem,
  anthropicChatParams,
};
