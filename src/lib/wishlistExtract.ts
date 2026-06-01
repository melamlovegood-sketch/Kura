import { analyzeImage, strOrNull, numOrNull } from '@/lib/analyzeImage'

/**
 * Fields the vision model pulls out of a product screenshot for the 待购详情页
 * 「上传截图让 AI 填写」flow. Every field is null when the model can't find it in
 * the image, so the caller can update *only* the fields that came back non-null
 * and never clobber what the user already typed.
 *
 * `is_product_photo` tells us whether the screenshot is a main product photo (vs.
 * a hangtag / fabric label / price page); when true, the caller promotes the
 * just-uploaded image to the item's `image_url`.
 */
export interface ExtractedWishlistFields {
  name: string | null
  brand: string | null
  price: number | null
  category: string | null
  fabric: string | null
  color: string | null
  size: string | null
  channel: string | null
  is_product_photo: boolean
}

/**
 * Send a screenshot to the Qwen vision model through our Cloudflare Pages Function
 * (/api/analyze-image) and parse the extracted product fields. The function
 * proxies dashscope server-side (so it works in mainland China) using the user's
 * own API key, passed in the request body. Throws a friendly error when the model
 * can't return usable fields.
 */
export async function extractWishlistFields(
  apiKey: string,
  file: File,
  signal?: AbortSignal,
): Promise<ExtractedWishlistFields> {
  let fields: Record<string, unknown>
  try {
    fields = await analyzeImage(file, apiKey, signal)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    console.warn('[extractWishlistFields] analyze-image failed:', e)
    throw new Error('AI 没能识别出商品信息，换张更清晰的截图试试')
  }

  return {
    name: strOrNull(fields.name),
    brand: strOrNull(fields.brand),
    price: numOrNull(fields.price),
    category: strOrNull(fields.category),
    fabric: strOrNull(fields.fabric),
    color: strOrNull(fields.color),
    size: strOrNull(fields.size),
    channel: strOrNull(fields.channel),
    is_product_photo: fields.is_product_photo === true,
  }
}
