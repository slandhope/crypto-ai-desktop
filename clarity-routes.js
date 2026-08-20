// ═══════════════════════════════════════════════════════════════════
// 🌱 CLARITY ROUTES — wellness/habit tracking, merged into Asuka's brain.
// The old Groq "coach" is GONE. Asuka is the intelligence now: she
// generates the daily adaptive plan, replacement habits, and check-ins
// via the same Claude the rest of the app uses.
// Auth = Cognito (authRequired), same account as everything else.
// Data lives in the user_data table (Postgres, via db.js).
//
//   register(api, { authRequired, callAsuka })   ← plugs into scanner-server
// ═══════════════════════════════════════════════════════════════════
const db = require('./db');

const HABIT_IDS = ['sleep', 'exercise', 'hydration', 'meditation', 'nutrition', 'breathwork', 'screens'];

// ── read/write the user_data row ──
async function getData(userId) {
  const r = await db.pool.query('SELECT * FROM user_data WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}
async function ensureRow(userId, name) {
  await db.upsertUser(userId, null, name);
  await db.pool.query('INSERT INTO user_data (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

// ── analyze last 7 days: which habits are weak/strong ──
function analyze(history, steps, sleepHours) {
  const last7 = [];
  for (let i = 0; i < 7; i++) { const d = new Date(); d.setDate(d.getDate() - i); last7.push(history[d.toISOString().split('T')[0]] || []); }
  const freq = {}; HABIT_IDS.forEach(h => { freq[h] = last7.filter(day => day.includes(h)).length; });
  const weak = Object.entries(freq).filter(([_, c]) => c <= 2).map(([h]) => h);
  const strong = Object.entries(freq).filter(([_, c]) => c >= 5).map(([h]) => h);
  const avg7 = last7.reduce((a, b) => a + b.length, 0) / 7;
  return { weak, strong, avg7, freq };
}

// ── compute streak / trend / difficulty from 30 days ──
function computePlan(history, steps, sleepHours) {
  const last30 = [];
  for (let i = 0; i < 30; i++) { const d = new Date(); d.setDate(d.getDate() - i); last30.push(history[d.toISOString().split('T')[0]] || []); }
  const last7avg = last30.slice(0, 7).reduce((a, b) => a + b.length, 0) / 7;
  const prev7avg = last30.slice(7, 14).reduce((a, b) => a + b.length, 0) / 7;
  const trend = last7avg > prev7avg + 0.5 ? 'improving' : last7avg < prev7avg - 0.5 ? 'declining' : 'stable';
  const stressedDays = last30.slice(0, 7).filter(d => d.length < 3).length;
  const isStressed = stressedDays >= 3;
  let streak = 0;
  for (const day of last30) { if (day.length >= 3 || day.includes('__freeze__')) streak++; else break; }
  const isOnRoll = last7avg >= 5;
  let difficulty = 'normal', goalCount = 5;
  if (isStressed) { difficulty = 'easy'; goalCount = 4; }
  else if (isOnRoll) { difficulty = 'challenging'; goalCount = 6; }
  return { last7avg, trend, stressedDays, isStressed, streak, isOnRoll, difficulty, goalCount };
}

// ── ASUKA generates today's adaptive plan (replaces runSmartAgent/Groq) ──
async function asukaDailyPlan(userId, callAsuka) {
  const data = await getData(userId);
  if (!data) return;
  const history = data.history || {};
  const p = computePlan(history, data.steps, data.sleep_hours);
  const today = new Date().toISOString().split('T')[0];
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];

  const system = `You are Asuka — a warm, caring anime companion who also helps the user with their daily wellness habits. You know them personally. Generate today's habit plan adapting to their recent patterns. Return ONLY raw JSON, no markdown, no commentary.`;
  const user = `TODAY: ${today} (${dayName})
Last 7-day avg habits/day: ${p.last7avg.toFixed(1)}
Trend: ${p.trend}
Stressed days this week: ${p.stressedDays}/7
Current streak: ${p.streak} days
Steps yesterday: ${data.steps || 0}
Sleep last night: ${data.sleep_hours || 0}h
Difficulty: ${p.difficulty} — generate ${p.goalCount} habits
${p.isStressed ? 'They seem stressed — be gentle, lower intensity, be kind and encouraging like Asuka would.' : ''}
${p.isOnRoll ? 'They are on a roll — add a challenge, be proud of them.' : ''}

Return JSON exactly:
{"notification":"a short warm message from Asuka","intent":"supportive|celebratory|challenging|recovery","habits":[{"id":"sleep_8","label":"8 hours sleep","emoji":"🌙","tip":"why it helps","points":20}],"insight":"one caring insight"}`;

  const reply = await callAsuka(system, user, 1500);
  try {
    const m = reply.match(/\{[\s\S]*\}/);
    if (m) {
      const plan = JSON.parse(m[0]);
      await db.pool.query(
        `UPDATE user_data SET ai_goals=$1, ai_goals_date=$2, ai_insight=$3, ai_intent=$4 WHERE user_id=$5`,
        [JSON.stringify(plan.habits || []), today, plan.insight || null, plan.intent || null, userId]
      );
      return plan;
    }
  } catch (e) { console.error('asukaDailyPlan parse:', e.message); }
}

function mergeStepsHistory(a, b) {
  const out = { ...(a || {}) };
  for (const [day, n] of Object.entries(b || {})) {
    out[day] = Math.max(out[day] || 0, Number(n) || 0);
  }
  const keys = Object.keys(out).sort();
  if (keys.length > 90) keys.slice(0, keys.length - 90).forEach((k) => delete out[k]);
  return out;
}

function mergeById(a, b, cap = 50) {
  const map = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item) continue;
    const id = item.id || `${item.ts || item.createdAt || 0}:${JSON.stringify(item).slice(0, 40)}`;
    const prev = map.get(id);
    const ts = item.ts || item.createdAt || item.updatedAt || 0;
    const prevTs = prev?.ts || prev?.createdAt || prev?.updatedAt || 0;
    if (!prev || ts >= prevTs) map.set(id, item);
  }
  return [...map.values()].sort((x, y) => (y.ts || y.createdAt || 0) - (x.ts || x.createdAt || 0)).slice(0, cap);
}

function mergeCoachChat(a, b) {
  const map = new Map();
  for (const m of [...(a || []), ...(b || [])]) {
    if (!m) continue;
    const text = m.content || m.text || '';
    const key = m.id || `${m.ts || 0}:${m.role}:${String(text).slice(0, 48)}`;
    const prev = map.get(key);
    if (!prev || (m.ts || 0) >= (prev.ts || 0)) map.set(key, m);
  }
  return [...map.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0)).slice(-200);
}

function mergeCreateStudio(local, remote) {
  local = local || {};
  remote = remote || {};
  const pickDraft = (l, r) => {
    if (!l) return r || null;
    if (!r) return l;
    return (r.updatedAt || 0) >= (l.updatedAt || 0) ? r : l;
  };
  return {
    resumeProfile: pickDraft(local.resumeProfile, remote.resumeProfile),
    websiteDraft: pickDraft(local.websiteDraft, remote.websiteDraft),
    history: mergeById(local.history, remote.history, 12),
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
  };
}

function mergeUserPrefs(local, remote) {
  local = local || {};
  remote = remote || {};
  const useRemote = (remote.updatedAt || 0) >= (local.updatedAt || 0);
  const base = useRemote ? { ...local, ...remote } : { ...remote, ...local };
  return {
    ...base,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
  };
}

function mergeHabitRewards(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  if (local.date !== remote.date) {
    const today = new Date().toISOString().split('T')[0];
    if (local.date === today) return local;
    if (remote.date === today) return remote;
    return local;
  }
  return {
    date: local.date,
    habitIds: [...new Set([...(local.habitIds || []), ...(remote.habitIds || [])])],
    perfectDay: !!(local.perfectDay || remote.perfectDay),
    milestones: [...new Set([...(local.milestones || []), ...(remote.milestones || [])])],
  };
}

function mergeSyncExtras(local, remote) {
  local = local || {};
  remote = remote || {};
  return {
    stepsHistory: mergeStepsHistory(local.stepsHistory, remote.stepsHistory),
    createStudio: mergeCreateStudio(local.createStudio, remote.createStudio),
    userPrefs: mergeUserPrefs(local.userPrefs, remote.userPrefs),
    coachChat: mergeCoachChat(local.coachChat, remote.coachChat),
    habitRewards: mergeHabitRewards(local.habitRewards, remote.habitRewards),
    tradingAlerts: {
      settings: { ...(remote.tradingAlerts?.settings || {}), ...(local.tradingAlerts?.settings || {}) },
      history: mergeById(local.tradingAlerts?.history, remote.tradingAlerts?.history, 50),
    },
    weeklyInsight: remote.weeklyInsight || local.weeklyInsight || null,
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0, Date.now()),
  };
}

// ── register all routes onto the existing api (scanner-server) ──
function register(api, { authRequired, callAsuka }) {

  // sync (save wellness data + coach goals)
  api.post('/api/sync', authRequired, async (req, res) => {
    try {
      const userId = req.user.userId;
      const {
        name, history, seenMilestones, steps, sleepHours, pushToken,
        aiGoals, aiGoalsDate, aiNewHabit, aiInsight, aiIntent, syncExtras,
      } = req.body || {};
      await ensureRow(userId, name);
      const cur = await getData(userId);
      const mergedExtras = syncExtras
        ? mergeSyncExtras(cur?.sync_extras || {}, syncExtras)
        : (cur?.sync_extras || {});
      await db.pool.query(
        `UPDATE user_data SET history=COALESCE($1,history), seen_milestones=COALESCE($2,seen_milestones),
           steps=COALESCE($3,steps), sleep_hours=COALESCE($4,sleep_hours),
           push_token=COALESCE($5,push_token),
           ai_goals=COALESCE($6,ai_goals), ai_goals_date=COALESCE($7,ai_goals_date),
           ai_new_habit=COALESCE($8,ai_new_habit), ai_insight=COALESCE($9,ai_insight),
           ai_intent=COALESCE($10,ai_intent), sync_extras=$11, updated_at=NOW() WHERE user_id=$12`,
        [history != null ? JSON.stringify(history) : null,
         seenMilestones != null ? JSON.stringify(seenMilestones) : null,
         steps ?? null, sleepHours ?? null, pushToken || null,
         aiGoals != null ? JSON.stringify(aiGoals) : null,
         aiGoalsDate ?? null,
         aiNewHabit != null ? JSON.stringify(aiNewHabit) : null,
         aiInsight ?? null, aiIntent ?? null,
         JSON.stringify(mergedExtras), userId]
      );
      res.json({ success: true });
    } catch (e) { console.error('sync:', e.message); res.status(500).json({ error: 'sync failed' }); }
  });

  // load wellness data
  api.get('/api/sync/me', authRequired, async (req, res) => {
    try {
      const userId = req.user.userId;
      const data = await getData(userId);
      if (!data) return res.json({ exists: false });
      res.json({
        exists: true,
        name: req.user.name,
        history: data.history || {},
        seenMilestones: data.seen_milestones || [],
        steps: data.steps || 0,
        sleepHours: data.sleep_hours || 0,
        aiGoals: data.ai_goals || [],
        aiGoalsDate: data.ai_goals_date || null,
        aiNewHabit: data.ai_new_habit || null,
        aiInsight: data.ai_insight || null,
        aiIntent: data.ai_intent || null,
        syncExtras: data.sync_extras || {},
        updatedAt: data.updated_at ? new Date(data.updated_at).getTime() : 0,
      });
    } catch (e) { res.status(500).json({ error: 'load failed' }); }
  });

  // today's habits (Asuka generates if it's a new day)
  api.get('/api/daily-habits', authRequired, async (req, res) => {
    try {
      const userId = req.user.userId;
      const today = new Date().toISOString().split('T')[0];
      await ensureRow(userId, req.user.name);
      const data = await getData(userId);
      const goals = data.ai_goals || [];
      if (data.ai_goals_date !== today || goals.length === 0) {
        await asukaDailyPlan(userId, callAsuka);
        const fresh = await getData(userId);
        return res.json({ habits: fresh.ai_goals || [], completed: fresh.completed_habits || [],
          insight: fresh.ai_insight || null, intent: fresh.ai_intent || null });
      }
      res.json({ habits: goals, completed: data.completed_habits || [],
        insight: data.ai_insight || null, intent: data.ai_intent || null });
    } catch (e) { console.error('daily-habits:', e.message); res.status(500).json({ error: 'failed' }); }
  });

  // complete a habit → Asuka suggests a replacement
  api.post('/api/complete-habit', authRequired, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { habitId } = req.body || {};
      const data = await getData(userId);
      if (!data) return res.json({ habit: null });
      const cur = data.ai_goals || [];
      const completed = data.completed_habits || [];
      const done = cur.find(h => String(h.id) === String(habitId));
      const newCompleted = [...completed, done?.label || habitId];
      const remaining = cur.filter(h => String(h.id) !== String(habitId));
      const a = analyze(data.history || {}, data.steps, data.sleep_hours);
      let newHabit = null;
      try {
        const reply = await callAsuka(
          'You are Asuka. Suggest ONE replacement wellness habit for the user. Return ONLY raw JSON.',
          `They just finished: ${done?.label || habitId}. Weak areas: ${a.weak.join(', ')}. JSON: {"id":"new_${Date.now()}","label":"5 min gratitude","emoji":"🙏","tip":"why","points":10}`,
          300
        );
        const m = reply.match(/\{[\s\S]*\}/);
        if (m) newHabit = JSON.parse(m[0]);
      } catch (e) {}
      const updated = newHabit ? [...remaining, newHabit] : remaining;
      await db.pool.query('UPDATE user_data SET ai_goals=$1, completed_habits=$2 WHERE user_id=$3',
        [JSON.stringify(updated), JSON.stringify(newCompleted), userId]);
      res.json({ habits: updated, completed: newCompleted, newHabit });
    } catch (e) { console.error('complete-habit:', e.message); res.status(500).json({ error: 'failed' }); }
  });

  // streak freezes
  api.get('/api/freezes', authRequired, async (req, res) => {
    try {
      const data = await getData(req.user.userId);
      res.json({ freezes: data?.streak_freezes ?? 1, usedDates: data?.freeze_used_dates || [] });
    } catch (e) { res.status(500).json({ error: 'failed' }); }
  });

  // delete account (wipes all their data — wellness + Asuka brain + credits via cascade)
  api.delete('/api/account', authRequired, async (req, res) => {
    try {
      await db.pool.query('DELETE FROM users WHERE id=$1', [req.user.userId]);  // cascades to all tables
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'failed' }); }
  });

  console.log('🌱 Clarity wellness routes registered (Asuka-powered)');
}

module.exports = { register, asukaDailyPlan, mergeSyncExtras };
