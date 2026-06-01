-- 0017_review_tag.sql
-- 复盘页「后悔榜 / 值得榜」：在交易上手动标记一笔是否后悔 / 值得。
-- review_tag = 'regret'（后悔）| 'worth'（值得）| NULL（未标记）。
-- 手动在 Supabase SQL editor 执行一次即可。

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS review_tag text
  CHECK (review_tag IN ('regret', 'worth'));

-- 标记筛选会按月 + tag 过滤，给个轻量索引（可选）。
CREATE INDEX IF NOT EXISTS idx_transactions_review_tag
  ON transactions (review_tag)
  WHERE review_tag IS NOT NULL;
