-- Migration: 蹲蹲详情页 — price_tracks 扩展字段（主图 + 品牌 + 目标价兜底）。
--
-- WHAT THIS DOES
--   蹲蹲详情 sheet 复用待购的截图上传 + AI 填写流程，因此 price_tracks 也要能存
--   主图(image_url)和品牌(brand)。target_price 在 base schema.sql / 0015 已存在，
--   这里用 ADD COLUMN IF NOT EXISTS 兜底先于它们建库的环境，保持自包含可重复执行。
--
--   主图复用 wishlist-images Storage bucket（migration 0019 创建）：上传路径为
--   wishlist-images/{user_id}/{track_id}/{timestamp}.jpg，RLS 只校验第一段 = uid，
--   所以 track_id 作为目录段同样合法，无需新建 bucket。
--
--   AI 截图解析对蹲蹲只回填 name / brand / image_url —— 价格是手动追踪的，绝不让
--   AI 改价格字段。
--
-- IDEMPOTENT — 可在 Supabase Dashboard → SQL Editor 重复执行。

ALTER TABLE price_tracks
  ADD COLUMN IF NOT EXISTS target_price numeric(10,2),
  ADD COLUMN IF NOT EXISTS image_url    text,
  ADD COLUMN IF NOT EXISTS brand        text;
