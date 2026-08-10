-- ═══════════════════════════════════════════════════════════════════
-- 🗄️  ASUKA + CLARITY — one unified Postgres database.
-- One Google account ties together: identity, wellness (Clarity),
-- Asuka's brain, and credits. Same user everywhere (PC + phone).
-- ═══════════════════════════════════════════════════════════════════

-- ── IDENTITY: one row per real user (Cognito/Google sub is the id) ──
CREATE TABLE IF NOT EXISTS users (
  id           VARCHAR(255) PRIMARY KEY,          -- Cognito sub (stable, same on PC + phone)
  email        VARCHAR(255),
  name         VARCHAR(255),
  created_at   TIMESTAMP DEFAULT NOW(),
  last_seen    TIMESTAMP DEFAULT NOW()
);

-- ── CLARITY: wellness / habit tracking (from the original server.js) ──
CREATE TABLE IF NOT EXISTS user_data (
  user_id           VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  history           JSONB DEFAULT '{}',           -- { "2026-07-26": ["sleep","exercise"], ... }
  streak            INTEGER DEFAULT 0,
  seen_milestones   JSONB DEFAULT '[]',
  steps             INTEGER DEFAULT 0,
  sleep_hours       FLOAT DEFAULT 0,
  push_token        TEXT,
  ai_goals          JSONB DEFAULT '[]',           -- today's adaptive tasks from the coach
  ai_goals_date     TEXT,
  ai_new_habit      JSONB,
  weekly_report     TEXT,
  completed_habits  JSONB DEFAULT '[]',
  ai_insight        TEXT,
  ai_intent         TEXT,
  mood_data         JSONB DEFAULT '[]',
  streak_freezes    INTEGER DEFAULT 1,
  freeze_used_dates JSONB DEFAULT '[]',
  updated_at        TIMESTAMP DEFAULT NOW()
);

-- ── ASUKA'S BRAIN: her soul, synced PC ↔ phone ──
CREATE TABLE IF NOT EXISTS asuka_state (
  user_id       VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  memory        JSONB DEFAULT '{}',               -- everything she remembers about you
  bond          INTEGER DEFAULT 0,
  level         INTEGER DEFAULT 1,
  personality   VARCHAR(64) DEFAULT 'default',     -- default / mommy / chill / analyst ...
  coins         INTEGER DEFAULT 0,
  tier          VARCHAR(32) DEFAULT 'premium',
  streaks       JSONB DEFAULT '{}',
  lessons       JSONB DEFAULT '{}',                -- study progress
  cosmetics     JSONB DEFAULT '{}',                -- unlocked outfits/room/etc.
  allocations   JSONB DEFAULT '{}',                -- trading capital buckets
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ── CREDITS: daily allowance + top-ups (metered AI usage) ──
CREATE TABLE IF NOT EXISTS user_credits (
  user_id        VARCHAR(255) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tier           VARCHAR(32) DEFAULT 'premium',
  daily_used     INTEGER DEFAULT 0,
  day            TEXT,                              -- YYYY-MM-DD for the daily reset
  topup          INTEGER DEFAULT 0,
  spent_today    INTEGER DEFAULT 0,
  updated_at     TIMESTAMP DEFAULT NOW()
);

-- ── TRADING BLOBS: paper / snipes / signals off instance disk (O2) ──
CREATE TABLE IF NOT EXISTS trading_blobs (
  key         TEXT PRIMARY KEY,                   -- paper | snipes | daily_signals | …
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── indexes for the queries the servers actually run ──
CREATE INDEX IF NOT EXISTS idx_user_data_updated  ON user_data(updated_at);
CREATE INDEX IF NOT EXISTS idx_asuka_updated       ON asuka_state(updated_at);
CREATE INDEX IF NOT EXISTS idx_trading_blobs_updated ON trading_blobs(updated_at);
