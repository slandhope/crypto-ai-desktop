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
function buildAdaptContext(data, history, steps, sleepHours) {
  const a = analyze(history, steps, sleepHours);
  const p = computePlan(history, steps, sleepHours);
  const today = new Date().toISOString().split('T')[0];
  const todayDone = history[today] || [];
  const freqLines = HABIT_IDS.map((id) => `${id}: ${a.freq[id] || 0}/7 days`).join(', ');
  return { a, p, today, todayDone, freqLines };
}

function adaptSystemPrompt() {
  return `You are Asuka — a warm, caring anime companion who personalizes daily wellness habits.
Adapt habit TARGETS up or down based on the user's sleep, steps, what they already finished today, and 7-day patterns.
Examples:
- Slept <6h → lower exercise duration, gentler hydration target, add rest/breathwork
- Slept 7h+ and high steps → can nudge hydration (2L→2.5L) or movement slightly
- Just finished hydration early → adjust remaining habits (more recovery if tired, more challenge if on a roll)
- Weak habit area → include easier version with encouraging tip
Return ONLY raw JSON, no markdown.`;
}

function adaptRulesBlock(p, a, sleepHours, steps) {
  return `RULES:
- Sleep ${sleepHours || 0}h: ${sleepHours < 6 ? 'LOW — reduce intensity on all remaining targets' : sleepHours >= 7 ? 'good — can increase slightly if trend improving' : 'moderate — keep balanced'}
- Steps: ${steps || 0}${steps >= 8000 ? ' (active — hydration/movement can go up)' : steps < 3000 ? ' (low — gentle targets)' : ''}
- Trend: ${p.trend}, difficulty: ${p.difficulty}
- Weak (7d): ${a.weak.join(', ') || 'none'}
- Strong (7d): ${a.strong.join(', ') || 'none'}
- If stressed (${p.stressedDays}/7 low days): fewer habits, lower targets`;
}

async function asukaDailyPlan(userId, callAsuka) {
  const data = await getData(userId);
  if (!data) return;
  const history = data.history || {};
  const steps = data.steps || 0;
  const sleepHours = data.sleep_hours || 0;
  const { a, p, today, todayDone, freqLines } = buildAdaptContext(data, history, steps, sleepHours);
  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];

  const user = `TODAY: ${today} (${dayName})
Generate ${p.goalCount} habits for today (fresh daily plan).
Last 7-day avg habits/day: ${p.last7avg.toFixed(1)}
Per-habit frequency: ${freqLines}
Already completed today: ${todayDone.join(', ') || 'none yet'}
Steps: ${steps} | Sleep last night: ${sleepHours}h
Streak: ${p.streak} days | Stressed days: ${p.stressedDays}/7
${adaptRulesBlock(p, a, sleepHours, steps)}
${p.isStressed ? 'They seem stressed — be gentle, lower intensity.' : ''}
${p.isOnRoll ? 'They are on a roll — include one stretch goal.' : ''}

Use habit ids like hydration, sleep, exercise, meditation, nutrition, breathwork, screens (or hydration_2L style).
Return JSON exactly:
{"notification":"short warm message","intent":"supportive|celebratory|challenging|recovery","habits":[{"id":"hydration","label":"2L water","emoji":"💧","tip":"why this target today","points":15}],"insight":"one caring insight","adjustment":"why these targets today"}`;

  const reply = await callAsuka(adaptSystemPrompt(), user, 1500);
  try {
    const m = reply.match(/\{[\s\S]*\}/);
    if (m) {
      const plan = JSON.parse(m[0]);
      await db.pool.query(
        `UPDATE user_data SET ai_goals=$1, ai_goals_date=$2, ai_insight=$3, ai_intent=$4,
         completed_habits='[]' WHERE user_id=$5`,
        [JSON.stringify(plan.habits || []), today, plan.insight || null, plan.intent || null, userId]
      );
      return plan;
    }
  } catch (e) { console.error('asukaDailyPlan parse:', e.message); }
}

/** Retune remaining habits after completion or when stats change. */
async function asukaRetunePlan(userId, callAsuka, opts = {}) {
  const data = await getData(userId);
  if (!data) return null;
  const today = new Date().toISOString().split('T')[0];
  let history = { ...(data.history || {}) };

  if (Array.isArray(opts.completedToday)) {
    history[today] = [...new Set([...(history[today] || []), ...opts.completedToday])];
  }
  const steps = opts.steps ?? data.steps ?? 0;
  const sleepHours = opts.sleepHours ?? data.sleep_hours ?? 0;

  if (opts.persistVitality) {
    await db.pool.query(
      `UPDATE user_data SET history=$1, steps=COALESCE($2,steps), sleep_hours=COALESCE($3,sleep_hours) WHERE user_id=$4`,
      [JSON.stringify(history), opts.steps ?? null, opts.sleepHours ?? null, userId]
    );
  }

  const cur = data.ai_goals || [];
  let remaining = cur;
  if (opts.justCompleted) {
    remaining = cur.filter((h) => String(h.id) !== String(opts.justCompleted));
  }

  const { a, p, todayDone, freqLines } = buildAdaptContext(data, history, steps, sleepHours);
  const justDone = opts.justCompleted
    ? cur.find((h) => String(h.id) === String(opts.justCompleted))
    : null;

  const user = `TODAY: ${today}
Just completed: ${justDone?.label || opts.justCompleted || 'none'}
Done so far today: ${todayDone.join(', ') || 'none'}
REMAINING habits to retune (adjust labels/targets, keep same ids where possible):
${JSON.stringify(remaining)}
Per-habit 7d frequency: ${freqLines}
Steps: ${steps} | Sleep: ${sleepHours}h
${adaptRulesBlock(p, a, sleepHours, steps)}

Increase targets if: good sleep + active + strong trend. Decrease if: poor sleep, stressed, or declining.
Return JSON:
{"habits":[...retuned remaining habits...],"insight":"brief note","adjustment":"what you changed and why","newHabit":null or one optional fill-in if list feels too short}`;

  const reply = await callAsuka(adaptSystemPrompt(), user, 1200);
  try {
    const m = reply.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    let habits = parsed.habits || remaining;
    if (parsed.newHabit && typeof parsed.newHabit === 'object') {
      habits = [...habits, parsed.newHabit];
    }
    const completed = data.completed_habits || [];
    const newCompleted = justDone
      ? [...completed, justDone.label || justDone.id]
      : completed;
    await db.pool.query(
      `UPDATE user_data SET ai_goals=$1, ai_insight=COALESCE($2,ai_insight), completed_habits=$3,
       history=$4, steps=COALESCE($5,steps), sleep_hours=COALESCE($6,sleep_hours) WHERE user_id=$7`,
      [
        JSON.stringify(habits),
        parsed.insight || null,
        JSON.stringify(newCompleted),
        JSON.stringify(history),
        opts.steps ?? null,
        opts.sleepHours ?? null,
        userId,
      ]
    );
    return {
      habits,
      insight: parsed.insight || data.ai_insight,
      adjustment: parsed.adjustment || null,
      newHabit: parsed.newHabit || null,
      completed: newCompleted,
    };
  } catch (e) {
    console.error('asukaRetunePlan parse:', e.message);
    return null;
  }
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
    customHabits: mergeById(local.customHabits, remote.customHabits, 30),
    habitNotes: { ...(remote.habitNotes || {}), ...(local.habitNotes || {}) },
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
        return res.json({
          habits: fresh.ai_goals || [], completed: fresh.completed_habits || [],
          insight: fresh.ai_insight || null, intent: fresh.ai_intent || null,
        });
      }
      res.json({
        habits: goals, completed: data.completed_habits || [],
        insight: data.ai_insight || null, intent: data.ai_intent || null,
      });
    } catch (e) { console.error('daily-habits:', e.message); res.status(500).json({ error: 'failed' }); }
  });

  // complete a habit → Asuka retunes remaining targets from sleep/steps/progress
  api.post('/api/complete-habit', authRequired, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { habitId, completedToday, steps, sleepHours } = req.body || {};
      const result = await asukaRetunePlan(userId, callAsuka, {
        justCompleted: habitId,
        completedToday: Array.isArray(completedToday) ? completedToday : null,
        steps: steps ?? null,
        sleepHours: sleepHours ?? null,
        persistVitality: true,
      });
      if (!result) return res.json({ habits: [], completed: [], adjustment: null });
      res.json(result);
    } catch (e) { console.error('complete-habit:', e.message); res.status(500).json({ error: 'failed' }); }
  });

  // retune habits when fitness/stats shift (no completion)
  api.post('/api/adapt-habits', authRequired, async (req, res) => {
    try {
      const userId = req.user.userId;
      const { completedToday, steps, sleepHours } = req.body || {};
      const data = await getData(userId);
      const today = new Date().toISOString().split('T')[0];
      if (!data?.ai_goals?.length || data.ai_goals_date !== today) {
        await asukaDailyPlan(userId, callAsuka);
        const fresh = await getData(userId);
        return res.json({
          habits: fresh.ai_goals || [],
          insight: fresh.ai_insight || null,
          adjustment: 'Fresh plan for today',
        });
      }
      const result = await asukaRetunePlan(userId, callAsuka, {
        completedToday: Array.isArray(completedToday) ? completedToday : null,
        steps: steps ?? null,
        sleepHours: sleepHours ?? null,
        persistVitality: true,
      });
      if (!result) return res.json({ habits: data.ai_goals || [], insight: data.ai_insight });
      res.json(result);
    } catch (e) { console.error('adapt-habits:', e.message); res.status(500).json({ error: 'failed' }); }
  });

  // Asuka gym plan from recent logs + recovery stats
  api.post('/api/gym-plan', authRequired, async (req, res) => {
    try {
      const { recentSessions, steps, sleepHours } = req.body || {};
      const data = await getData(req.user.userId);
      const sleep = sleepHours ?? data?.sleep_hours ?? 0;
      const stepCount = steps ?? data?.steps ?? 0;
      const history = data?.history || {};
      const a = analyze(history, stepCount, sleep);
      const p = computePlan(history, stepCount, sleep);
      const today = new Date().toISOString().split('T')[0];
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];

      const system = `You are Asuka — the user's gym partner. Create TODAY's workout with specific exercises, sets, rep ranges, and suggested weights based on their recent logs.
Progress when they are recovering well; deload or lighter volume if sleep is poor or they missed sessions.
Return ONLY raw JSON.`;
      const userPrompt = `TODAY: ${today} (${dayName})
Recent gym sessions (newest first): ${JSON.stringify(recentSessions || []).slice(0, 3500)}
Sleep last night: ${sleep}h | Steps: ${stepCount}
Wellness trend: ${p.trend} | Stressed: ${p.isStressed}
Rules:
- If sleep < 6h: lighter volume, technique focus, no max effort
- If sleep >= 7h and improving: suggest +2.5-5 lb or +1 rep vs last similar exercise when logged
- Pick push/pull/legs or full body based on what they did recently (avoid same muscles 2 days in a row)
- targetSets = number of working sets, targetReps = range like "8-10", suggestedWeight = number + unit they use

Return JSON:
{"split":"Push Day","insight":"one warm sentence","adjustment":"why these numbers today","exercises":[{"name":"Incline Bench","targetSets":4,"targetReps":"8-10","suggestedWeight":"135 lb","tip":"short cue"}]}`;

      const reply = await callAsuka(system, userPrompt, 1400);
      const m = reply.match(/\{[\s\S]*\}/);
      if (!m) return res.status(500).json({ error: 'plan failed' });
      const plan = JSON.parse(m[0]);
      res.json(plan);
    } catch (e) {
      console.error('gym-plan:', e.message);
      res.status(500).json({ error: 'plan failed' });
    }
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

module.exports = { register, asukaDailyPlan, asukaRetunePlan, mergeSyncExtras };
