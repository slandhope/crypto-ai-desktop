// Merge helpers for PC ↔ phone memory sync (bundled in asuka_state.memory.__sync)

const CHAT_CAP = 5000;
/** Max chat messages included in each PUT /state — full history stays local; reduces cleartext blast radius (H3). */
const SYNC_CHAT_WIRE_CAP = Number(process.env.ASUKA_SYNC_CHAT_CAP || 800);

function mergeChatLogs(a, b) {
  const map = new Map();
  for (const m of [...(a || []), ...(b || [])]) {
    if (!m || !m.text) continue;
    const key = m.id || `${m.ts || 0}:${m.role}:${String(m.text).slice(0, 48)}`;
    const prev = map.get(key);
    if (!prev || (m.ts || 0) >= (prev.ts || 0)) map.set(key, m);
  }
  return [...map.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0)).slice(-CHAT_CAP);
}

function mergeArraysByKey(a, b, keyFn) {
  const map = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item) continue;
    const key = keyFn(item);
    const prev = map.get(key);
    if (!prev || (item.timestamp || item.ts || 0) >= (prev.timestamp || prev.ts || 0)) map.set(key, item);
  }
  return [...map.values()].sort((x, y) => (x.timestamp || x.ts || 0) - (y.timestamp || y.ts || 0));
}

function mergeLongMemory(a, b) {
  if (!a) return b || { fresh: [], medium: [], longterm: [], corefacts: [], lastCompressed: null };
  if (!b) return a;
  return {
    fresh: mergeArraysByKey(a.fresh, b.fresh, m => `${m.timestamp}:${String(m.summary).slice(0, 40)}`),
    medium: mergeArraysByKey(a.medium, b.medium, m => `${m.timestamp}:${String(m.summary).slice(0, 40)}`),
    longterm: mergeArraysByKey(a.longterm, b.longterm, m => `${m.timestamp}:${String(m.summary).slice(0, 40)}`),
    corefacts: mergeArraysByKey(a.corefacts, b.corefacts, f => String(f.fact || f).slice(0, 80)),
    lastCompressed: Math.max(a.lastCompressed || 0, b.lastCompressed || 0) || null,
  };
}

function mergeBrainMemories(a, b) {
  return mergeArraysByKey(a, b, m => m.id || `${m.timestamp}:${String(m.text).slice(0, 40)}`);
}

function mergeJournal(a, b) {
  return mergeArraysByKey(a, b, e => e.id || `${e.timestamp || e.ts || 0}:${String(e.text || e.entry || '').slice(0, 40)}`);
}

function mergeNotes(a, b) {
  return mergeArraysByKey(a, b, n => `${n.timestamp}:${String(n.text).slice(0, 40)}`);
}

function mergeProfileFacts(a, b) {
  const facts = new Set([...(a || []), ...(b || [])].map(f => String(f).trim()).filter(f => f.length > 4));
  return [...facts].slice(-200);
}

function mergeEpisodes(a, b) {
  return mergeArraysByKey(a, b, e => e.id || `${e.ts || e.timestamp || 0}:${String(e.summary).slice(0, 40)}`);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'was', 'what', 'how', 'can', 'this', 'that', 'with', 'have', 'from',
  'your', 'about', 'just', 'like', 'when', 'will', 'been', 'they', 'them', 'some', 'into', 'also', 'than',
  'then', 'very', 'really', 'okay', 'yeah', 'that', 'but', 'not', 'all', 'any', 'her', 'his', 'she', 'him',
]);

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function scoreText(text, queryTokens) {
  const tokens = tokenize(text);
  if (!tokens.length) return 0;
  if (!queryTokens.length) return 0.01;
  let score = 0;
  const set = new Set(tokens);
  for (const q of queryTokens) {
    if (set.has(q)) score += 2;
    else if (tokens.some(t => t.includes(q) || q.includes(t))) score += 1;
  }
  return score / Math.sqrt(tokens.length);
}

/** Hakko-style retrieval — search full chat history + facts + episodes by relevance */
function retrieveRelevantMemories(sources, query, opts = {}) {
  const limit = opts.limit || 40;
  const minScore = opts.minScore ?? 0.25;
  const queryTokens = tokenize(query);
  const items = [];

  for (const m of sources.chatLog || []) {
    if (!m?.text) continue;
    const who = m.role === 'user' ? 'User' : 'Asuka';
    const dev = m.device && m.device !== 'pc' ? ` [${m.device}]` : '';
    const line = `${who}${dev}: ${m.text}`;
    items.push({
      text: line,
      ts: m.ts || 0,
      score: scoreText(m.text, queryTokens) + (m.role === 'user' ? 0.4 : 0),
    });
  }
  for (const m of sources.brainMemories || []) {
    if (!m?.text) continue;
    items.push({ text: `[saved] ${m.text}`, ts: m.timestamp || 0, score: scoreText(m.text, queryTokens) + 1.2 });
  }
  for (const f of sources.profileFacts || []) {
    items.push({ text: `[knows] ${f}`, ts: 0, score: scoreText(f, queryTokens) + 1.5 });
  }
  for (const ep of sources.episodes || []) {
    if (!ep?.summary) continue;
    items.push({
      text: `[past chat ${ep.date || ''}] ${ep.summary}`,
      ts: ep.ts || ep.timestamp || 0,
      score: scoreText(ep.summary, queryTokens) + 2,
    });
  }
  for (const tier of ['corefacts', 'longterm', 'medium', 'fresh']) {
    const arr = tier === 'corefacts'
      ? (sources.longMemory?.corefacts || []).map(f => ({ summary: f.fact || f, timestamp: f.timestamp }))
      : (sources.longMemory?.[tier] || []);
    for (const m of arr) {
      const s = m.summary || m.fact || m;
      if (!s) continue;
      items.push({ text: `[${tier}] ${s}`, ts: m.timestamp || 0, score: scoreText(String(s), queryTokens) + 1 });
    }
  }

  if (!queryTokens.length) {
    return items.sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit);
  }
  return items
    .filter(i => i.score >= minScore)
    .sort((a, b) => b.score - a.score || (b.ts || 0) - (a.ts || 0))
    .slice(0, limit);
}

/**
 * Shared recall block — same RAG-lite retrieval for Claude AND Grok research.
 * Tiered longMemory (fresh/medium/longterm/corefacts) is searched here; only
 * top matches are injected to keep token cost down vs dumping full chat log.
 */
function buildMemoryRecallBlock(sources, query, opts = {}) {
  const q = query || '';
  const limit = opts.limit ?? (q ? 45 : 60);
  const minScore = opts.minScore ?? (q ? 0.2 : 0);
  const retrieved = retrieveRelevantMemories(sources, q, { limit, minScore });
  const parts = [];
  if (retrieved.length) {
    parts.push('RECALL FROM FULL HISTORY:\n' + retrieved.map((r) => String(r.text).slice(0, 380)).join('\n'));
  }
  const lm = sources.longMemory;
  if (lm?.corefacts?.length > 0) {
    parts.push('CORE FACTS:\n' + lm.corefacts.slice(-8).map((f) => f.fact || f).join('\n'));
  }
  if (sources.patterns?.length > 0) {
    parts.push('BEHAVIOR PATTERNS:\n' + sources.patterns.slice(-5).map((p) => `- ${p.pattern}`).join('\n'));
  }
  return parts.join('\n\n').trim();
}

function memorySourcesFrom(cfg) {
  return {
    chatLog: cfg.loadChatLog?.() || [],
    brainMemories: cfg.loadBrainMemories?.() || [],
    profileFacts: cfg.loadUserProfile?.()?.facts || [],
    episodes: cfg.loadEpisodes?.() || [],
    longMemory: cfg.loadLongMemory?.() || null,
    patterns: cfg.loadPatterns?.() || [],
  };
}

function buildSyncBundle(cfg) {
  const chat = cfg.loadChatLog?.() || [];
  return {
    v: 2,
    chatLog: chat.slice(-Math.max(100, SYNC_CHAT_WIRE_CAP)),
    longMemory: cfg.loadLongMemory?.() || null,
    brainMemories: (cfg.loadBrainMemories?.() || []).slice(-200),
    patterns: (cfg.loadPatterns?.() || []).slice(-100),
    journal: (cfg.loadJournal?.() || []).slice(-200),
    voiceJournal: (cfg.loadVoiceJournal?.() || []).slice(-100),
    notes: (cfg.loadNotes?.() || []).slice(-100),
    userProfile: cfg.loadUserProfile?.() || { facts: [] },
    episodes: (cfg.loadEpisodes?.() || []).slice(-80),
  };
}

function latestSyncTs(bundle) {
  if (!bundle) return 0;
  let ts = 0;
  const last = (arr) => (arr?.length ? (arr[arr.length - 1].ts || arr[arr.length - 1].timestamp || 0) : 0);
  ts = Math.max(ts, last(bundle.chatLog));
  ts = Math.max(ts, bundle.longMemory?.lastCompressed || 0);
  ts = Math.max(ts, last(bundle.brainMemories));
  ts = Math.max(ts, last(bundle.journal));
  ts = Math.max(ts, last(bundle.voiceJournal));
  ts = Math.max(ts, last(bundle.notes));
  ts = Math.max(ts, (bundle.userProfile?.facts || []).length ? Date.now() : 0);
  ts = Math.max(ts, last(bundle.episodes));
  return ts;
}

function applySyncMerge(local, cloud, cfg) {
  if (!cloud || !cfg) return;
  const skip = { skipPush: true };
  if (cfg.loadChatLog && cfg.saveChatLog) {
    cfg.saveChatLog(mergeChatLogs(cfg.loadChatLog(), cloud.chatLog), skip);
  }
  if (cfg.loadLongMemory && cfg.saveLongMemory && cloud.longMemory) {
    cfg.saveLongMemory(mergeLongMemory(cfg.loadLongMemory(), cloud.longMemory), skip);
  }
  if (cfg.loadBrainMemories && cfg.saveBrainMemories && cloud.brainMemories) {
    cfg.saveBrainMemories(mergeBrainMemories(cfg.loadBrainMemories(), cloud.brainMemories), skip);
  }
  if (cfg.loadPatterns && cfg.savePatterns && cloud.patterns) {
    cfg.savePatterns(mergeArraysByKey(cfg.loadPatterns(), cloud.patterns, p => `${p.timestamp || 0}:${p.pattern}`), skip);
  }
  if (cfg.loadJournal && cfg.saveJournal && cloud.journal) {
    cfg.saveJournal(mergeJournal(cfg.loadJournal(), cloud.journal), skip);
  }
  if (cfg.loadVoiceJournal && cfg.saveVoiceJournal && cloud.voiceJournal) {
    cfg.saveVoiceJournal(mergeJournal(cfg.loadVoiceJournal(), cloud.voiceJournal), skip);
  }
  if (cfg.loadNotes && cfg.saveNotes && cloud.notes) {
    cfg.saveNotes(mergeNotes(cfg.loadNotes(), cloud.notes), skip);
  }
  if (cfg.loadUserProfile && cfg.saveUserProfile && cloud.userProfile) {
    const local = cfg.loadUserProfile();
    cfg.saveUserProfile({ facts: mergeProfileFacts(local.facts, cloud.userProfile.facts) }, skip);
  }
  if (cfg.loadEpisodes && cfg.saveEpisodes && cloud.episodes) {
    cfg.saveEpisodes(mergeEpisodes(cfg.loadEpisodes(), cloud.episodes), skip);
  }
}

function mergeSyncBundles(local, cloud) {
  if (!local) return cloud;
  if (!cloud) return local;
  return {
    v: 2,
    chatLog: mergeChatLogs(local.chatLog, cloud.chatLog),
    longMemory: mergeLongMemory(local.longMemory, cloud.longMemory),
    brainMemories: mergeBrainMemories(local.brainMemories, cloud.brainMemories),
    patterns: mergeArraysByKey(local.patterns, cloud.patterns, p => `${p.timestamp || 0}:${p.pattern}`),
    journal: mergeJournal(local.journal, cloud.journal),
    voiceJournal: mergeJournal(local.voiceJournal, cloud.voiceJournal),
    notes: mergeNotes(local.notes, cloud.notes),
    userProfile: { facts: mergeProfileFacts(local.userProfile?.facts, cloud.userProfile?.facts) },
    episodes: mergeEpisodes(local.episodes, cloud.episodes),
  };
}

module.exports = {
  CHAT_CAP, SYNC_CHAT_WIRE_CAP, mergeChatLogs, mergeLongMemory, mergeEpisodes, buildSyncBundle, latestSyncTs,
  applySyncMerge, mergeSyncBundles, retrieveRelevantMemories, tokenize,
  buildMemoryRecallBlock, memorySourcesFrom,
};
