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
-- public=true → 详情页可直接用 getPublicUrl 拿到 CDN 地址渲染主图，无需签名。
INSERT INTO storage.buckets (id, name, public)
VALUES ('wishlist-images', 'wishlist-images', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- 公共读（兜底；public bucket 本身已可经 CDN 公开读取）。
DROP POLICY IF EXISTS "wishlist_images_public_read" ON storage.objects;
CREATE POLICY "wishlist_images_public_read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'wishlist-images');

-- 登录用户只能写到以自己 uid 命名的顶层目录：{user_id}/...
DROP POLICY IF EXISTS "wishlist_images_insert_own" ON storage.objects;
CREATE POLICY "wishlist_images_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'wishlist-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 同理只能改/删自己目录下的图（替换主图、删除条目时清理）。
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
