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
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },   // RDS needs SSL, local doesn't
});

pool.on('error', (e) => console.error('🗄️  pg pool error:', e.message));

// run the schema file once at boot
async function initDB() {
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'db-schema.sql'), 'utf8');
    await pool.query(schema);
    console.log('🗄️  DB initialized (users, user_data, asuka_state, user_credits)');
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
async function saveAsukaState(userId, s) {
  await pool.query(
    `INSERT INTO asuka_state (user_id, memory, bond, level, personality, coins, tier, streaks, lessons, cosmetics, allocations, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       memory=$2, bond=$3, level=$4, personality=$5, coins=$6, tier=$7,
       streaks=$8, lessons=$9, cosmetics=$10, allocations=$11, updated_at=NOW()`,
    [userId, JSON.stringify(s.memory||{}), s.bond||0, s.level||1, s.personality||'default',
     s.coins||0, s.tier||'premium', JSON.stringify(s.streaks||{}), JSON.stringify(s.lessons||{}),
     JSON.stringify(s.cosmetics||{}), JSON.stringify(s.allocations||{})]
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
