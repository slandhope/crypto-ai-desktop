// ═══════════════════════════════════════════════════════════════════
// 🗄️  DB — one Postgres connection shared by all servers.
// Wraps identity, Clarity wellness, Asuka's brain, and credits.
// Reads DATABASE_URL from the vault/.env. Auto-creates tables on boot.
// ═══════════════════════════════════════════════════════════════════
const pkg = require('pg');
const fs = require('fs');
const path = require('path');
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (() => {
    const url = process.env.DATABASE_URL || '';
    if (!url || /localhost|127\.0\.0\.1/.test(url)) return false;
    // Pin RDS CA when provided; otherwise require valid certs (set DATABASE_SSL_INSECURE=1 only for broken local tunnels)
    if (process.env.DATABASE_SSL_INSECURE === '1' || process.env.DATABASE_SSL_INSECURE === 'true') {
      console.warn('⚠️  DATABASE_SSL_INSECURE=1 — RDS cert not verified');
      return { rejectUnauthorized: false };
    }
    const caPath = process.env.RDS_CA_PATH || process.env.DATABASE_SSL_CA;
    if (caPath && fs.existsSync(caPath)) {
      return { rejectUnauthorized: true, ca: fs.readFileSync(caPath, 'utf8') };
    }
    return { rejectUnauthorized: true };
  })(),
});

pool.on('error', (e) => console.error('🗄️  pg pool error:', e.message));

// run the schema file once at boot
async function initDB() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'db-schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('🗄️  DB initialized (users, user_data, asuka_state, user_credits, trading_blobs)');
  } catch (e) {
    console.error('🗄️  DB init error:', e.message);
  }
}

// ── identity ──
async function upsertUser(id, email, name) {
  await pool.query(
    `INSERT INTO users (id, email, name, last_seen) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET email=COALESCE($2,users.email), name=COALESCE($3,users.name), last_seen=NOW()`,
    [id, email || null, name || null]
  );
}

// ── Asuka brain ──
const ASUKA_DEFAULT = { memory:{}, bond:0, level:1, personality:'default', coins:0, tier:'premium', streaks:{}, lessons:{}, cosmetics:{}, allocations:{}, updatedAt:0 };
async function getAsukaState(userId) {
  const r = await pool.query('SELECT * FROM asuka_state WHERE user_id=$1', [userId]);
  if (!r.rows.length) return { ...ASUKA_DEFAULT };
  const row = r.rows[0];
  return {
    memory: row.memory, bond: row.bond, level: row.level, personality: row.personality,
    coins: row.coins, tier: row.tier, streaks: row.streaks, lessons: row.lessons,
    cosmetics: row.cosmetics, allocations: row.allocations,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}
function isEmptyObject(v) {
  return !v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0;
}

// Never wipe a populated memory column with {} / missing — companion moat guard
function pickMemory(incoming, current) {
  if (incoming === undefined || incoming === null) return current || {};
  if (typeof incoming !== 'object' || Array.isArray(incoming)) return current || {};
  if (isEmptyObject(incoming) && !isEmptyObject(current)) {
    console.warn('🗄️  refused empty memory overwrite for user (kept existing)');
    return current;
  }
  // If incoming drops a rich __sync while current has one, keep current.__sync
  if (incoming.__sync === undefined && current && current.__sync) {
    return { ...incoming, __sync: current.__sync };
  }
  if (isEmptyObject(incoming.__sync) && current && !isEmptyObject(current.__sync)) {
    return { ...incoming, __sync: current.__sync };
  }
  return incoming;
}

function pickJsonField(incoming, current, fallback = {}) {
  if (incoming === undefined || incoming === null) return current != null ? current : fallback;
  if (typeof incoming !== 'object') return current != null ? current : fallback;
  if (isEmptyObject(incoming) && !isEmptyObject(current)) return current;
  return incoming;
}

async function saveAsukaState(userId, s) {
  const cur = await getAsukaState(userId);
  const memory = pickMemory(s.memory, cur.memory);
  const streaks = pickJsonField(s.streaks, cur.streaks, {});
  const lessons = pickJsonField(s.lessons, cur.lessons, {});
  const cosmetics = pickJsonField(s.cosmetics, cur.cosmetics, {});
  const allocations = pickJsonField(s.allocations, cur.allocations, {});
  const bond = typeof s.bond === 'number' ? s.bond : (cur.bond || 0);
  const level = typeof s.level === 'number' ? s.level : (cur.level || 1);
  const coins = typeof s.coins === 'number' ? s.coins : (cur.coins || 0);
  const personality = s.personality || cur.personality || 'default';
  const tier = s.tier || cur.tier || 'premium';

  await pool.query(
    `INSERT INTO asuka_state (user_id, memory, bond, level, personality, coins, tier, streaks, lessons, cosmetics, allocations, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       memory=$2, bond=$3, level=$4, personality=$5, coins=$6, tier=$7,
       streaks=$8, lessons=$9, cosmetics=$10, allocations=$11, updated_at=NOW()`,
    [userId, JSON.stringify(memory || {}), bond, level, personality,
     coins, tier, JSON.stringify(streaks || {}), JSON.stringify(lessons || {}),
     JSON.stringify(cosmetics || {}), JSON.stringify(allocations || {})]
  );
  return getAsukaState(userId);
}
async function patchAsukaState(userId, patch) {
  const cur = await getAsukaState(userId);
  return saveAsukaState(userId, { ...cur, ...patch });
}

// ── credits (per-user balance in user_credits table) ──
async function getCreditRow(userId) {
  const r = await pool.query('SELECT * FROM user_credits WHERE user_id=$1', [userId]);
  if (!r.rows.length) return { user_id: userId, tier: 'premium', daily_used: 0, day: null, topup: 0, spent_today: 0 };
  return r.rows[0];
}
async function saveCreditRow(userId, c) {
  await pool.query(
    `INSERT INTO user_credits (user_id, tier, daily_used, day, topup, spent_today, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       tier=$2, daily_used=$3, day=$4, topup=$5, spent_today=$6, updated_at=NOW()`,
    [userId, c.tier||'premium', c.daily_used||0, c.day||null, c.topup||0, c.spent_today||0]
  );
}
async function allCreditRows() {
  const r = await pool.query('SELECT user_id, tier FROM user_credits');
  return r.rows;
}

module.exports = { pool, initDB, upsertUser, getAsukaState, saveAsukaState, patchAsukaState,
  getCreditRow, saveCreditRow, allCreditRows };
