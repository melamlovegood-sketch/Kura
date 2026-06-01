import { supabase } from '@/lib/supabase'
import { isGuestMode } from '@/lib/guestMode'
import { getCurrentUserId } from '@/lib/auth'
import { fileToBase64 } from '@/lib/utils'
import { compressImage } from '@/lib/compressImage'

const BUCKET = 'wishlist-images'

/**
 * Compress a wishlist product screenshot and upload it, returning a URL the detail
 * page can render from `<img src>`. The image is always downscaled to a small JPEG
 * first (phone photos are huge), so the stored object is `…/{timestamp}.jpg`.
 *
 * Signed-in: uploads to `wishlist-images/{user_id}/{item_id}/{timestamp}.jpg` (the
 * leading {user_id} folder is what the Storage RLS policy in migration 0019 keys
 * on) and returns the public CDN URL.
 *
 * Guest mode: there is no Supabase Storage, so we inline the (compressed) image as
 * a base64 data URI. It still renders, and it lives in the same localStorage shim
 * as the rest of the guest's data.
 */
export async function uploadWishlistImage(file: Blob, itemId: string): Promise<string> {
  const blob = await compressImage(file)
  // compressImage normally returns JPEG; on the HEIC fallback it returns the
  // original blob, so derive the extension/content-type from the actual type.
  const type = blob.type || 'image/jpeg'
  const ext = (type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg'

  if (isGuestMode()) return fileToBase64(blob)

  const userId = await getCurrentUserId()
  const path = `${userId}/${itemId}/${Date.now()}.${ext}`

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: type,
    upsert: true,
  })
  if (error) throw new Error(`图片上传失败：${error.message}`)

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}
