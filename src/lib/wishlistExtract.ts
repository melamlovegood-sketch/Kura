import type { AIAdapter, AIMessage, ContentPart } from '@/lib/ai/types'
import { extractJsonObject } from '@/lib/ai/parseJson'

/**
 * Fields the vision model pulls out of a product screenshot for the 待购详情页
 * 「上传截图让 AI 填写」flow. Every field is null when the model can't find it in
 * the image, so the caller can update *only* the fields that came back non-null
 * and never clobber what the user already typed.
 *
 * `is_product_photo` is our own addition to the prompt: the model can't return a
 * URL for the image, so instead it tells us whether the screenshot is a main
 * product photo (vs. a hangtag / fabric label / price page). When true, the caller
 * promotes the just-uploaded image to the item's `image_url`.
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

const SYSTEM_PROMPT = `你是一个商品信息提取助手。分析用户上传的截图（可能是商品页、购物车截图、小红书截图、吊牌、面料标签等），提取以下字段并以 JSON 格式返回。如果某字段在图中找不到，返回 null。

仅返回 JSON，不要任何其他文字或 markdown 代码块：
{
  "name": "商品名称",
  "brand": "品牌",
  "price": 数字或null,
  "category": "分类",
  "fabric": "面料成分，如 90%棉 10%涤纶",
  "color": "颜色",
  "size": "尺码",
  "channel": "购买渠道或平台",
  "is_product_photo": true或false
}

is_product_photo：如果这张图是商品主图（清晰展示商品本身的照片），返回 true；如果是吊牌、面料标签、价格页、订单截图等非主图，返回 false。`

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
 * Send a screenshot to the configured vision model and parse the extracted product
 * fields. Throws if the model output can't be parsed as JSON.
 */
export async function extractWishlistFields(
  adapter: AIAdapter,
  imageBase64: string,
  signal?: AbortSignal,
): Promise<ExtractedWishlistFields> {
  const content: ContentPart[] = [
    { type: 'text', text: '请分析这张商品截图，按要求只返回 JSON。' },
    { type: 'image_url', image_url: { url: imageBase64 } },
  ]
  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ]

  // Step 1 — confirm we're actually handing the model image bytes, not an empty
  // or malformed string. A data URI must look like "data:image/…;base64,…".
  console.debug('[extractWishlistFields] image', {
    prefix: imageBase64.slice(0, 100),
    length: imageBase64.length,
    looksLikeDataUri: /^data:image\/[^;]+;base64,/.test(imageBase64),
  })

  let raw = ''
  await adapter.streamChat(messages, (delta) => { raw += delta }, signal)

  // Step 2 — the raw model output, before any parsing. If fields come back empty,
  // this tells us whether the model returned nulls (can't see image) vs. returned
  // good data we then failed to parse.
  console.debug('[extractWishlistFields] raw response', raw)

  let parsed: Record<string, unknown>
  try {
    parsed = extractJsonObject(raw)
  } catch {
    console.warn('[extractWishlistFields] could not parse JSON from:', raw)
    throw new Error('AI 没能识别出商品信息，换张更清晰的截图试试')
  }
  console.debug('[extractWishlistFields] parsed', parsed)

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
