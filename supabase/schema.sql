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
  -- 复盘标记：'regret' 后悔 / 'worth' 值得 / NULL 未标记（migration 0017）
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
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- 蹲蹲详情页（迁移 0020）：主图 + 品牌，复用待购的截图上传 + AI 填写流程。
  image_url        text,
  brand            text
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
