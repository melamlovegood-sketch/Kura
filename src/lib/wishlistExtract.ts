import { fileToBase64 } from '@/lib/utils'

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

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.toLowerCase() !== 'null' ? t : null
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Send a screenshot to the Qwen vision model through our Cloudflare Pages Function
 * (functions/api/analyze-image.ts) and parse the extracted product fields. The
 * function proxies dashscope server-side (so it works in mainland China) using the
 * user's own API key, which we pass in the request body. Throws if the model
 * output can't be parsed.
 */
export async function extractWishlistFields(
  apiKey: string,
  file: File,
  signal?: AbortSignal,
): Promise<ExtractedWishlistFields> {
  // The function expects bare base64 + mimeType; fileToBase64 returns a full
  // data URI (data:<mime>;base64,<data>), so strip the prefix.
  const dataUri = await fileToBase64(file)
  const base64 = dataUri.split(',')[1] ?? ''

  const res = await fetch('/api/analyze-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64, mimeType: file.type, apiKey }),
    signal,
  })

  const data = (await res.json()) as
    | { ok: true; fields: Record<string, unknown> }
    | { ok: false; raw?: string; error?: string }

  if (!data.ok) {
    console.warn('[extractWishlistFields] analyze-image failed:', data)
    throw new Error('AI 没能识别出商品信息，换张更清晰的截图试试')
  }

  const parsed = data.fields
  return {
    name: strOrNull(parsed.name),
    brand: strOrNull(parsed.brand),
    price: numOrNull(parsed.price),
    category: strOrNull(parsed.category),
    fabric: strOrNull(parsed.fabric),
    color: strOrNull(parsed.color),
    size: strOrNull(parsed.size),
    channel: strOrNull(parsed.channel),
    is_product_photo: parsed.is_product_photo === true,
  }
}
