-- 0018_import_dedup_constraint.sql
-- 历史账单批量导入 — 把去重唯一性升级为「具名 UNIQUE 约束」。
--
-- WHY
--   导入页用 upsert(onConflict 'user_id,date,amount,description', ignoreDuplicates)
--   写库（src/pages/ImportHistory.tsx）。Postgres 的 ON CONFLICT 需要一个匹配这些列的
--   唯一约束 / 唯一索引来推断冲突目标，否则报：
--     there is no unique or exclusion constraint matching the ON CONFLICT specification
--
--   0016 用的是 unique INDEX（transactions_import_dedup_idx），功能上够用；但若某个库
--   是在 0016 之前建的，就没有这个对象，导入必然报上面的错。这里改用「具名 UNIQUE 约束」：
--     · 直接对应 onConflict 的四列，ON CONFLICT 可正常推断；
--     · 在 information_schema.table_constraints 里可见，便于排查；
--     · 无论 0016 跑没跑过，本迁移都把状态收敛到「有这个约束」。
--
-- 注意：去重键是 (user_id, date, amount, description) 四列组合，本表没有 wx_order_id /
--   order_no 之类的单列订单号；description 为 NULL 时 Postgres 视为互不冲突，导入记录的
--   description 始终有值。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。
-- 手动在 SQL editor 执行一次即可。

-- 1. 删掉 0016 留下的 unique 索引（若存在），避免和下面的约束重复。
drop index if exists transactions_import_dedup_idx;

-- 2. 加上具名 UNIQUE 约束（先 drop 保证幂等）。
alter table transactions drop constraint if exists transactions_import_dedup_key;
alter table transactions add constraint transactions_import_dedup_key
  unique (user_id, date, amount, description);
