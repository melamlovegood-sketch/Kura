import { supabase } from '@/lib/supabase'
import { isGuestMode } from '@/lib/guestMode'
import { getCurrentUserId } from '@/lib/auth'
import { fileToBase64 } from '@/lib/utils'

const BUCKET = 'wishlist-images'

/**
 * Upload a wishlist product screenshot and return a URL the detail page can render
 * from `<img src>`.
 *
 * Signed-in: uploads to `wishlist-images/{user_id}/{item_id}/{timestamp}.ext` (the
 * leading {user_id} folder is what the Storage RLS policy in migration 0019 keys
 * on) and returns the public CDN URL.
 *
 * Guest mode: there is no Supabase Storage, so we inline the image as a base64 data
 * URI. It still renders, and it lives in the same localStorage shim as the rest of
 * the guest's data.
 */
export async function uploadWishlistImage(file: File, itemId: string): Promise<string> {
  if (isGuestMode()) return fileToBase64(file)

  const userId = await getCurrentUserId()
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  const path = `${userId}/${itemId}/${Date.now()}.${ext}`

  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'image/jpeg',
    upsert: true,
  })
  if (error) throw new Error(`图片上传失败：${error.message}`)

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}
