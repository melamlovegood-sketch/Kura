-- ============================================================================
-- Kura · 一键建库脚本（合并版 / generated, do not hand-edit）
-- ----------------------------------------------------------------------------
-- 用法：全选本文件 → 复制 → Supabase Dashboard → SQL Editor → 粘贴 → Run。
-- 适用对象：全新的空 Supabase project（这里是 ref = zejzsrenwyywgbquutge）。
--
-- 合并顺序：
--   1) BASE SCHEMA           = supabase/schema.sql       （建表/枚举/视图/种子）
--   2) MIGRATION 0001..0018  = supabase/migrations/*.sql （按文件名顺序）
--
--   为什么要先拼 schema.sql：migrations 的 0001 起手就是 ALTER TABLE user_settings，
--   依赖 base schema 已经把表建好；只跑 migrations 会在空库上直接报错。
--
-- 注意事项：
--   * BASE SCHEMA 段用的是 CREATE TABLE（无 IF NOT EXISTS），只能在“空库”跑一次；
--     重复运行会因对象已存在而报错。MIGRATION 段是幂等的，可单独重复执行。
--   * 依赖 auth.users（Supabase 默认已建）；0009 起所有表的 user_id 外键指向它。
--   * 全部语句在 SQL Editor 里作为一个事务执行。0006 / 0011 的 ALTER TYPE ADD VALUE
--     只“新增”枚举值、脚本里并不“使用”它们，所以单次粘贴执行没问题。万一遇到
--     “unsafe use of new value”，把 0006、0011 那两段单独先各跑一次即可。
--   * 跑完后：Authentication → Providers → Email 关掉 “Confirm email”
--     （注册后立即登录，见 0009 注释）。
-- ============================================================================

-- ████████████████████████████████████████████████████████████████████████████
-- ██  BASE SCHEMA  —  supabase/schema.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Kura schema
-- Run this in Supabase SQL editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Enum types ───────────────────────────────────────────────────────────────

CREATE TYPE category_main AS ENUM ('basic_life', 'discretionary');

CREATE TYPE item_category AS ENUM (
  -- 基础生活
  'canteen', 'transport', 'daily_supplies',
  -- 可支配消费
  'daily', 'online_shopping', 'entertainment', 'other'
);

CREATE TYPE season_tag AS ENUM ('year_round', 'summer', 'winter', 'specific');

CREATE TYPE ai_provider AS ENUM ('qwen', 'gpt', 'claude', 'gemini');

CREATE TYPE price_platform AS ENUM ('jd', 'official', 'taobao_manual', 'taobao', 'dewu', 'other');

CREATE TYPE review_type AS ENUM ('day7', 'day30');

-- ─── user_settings ────────────────────────────────────────────────────────────

CREATE TABLE user_settings (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  cooldown_hours  integer NOT NULL DEFAULT 72,
  ai_provider     ai_provider NOT NULL DEFAULT 'qwen',
  ai_model        text NOT NULL DEFAULT 'qwen-vl-plus',
  ai_api_key      text,
  theme           text NOT NULL DEFAULT 'warm' CHECK (theme IN ('warm', 'cool', 'dark')),
  timer_minutes   integer NOT NULL DEFAULT 15,   -- execution-layer default countdown (minutes)
  -- 推送通知开关（migration 0014）。关掉的类型 send-reminders Edge Function 跳过。
  notify_cooldown     boolean NOT NULL DEFAULT true,
  notify_subscription boolean NOT NULL DEFAULT true,
  notify_expiry       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- If applying to an existing DB:
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'warm' CHECK (theme IN ('warm', 'cool', 'dark'));
-- ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS timer_minutes integer NOT NULL DEFAULT 15;

-- ─── monthly_budgets ──────────────────────────────────────────────────────────

CREATE TABLE monthly_budgets (
  id                  uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  month               text NOT NULL UNIQUE,    -- 'YYYY-MM'
  total_income        numeric(10,2),
  basic_life_limit    numeric(10,2) NOT NULL,
  discretionary_limit numeric(10,2) NOT NULL,
  note                text,
  ai_suggested        boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ─── impulse_records ──────────────────────────────────────────────────────────

CREATE TABLE impulse_records (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  item_name       text NOT NULL,
  estimated_price numeric(10,2),
  season_tag      season_tag NOT NULL DEFAULT 'year_round',
  source          text,                        -- where they saw it
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'dismissed'))
);

-- ─── wishlist_items ───────────────────────────────────────────────────────────

CREATE TABLE wishlist_items (
  id                uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  item_name         text NOT NULL,
  category          text,                      -- free-text product category
  estimated_price   numeric(10,2),
  season_tag        season_tag NOT NULL DEFAULT 'year_round',
  priority          integer NOT NULL DEFAULT 0,
  need_intensity    smallint CHECK (need_intensity BETWEEN 1 AND 10),
  worthiness_score  smallint CHECK (worthiness_score BETWEEN 1 AND 10),
  worthiness_reason text,
  is_focus          boolean NOT NULL DEFAULT false,
  last_nudged_at    timestamptz,
  status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'purchased', 'dismissed')),
  impulse_record_id uuid REFERENCES impulse_records (id) ON DELETE SET NULL,
  added_at          timestamptz NOT NULL DEFAULT now()
);

-- ─── wish_pools ───────────────────────────────────────────────────────────────

CREATE TABLE wish_pools (
  id            uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  focus_item_id uuid NOT NULL REFERENCES wishlist_items (id) ON DELETE RESTRICT,
  target_amount numeric(10,2) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
  -- saved_amount computed: SELECT COALESCE(SUM(amount),0) FROM savings_records WHERE wish_pool_id = ?
);

-- ─── savings_records ──────────────────────────────────────────────────────────

CREATE TABLE savings_records (
  id           uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  wish_pool_id uuid NOT NULL REFERENCES wish_pools (id) ON DELETE CASCADE,
  amount       numeric(10,2) NOT NULL,
  description  text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── execution_sessions ───────────────────────────────────────────────────────

CREATE TABLE execution_sessions (
  id             uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  category       text NOT NULL,
  timer_duration integer NOT NULL DEFAULT 900, -- seconds, default 15min
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  decision       text CHECK (decision IN ('bought', 'skipped', 'undecided')),
  item_purchased text
);

-- ─── transactions ─────────────────────────────────────────────────────────────

CREATE TABLE transactions (
  id                    uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  date                  date NOT NULL,
  amount                numeric(10,2) NOT NULL,
  category              item_category NOT NULL,
  category_main         category_main NOT NULL,
  description           text,
  source                text CHECK (source IN ('screenshot', 'text')),
  image_url             text,
  review_tag            text CHECK (review_tag IN ('regret', 'worth')),
  wishlist_item_id      uuid REFERENCES wishlist_items (id) ON DELETE SET NULL,
  execution_session_id  uuid REFERENCES execution_sessions (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ─── sop_rules ────────────────────────────────────────────────────────────────

CREATE TABLE sop_rules (
  id      uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  title   text NOT NULL,
  content text NOT NULL,
  "order" integer NOT NULL
);

-- ─── brand_library ────────────────────────────────────────────────────────────

CREATE TABLE brand_library (
  id         uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  category   text NOT NULL,
  brand_name text NOT NULL,
  weight     integer NOT NULL DEFAULT 5,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── price_tracks ─────────────────────────────────────────────────────────────

CREATE TABLE price_tracks (
  id               uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  wishlist_item_id uuid REFERENCES wishlist_items (id) ON DELETE SET NULL,
  item_name        text NOT NULL,
  target_price     numeric(10,2),
  current_price    numeric(10,2),
  source_url       text,
  platform         price_platform NOT NULL,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- ─── price_records ────────────────────────────────────────────────────────────

CREATE TABLE price_records (
  id             uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  price_track_id uuid NOT NULL REFERENCES price_tracks (id) ON DELETE CASCADE,
  price          numeric(10,2) NOT NULL,
  is_manual      boolean NOT NULL DEFAULT false,
  recorded_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── review_tasks ─────────────────────────────────────────────────────────────

CREATE TABLE review_tasks (
  id             uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  transaction_id uuid REFERENCES transactions (id) ON DELETE SET NULL,
  item_name      text NOT NULL,
  brand          text,
  category       text,
  due_at         timestamptz NOT NULL,
  review_type    review_type NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ─── review_results ───────────────────────────────────────────────────────────

CREATE TABLE review_results (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  review_task_id  uuid NOT NULL REFERENCES review_tasks (id) ON DELETE CASCADE,
  usage_frequency text NOT NULL CHECK (usage_frequency IN ('everyday', 'sometimes', 'rarely')),
  worthiness      text NOT NULL CHECK (worthiness IN ('worth', 'okay', 'regret')),
  usage_note      text,
  completed_at    timestamptz NOT NULL DEFAULT now()
);

-- ─── push_subscriptions ───────────────────────────────────────────────────────
-- PWA Web Push 订阅（migration 0014）。一个用户可有多条(多设备)；endpoint 全局唯一。

CREATE TABLE push_subscriptions (
  id           uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id      uuid NOT NULL,
  endpoint     text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ─── Seed data ────────────────────────────────────────────────────────────────

INSERT INTO user_settings (cooldown_hours, ai_provider, ai_model)
VALUES (72, 'qwen', 'qwen-vl-plus');

-- 执行层 SOP 不再 seed 默认规则（裤子 / 上衣 / 搜索决策 / 品牌优先 / 计时器）。
-- 这些只是占位文案，真实 SOP 应由用户自己沉淀。见 migration 0013。

-- ─── personal_principles ─────────────────────────────────────────────────────

CREATE TABLE personal_principles (
  id         uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  content    text NOT NULL,
  "order"    integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─── Helper views ─────────────────────────────────────────────────────────────

-- current month budget with actual spending
CREATE VIEW v_current_budget AS
SELECT
  b.*,
  COALESCE(SUM(t.amount) FILTER (WHERE t.category_main = 'basic_life'), 0)    AS basic_life_used,
  COALESCE(SUM(t.amount) FILTER (WHERE t.category_main = 'discretionary'), 0) AS discretionary_used
FROM monthly_budgets b
LEFT JOIN transactions t
  ON to_char(t.date, 'YYYY-MM') = b.month
WHERE b.month = to_char(now(), 'YYYY-MM')
GROUP BY b.id;

-- active wish pool with saved amount
CREATE VIEW v_active_wish_pool AS
SELECT
  wp.*,
  COALESCE(SUM(sr.amount), 0) AS saved_amount,
  wi.item_name                AS focus_item_name
FROM wish_pools wp
JOIN wishlist_items wi ON wi.id = wp.focus_item_id
LEFT JOIN savings_records sr ON sr.wish_pool_id = wp.id
WHERE wi.is_focus = true
  AND wp.completed_at IS NULL
GROUP BY wp.id, wi.item_name;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0001_fix_user_settings.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: align user_settings with the app's write payload
-- Symptom: POST .../rest/v1/user_settings → 400 Bad Request when saving API Key.
-- Cause:   the live user_settings table predates later schema additions (the
--          `theme` column was added after first deploy — see the note in
--          schema.sql), so PostgREST rejects writes that reference a column
--          that doesn't exist in the table's schema cache.
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.
--
-- Note: this project is single-user; user_settings has NO user_id column and
-- RLS is intentionally left disabled (the anon key reads/writes the single
-- settings row). A 400 here is a column/schema mismatch, NOT an RLS issue —
-- RLS denials surface as 401/403 or empty results, never 400.

-- 1. Ensure the ai_provider enum exists (table may predate it)
DO $$ BEGIN
  CREATE TYPE ai_provider AS ENUM ('qwen', 'gpt', 'claude', 'gemini');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Ensure every column the app reads/writes exists
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS cooldown_hours integer     NOT NULL DEFAULT 72;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_provider    ai_provider NOT NULL DEFAULT 'qwen';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_model       text        NOT NULL DEFAULT 'qwen-vl-plus';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS ai_api_key     text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS theme          text        NOT NULL DEFAULT 'warm';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

-- 3. Add the theme CHECK constraint only if it isn't already present
DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_theme_check
    CHECK (theme IN ('warm', 'cool', 'dark'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4. Guarantee exactly one settings row (the app reads .limit(1).maybeSingle())
INSERT INTO user_settings (cooldown_hours, ai_provider, ai_model)
SELECT 72, 'qwen', 'qwen-vl-plus'
WHERE NOT EXISTS (SELECT 1 FROM user_settings);

-- 5. Verify the resulting columns (output appears in the SQL Editor results pane)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_settings'
ORDER BY ordinal_position;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0002_fix_transactions_rls.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: allow the anon key to write to transactions
-- Symptom: clicking 「确认记账」 does nothing — the card stays, no row is written.
-- Cause:   POST .../rest/v1/transactions → 401, code 42501,
--          "new row violates row-level security policy for table \"transactions\"".
--          RLS is ENABLED on transactions but no policy permits inserts, so every
--          write is rejected. (Reads via the v_current_budget view still worked,
--          which is why the failure was silent until insert.)
--
-- Design:  this project is single-user; tables carry NO user_id column and RLS is
--          intentionally left disabled — the embedded anon key reads/writes directly
--          (see the note in 0001_fix_user_settings.sql). transactions diverged from
--          that design, so this migration brings it back in line.
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.
--
-- NOTE: if other writes later fail the same way (42501 on impulse_records,
-- wishlist_items, monthly_budgets, savings_records, personal_principles, …),
-- apply the same `DISABLE ROW LEVEL SECURITY` to those tables.

ALTER TABLE transactions DISABLE ROW LEVEL SECURITY;

-- Verify the result (output appears in the SQL Editor results pane):
-- relrowsecurity = false means RLS is off and anon inserts are allowed.
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = 'transactions';


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0003_add_timer_minutes.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: add the user-configurable execution-layer timer duration
-- Feature:  Settings → 默认计时时长 (SPEC §5: 计时时长，默认15min，用户可改).
-- The app reads/writes user_settings.timer_minutes; without this column a write
-- that includes it would 400 (PostgREST schema-cache mismatch — same failure
-- mode as 0001).
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS timer_minutes integer NOT NULL DEFAULT 15;

-- Verify the resulting column (output appears in the SQL Editor results pane)
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_settings' AND column_name = 'timer_minutes';


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0004_add_expiry_date.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: add an optional shelf-life / expiry date to transactions
-- Feature:  保质期提醒 (SPEC_PHASE2 §9). Food / cosmetics / health purchases can
-- carry a 保质期; the app surfaces a Home reminder 7 days and 1 day before it.
-- The confirm card writes transactions.expiry_date; without this column that
-- write would 400 (PostgREST schema-cache mismatch — same failure mode as 0001).
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS expiry_date date;

-- Verify the resulting column (output appears in the SQL Editor results pane)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'transactions' AND column_name = 'expiry_date';


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0005_add_cost_perspective.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: cost-perspective identity profile on user_settings
-- Feature:  代价视角 (SPEC_PHASE2 §1). Settings gains a 学生 / 工作党 identity so
-- the app can translate a price into a felt cost ("11 天伙食费", "工作 3 小时").
-- The settings store reads/writes these columns; without them a write that
-- includes them would 400 (PostgREST schema-cache mismatch — same as 0001).
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS identity            text
    CHECK (identity IN ('student', 'worker')),
  ADD COLUMN IF NOT EXISTS monthly_income      numeric(10,2),  -- 月生活费 / 月薪
  ADD COLUMN IF NOT EXISTS monthly_food_budget numeric(10,2),  -- 月伙食费（学生）
  ADD COLUMN IF NOT EXISTS daily_work_hours    numeric(4,1);   -- 日工作时长（工作党）

-- Verify the resulting columns (output appears in the SQL Editor results pane)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'user_settings'
  AND column_name IN ('identity', 'monthly_income', 'monthly_food_budget', 'daily_work_hours')
ORDER BY column_name;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0006_add_subscriptions.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: subscription tracker (SPEC_PHASE2 §2 订阅管理)
-- Subscriptions are recurring fixed costs. They live under 基础支出, auto-generate
-- one transaction per month on their billing day, and surface a Home reminder
-- 3 days before the charge.
--
-- This project is single-user: no user_id columns, RLS intentionally OFF (see
-- 0002_fix_transactions_rls.sql). New tables created here follow the same design.
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.

-- ── 1. New enum value for the auto-generated transactions ──────────────────────
-- NOTE: ALTER TYPE ... ADD VALUE cannot be used in the SAME transaction that adds
-- it. The SQL Editor runs each statement on its own, so this is fine. If you ever
-- get "unsafe use of new value", just run this one line by itself first.
ALTER TYPE item_category ADD VALUE IF NOT EXISTS 'subscription';

-- ── 2. subscriptions table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id          uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  name        text NOT NULL,
  amount      numeric(10,2) NOT NULL,
  billing_day smallint NOT NULL CHECK (billing_day BETWEEN 1 AND 31), -- 每月几号扣
  category    text NOT NULL DEFAULT 'other'
    CHECK (category IN ('streaming', 'tools', 'transport', 'other')), -- 流媒体/工具/出行/其他
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE subscriptions DISABLE ROW LEVEL SECURITY;

-- ── 3. link generated transactions back to their subscription ──────────────────
-- Used to detect "已为本月生成过扣款记录" so we never double-charge a month.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS subscription_id uuid REFERENCES subscriptions (id) ON DELETE SET NULL;

-- Verify (output appears in the SQL Editor results pane):
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'subscriptions'
ORDER BY ordinal_position;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0007_add_achievements.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: Streak + achievements (SPEC_PHASE2 §8 成就系统)
-- Single-user design: no user_id columns, RLS OFF (see 0002_fix_transactions_rls.sql).
-- user_streak is a single-row table. achievements has one row per unlocked badge.
--
-- This migration is IDEMPOTENT — safe to run multiple times. Run it in
-- Supabase Dashboard → SQL Editor.

-- ── achievements ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS achievements (
  id              uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  achievement_key text NOT NULL UNIQUE,   -- first_acorn / iron_heart / …
  unlocked_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE achievements DISABLE ROW LEVEL SECURITY;

-- ── user_streak (single row) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_streak (
  id             uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  current_streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  last_check_date date
);

ALTER TABLE user_streak DISABLE ROW LEVEL SECURITY;

-- Verify (output appears in the SQL Editor results pane):
SELECT 'achievements' AS tbl, count(*) FROM achievements
UNION ALL
SELECT 'user_streak', count(*) FROM user_streak;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0008_disable_rls_all.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: disable RLS on EVERY remaining table (P0 root-cause fix)
--
-- Symptom: console floods with 401 Unauthorized on wish_pools / execution_sessions
--          / brand_library / sop_rules / savings_records / wishlist_items /
--          impulse_records / review_* / personal_principles … and the execution
--          layer throws `invalid input syntax for type uuid: ""` because
--          createSession() got a 401, returned no row, and the empty session id
--          was then sent to transactions.execution_session_id.
--
-- Cause:   this project is single-user with NO auth and NO user_id columns. The
--          embedded anon key is meant to read/write directly. Earlier migrations
--          only turned RLS off on transactions (0002), subscriptions (0006),
--          achievements + user_streak (0007). Every OTHER table still has RLS
--          ENABLED with no policy, so anon reads/writes are rejected (401/42501).
--
-- Fix:     bring all remaining tables in line with the single-user design by
--          disabling RLS. Idempotent — safe to run multiple times. Run it in
--          Supabase Dashboard → SQL Editor.

ALTER TABLE user_settings        DISABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_budgets      DISABLE ROW LEVEL SECURITY;
ALTER TABLE impulse_records      DISABLE ROW LEVEL SECURITY;
ALTER TABLE wishlist_items       DISABLE ROW LEVEL SECURITY;
ALTER TABLE wish_pools           DISABLE ROW LEVEL SECURITY;
ALTER TABLE savings_records      DISABLE ROW LEVEL SECURITY;
ALTER TABLE execution_sessions   DISABLE ROW LEVEL SECURITY;
ALTER TABLE sop_rules            DISABLE ROW LEVEL SECURITY;
ALTER TABLE brand_library        DISABLE ROW LEVEL SECURITY;
ALTER TABLE price_tracks         DISABLE ROW LEVEL SECURITY;
ALTER TABLE price_records        DISABLE ROW LEVEL SECURITY;
ALTER TABLE review_tasks         DISABLE ROW LEVEL SECURITY;
ALTER TABLE review_results       DISABLE ROW LEVEL SECURITY;
ALTER TABLE personal_principles  DISABLE ROW LEVEL SECURITY;
-- already disabled by earlier migrations, repeated here so a fresh DB is fully
-- covered by running schema.sql + this single file:
ALTER TABLE transactions         DISABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions        DISABLE ROW LEVEL SECURITY;
ALTER TABLE achievements         DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_streak          DISABLE ROW LEVEL SECURITY;

-- Verify: every relrowsecurity should read `f` (false).
SELECT relname, relrowsecurity
FROM pg_class
WHERE relkind = 'r'
  AND relnamespace = 'public'::regnamespace
ORDER BY relname;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0009_add_user_id.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: multi-user auth (邮箱 + 密码) — user_id + RLS isolation
--
-- This is the architectural turn from a single-user app (RLS OFF, anon key
-- read/writes everything, see 0008) to a multi-user app where every row belongs
-- to exactly one `auth.users` account and RLS guarantees a user only ever sees
-- their own data.
--
-- WHAT THIS DOES
--   1. Wipes all pre-auth dev data — those rows have no owner and cannot be
--      backfilled (dev data is disposable, per the task brief).
--   2. Adds `user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE` to every
--      table.
--   3. Swaps the two GLOBAL unique constraints (monthly_budgets.month,
--      achievements.achievement_key) for PER-USER ones — otherwise two accounts
--      could never share the same month / badge key.
--   4. Re-enables RLS on every table and adds one "user_own" policy each
--      (USING + WITH CHECK = auth.uid() = user_id) so SELECT/INSERT/UPDATE/DELETE
--      are all scoped to the caller.
--   5. Marks the two helper views `security_invoker = on` so they run RLS as the
--      querying user instead of the view owner — without this a logged-in user
--      would read EVERY user's budget / wish pool through the view.
--
-- IDEMPOTENT — safe to re-run. Run it in Supabase Dashboard → SQL Editor.
-- Requires Postgres 15+ (Supabase default) for `security_invoker`.
--
-- ⚠️ Also disable email confirmation: Dashboard → Authentication → Providers →
--    Email → turn OFF "Confirm email", so signUp logs the user in immediately.

-- ─── 1. Wipe disposable pre-auth data ──────────────────────────────────────────
-- CASCADE handles FK-linked child rows; RESTART IDENTITY is a no-op here (all PKs
-- are uuid) but kept for completeness.
TRUNCATE TABLE
  review_results, review_tasks, price_records, price_tracks,
  savings_records, wish_pools, wishlist_items, impulse_records,
  transactions, execution_sessions, brand_library, sop_rules,
  subscriptions, achievements, user_streak, personal_principles,
  monthly_budgets, user_settings
RESTART IDENTITY CASCADE;

-- ─── 2. Add user_id everywhere ─────────────────────────────────────────────────
-- Tables are empty (just truncated), so a NOT NULL column with no default is fine.
ALTER TABLE user_settings        ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE monthly_budgets      ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE impulse_records      ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE wishlist_items       ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE wish_pools           ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE savings_records      ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE execution_sessions   ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE transactions         ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE sop_rules            ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE brand_library        ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE price_tracks         ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE price_records        ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE review_tasks         ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE review_results       ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE personal_principles  ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE subscriptions        ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE achievements         ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE user_streak          ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

-- ─── 3. Global → per-user unique constraints ───────────────────────────────────
-- monthly_budgets.month was UNIQUE globally; now one row per (user, month).
ALTER TABLE monthly_budgets DROP CONSTRAINT IF EXISTS monthly_budgets_month_key;
ALTER TABLE monthly_budgets DROP CONSTRAINT IF EXISTS monthly_budgets_user_month_key;
ALTER TABLE monthly_budgets ADD  CONSTRAINT monthly_budgets_user_month_key UNIQUE (user_id, month);

-- achievements.achievement_key was UNIQUE globally; now one row per (user, key).
-- The store upserts with onConflict 'user_id,achievement_key' to match this.
ALTER TABLE achievements DROP CONSTRAINT IF EXISTS achievements_achievement_key_key;
ALTER TABLE achievements DROP CONSTRAINT IF EXISTS achievements_user_key_key;
ALTER TABLE achievements ADD  CONSTRAINT achievements_user_key_key UNIQUE (user_id, achievement_key);

-- ─── 4. Re-enable RLS + one "user_own" policy per table ─────────────────────────
-- Reverses 0008's blanket DISABLE. The policy is applied to ALL commands, so it
-- governs SELECT (USING) plus INSERT/UPDATE (WITH CHECK) in one shot.

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON user_settings;
CREATE POLICY "user_own" ON user_settings USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE monthly_budgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON monthly_budgets;
CREATE POLICY "user_own" ON monthly_budgets USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE impulse_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON impulse_records;
CREATE POLICY "user_own" ON impulse_records USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE wishlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON wishlist_items;
CREATE POLICY "user_own" ON wishlist_items USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE wish_pools ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON wish_pools;
CREATE POLICY "user_own" ON wish_pools USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE savings_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON savings_records;
CREATE POLICY "user_own" ON savings_records USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE execution_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON execution_sessions;
CREATE POLICY "user_own" ON execution_sessions USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON transactions;
CREATE POLICY "user_own" ON transactions USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE sop_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON sop_rules;
CREATE POLICY "user_own" ON sop_rules USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE brand_library ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON brand_library;
CREATE POLICY "user_own" ON brand_library USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE price_tracks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON price_tracks;
CREATE POLICY "user_own" ON price_tracks USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE price_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON price_records;
CREATE POLICY "user_own" ON price_records USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE review_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON review_tasks;
CREATE POLICY "user_own" ON review_tasks USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE review_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON review_results;
CREATE POLICY "user_own" ON review_results USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE personal_principles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON personal_principles;
CREATE POLICY "user_own" ON personal_principles USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON subscriptions;
CREATE POLICY "user_own" ON subscriptions USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE achievements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON achievements;
CREATE POLICY "user_own" ON achievements USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE user_streak ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON user_streak;
CREATE POLICY "user_own" ON user_streak USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ─── 5. Views run RLS as the caller, not the owner ─────────────────────────────
-- Without this the JOINs in these views bypass the base-table RLS and leak every
-- user's rows. With security_invoker on, each view returns only the caller's data.
ALTER VIEW v_current_budget  SET (security_invoker = on);
ALTER VIEW v_active_wish_pool SET (security_invoker = on);

-- ─── Verify ────────────────────────────────────────────────────────────────────
-- Every table should now read relrowsecurity = t (true).
SELECT relname, relrowsecurity
FROM pg_class
WHERE relkind = 'r'
  AND relnamespace = 'public'::regnamespace
ORDER BY relname;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0010_add_monthly_stories.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 月度复盘故事 (monthly review story)
--
-- One AI-generated narrative per (user, month). The story text plus the
-- aggregated snapshot it was built from are stored together so the embedded
-- "问我这个月的事" chat can rebuild its context without re-querying, and so the
-- same month is never regenerated (UNIQUE (user_id, month)).
--
-- Follows the multi-user conventions from 0009: user_id NOT NULL → auth.users,
-- RLS ON with a single "user_own" policy governing all commands.
--
-- IDEMPOTENT — safe to re-run. Run it in Supabase Dashboard → SQL Editor.

CREATE TABLE IF NOT EXISTS monthly_stories (
  id          uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  month       text NOT NULL,              -- 'YYYY-MM' of the narrated month
  story       text NOT NULL,              -- AI-generated narrative
  persona_key text,                       -- persona label at generation time (nullable)
  snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- aggregated data used for the story + chat context
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One story per user per month; the store upserts on this key when regenerating.
ALTER TABLE monthly_stories DROP CONSTRAINT IF EXISTS monthly_stories_user_month_key;
ALTER TABLE monthly_stories ADD  CONSTRAINT monthly_stories_user_month_key UNIQUE (user_id, month);

ALTER TABLE monthly_stories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON monthly_stories;
CREATE POLICY "user_own" ON monthly_stories USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0011_price_track_platforms.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 蹲蹲（手动价格追踪）— extend platform enum + (idempotently) re-assert
-- user_id + RLS on price_tracks / price_records.
--
-- WHY
--   The 蹲蹲 feature lets a user manually log a product's price over time (from a
--   screenshot or a typed line like "耐克跑鞋现在599"). The AI infers the platform.
--   The original price_platform enum only had ('jd','official','taobao_manual'),
--   which doesn't cover the four buckets the UI surfaces: 淘宝 / 京东 / 得物 / 其他.
--
--   user_id + RLS on both tables already landed in 0009 (the multi-user turn); the
--   re-asserts below are IDEMPOTENT and exist only so this migration is
--   self-contained — safe to run on a DB that somehow predates 0009.
--
-- IDEMPOTENT — safe to re-run. Run in Supabase Dashboard → SQL Editor.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside the SAME transaction that then
--       USES the new value. These statements only ADD values, so a plain batch run
--       in the SQL editor is fine.

-- ─── 1. Extend the price_platform enum ─────────────────────────────────────────
-- Keep the legacy values for back-compat; add the four the app now writes.
ALTER TYPE price_platform ADD VALUE IF NOT EXISTS 'taobao';
ALTER TYPE price_platform ADD VALUE IF NOT EXISTS 'dewu';
ALTER TYPE price_platform ADD VALUE IF NOT EXISTS 'other';
-- 'jd' already exists from the original enum.

-- ─── 2. user_id (idempotent — already added in 0009) ───────────────────────────
ALTER TABLE price_tracks  ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE price_records ADD COLUMN IF NOT EXISTS user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE;

-- ─── 3. RLS + one "user_own" policy each (idempotent) ──────────────────────────
ALTER TABLE price_tracks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON price_tracks;
CREATE POLICY "user_own" ON price_tracks USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE price_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON price_records;
CREATE POLICY "user_own" ON price_records USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0012_add_usage_note.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 复盘「一句话说说？」— optional free-text note on a review result.
--
-- WHY
--   ReviewCard lets the user pick frequency + worthiness; this adds an optional
--   one-liner (e.g. 「穿了一次」) captured at the same time. The monthly story then
--   prefers this raw quote over the frequency-derived phrase when narrating.
--
-- RLS: review_results already has its "user_own" policy (migration 0009); a new
-- column is automatically covered by the table-level policy, so nothing else is
-- needed. The idempotent re-assert below just keeps this migration self-contained.
--
-- IDEMPOTENT — safe to re-run in Supabase Dashboard → SQL Editor.

ALTER TABLE review_results ADD COLUMN IF NOT EXISTS usage_note text;

ALTER TABLE review_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON review_results;
CREATE POLICY "user_own" ON review_results USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0013_clear_default_sop.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 删除执行层 SOP 的 5 条默认 seed 规则。
--
-- WHY
--   schema.sql 早期给 sop_rules 灌了 5 条示例规则（裤子 / 上衣 / 搜索决策 / 品牌优先 /
--   计时器）。它们是产品占位文案，不该出现在真实用户的执行清单里——执行层 SOP 应由
--   用户自己沉淀。这里按标题精确删除这 5 条；用户自建的规则不受影响。
--
--   只按这 5 个标题删除（而非清空整表），所以即便用户已经加了同名以外的自定义规则也安全。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。

DELETE FROM sop_rules
WHERE title IN ('裤子', '上衣', '搜索决策', '品牌优先', '计时器');


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0014_add_push_notifications.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: PWA 推送通知 — push_subscriptions 表 + user_settings 通知开关。
--
-- WHAT THIS DOES
--   1. push_subscriptions: 每个浏览器/设备的 Web Push 订阅。一个用户可有多条
--      (多设备)。endpoint 全局唯一，所以重新订阅同一设备走 upsert(onConflict
--      'endpoint') 覆盖而不堆积。subscription 存完整的 PushSubscription JSON，
--      Edge Function(send-reminders) 用它向 web-push 发推。RLS user_own：客户端
--      只能读写自己的订阅；Edge Function 用 service role 跳过 RLS 读取全部。
--   2. user_settings 三个通知开关(默认开)：关掉的类型 Edge Function 直接跳过。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。

-- ─── 1. push_subscriptions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON push_subscriptions;
CREATE POLICY "user_own" ON push_subscriptions
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ─── 2. user_settings 通知开关 ─────────────────────────────────────────────────
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_cooldown     boolean NOT NULL DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_subscription boolean NOT NULL DEFAULT true;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS notify_expiry       boolean NOT NULL DEFAULT true;


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0015_lazy_pack.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 懒人五件套 — 蹲蹲目标价 + AI 预算建议表。
--
-- WHAT THIS DOES
--   1. price_tracks.target_price：蹲蹲的「目标价」。用户填了之后，每次追加新价格
--      记录时若 新价 <= target_price，主页推「到价提醒」卡。base schema.sql 里这一列
--      早已存在；这里用 ADD COLUMN IF NOT EXISTS 兜底那些先于 schema.sql 建库的环境，
--      保持 migration 自包含、可重复执行。
--   2. monthly_budget_plans：AI 生成的「下月预算建议」。预算自动延续(功能2)会查这张
--      表：若当月已自动复制上月预算、且存在一条针对本月的 AI 建议，主页推一条轻量
--      提示卡让用户决定是否微调。目前没有写入方(留给后续 AI 任务)，先把表建好，使
--      客户端的查询在真实 Supabase 上不会因表缺失而报错。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。

-- ─── 1. 蹲蹲目标价 ──────────────────────────────────────────────────────────────
ALTER TABLE price_tracks ADD COLUMN IF NOT EXISTS target_price numeric(10,2);

-- ─── 2. AI 下月预算建议 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS monthly_budget_plans (
  id                  uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  month               text NOT NULL,           -- 建议针对的月份 'YYYY-MM'
  basic_life_limit    numeric(10,2),
  discretionary_limit numeric(10,2),
  reason              text,                     -- AI 给的一句话理由
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, month)
);

CREATE INDEX IF NOT EXISTS monthly_budget_plans_user_month_idx
  ON monthly_budget_plans (user_id, month);

ALTER TABLE monthly_budget_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_own" ON monthly_budget_plans;
CREATE POLICY "user_own" ON monthly_budget_plans
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0016_import_dedup.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 历史账单批量导入 — 去重唯一索引。
--
-- WHY
--   导入页用 upsert(onConflict 'user_id,date,amount,description', ignoreDuplicates)
--   写库，反复导入同一份微信/支付宝账单不会产生重复记录。Postgres 的 ON CONFLICT
--   需要一个匹配这些列的唯一索引来推断冲突目标，这里把它建出来。
--   description 为 NULL 时 Postgres 视为互不冲突；导入记录的 description 始终有值。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。

-- ─── 1. 去重唯一索引 ────────────────────────────────────────────────────────────
create unique index if not exists transactions_import_dedup_idx
  on transactions (user_id, date, amount, description);

-- ─── 2. source 允许 'import' ────────────────────────────────────────────────────
alter table transactions drop constraint if exists transactions_source_check;
alter table transactions add constraint transactions_source_check
  check (source in ('screenshot', 'text', 'import'));


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0018_import_dedup_constraint.sql
-- ████████████████████████████████████████████████████████████████████████████

-- 把导入去重的唯一性从「unique 索引」升级为「具名 UNIQUE 约束」，对应
-- upsert(onConflict 'user_id,date,amount,description')。修复老库报错：
--   there is no unique or exclusion constraint matching the ON CONFLICT specification
-- IDEMPOTENT — 可重复执行。

drop index if exists transactions_import_dedup_idx;

alter table transactions drop constraint if exists transactions_import_dedup_key;
alter table transactions add constraint transactions_import_dedup_key
  unique (user_id, date, amount, description);


-- ████████████████████████████████████████████████████████████████████████████
-- ██  MIGRATION  —  0019_wishlist_detail.sql
-- ████████████████████████████████████████████████████████████████████████████

-- Migration: 待购详情页 — wishlist_items 扩展字段 + 商品图片 Storage bucket。
--
-- WHAT THIS DOES
--   1. wishlist_items 加 7 列：image_url(主图) / brand(品牌) / fabric(面料成分) /
--      color(颜色) / size(尺码) / channel(购买渠道) / notes(备注)。详情页展示并支持
--      内联编辑；AI 截图解析也会回填这些字段。
--   2. 建一个 public 读、登录用户写自己目录的 Storage bucket：wishlist-images。
--      详情页上传的商品截图存到 wishlist-images/{user_id}/{item_id}/{timestamp}，
--      路径第一段必须等于 auth.uid()，保证用户只能写/改/删自己的图。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。

-- ─── 1. wishlist_items 扩展字段 ──────────────────────────────────────────────────
ALTER TABLE wishlist_items
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS brand     TEXT,
  ADD COLUMN IF NOT EXISTS fabric    TEXT,
  ADD COLUMN IF NOT EXISTS color     TEXT,
  ADD COLUMN IF NOT EXISTS size      TEXT,
  ADD COLUMN IF NOT EXISTS channel   TEXT,
  ADD COLUMN IF NOT EXISTS notes     TEXT;

-- ─── 2. 商品图片 Storage bucket ──────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('wishlist-images', 'wishlist-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS "wishlist_images_public_read" ON storage.objects;
CREATE POLICY "wishlist_images_public_read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'wishlist-images');

DROP POLICY IF EXISTS "wishlist_images_insert_own" ON storage.objects;
CREATE POLICY "wishlist_images_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'wishlist-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "wishlist_images_update_own" ON storage.objects;
CREATE POLICY "wishlist_images_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'wishlist-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "wishlist_images_delete_own" ON storage.objects;
CREATE POLICY "wishlist_images_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'wishlist-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

