import type { AIAdapter, IntentResult } from '@/lib/ai/types'
import { routeIntent } from '@/lib/ai/router'

export interface ParsedProduct {
  item_name: string
  estimated_price: number | null
}

/**
 * Pull a buyable product out of whatever the intent router returned. The router
 * may classify a "想买 X" input as impulse / wishlist / execution / transaction /
 * unknown — each uses slightly different field names — so we coalesce, falling
 * back to the raw text so the caller always gets a usable item name even on a
 * low-confidence parse.
 */
export function extractProduct(result: IntentResult, fallbackText: string): ParsedProduct {
  const d = result.data as Record<string, unknown>
  const name = [d.item_name, d.description, d.category, fallbackText]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find((v) => v.length > 0) ?? fallbackText
  // `price` covers the price_track module, whose data carries the amount under
  // that key — so a "耐克跑鞋599" input still yields a price on the buy/wishlist exits.
  const priceRaw = d.estimated_price ?? d.amount ?? d.price
  const price = typeof priceRaw === 'number' && priceRaw > 0 ? priceRaw : null
  return { item_name: name, estimated_price: price }
}

/**
 * Instruction handed to the vision model when the user uploaded a screenshot but
 * typed no text. Previously the literal placeholder「（图片输入）」was sent as the
 * prompt (and, when the parse came back empty, written straight to the database as
 * the item name) — so an image-only add silently saved「（图片输入）」instead of the
 * real product. Now we tell the model to read the product out of the image.
 */
const IMAGE_EXTRACT_PROMPT =
  '请仔细识别这张截图里的商品信息（名称、品牌、价格、品类等），把它当作我想买的东西来解析。'

/**
 * Run the AI dialog parse (free text + optional screenshot) and reduce it to a
 * single product. Shared by the home buy-drawer and the execution recording
 * layer so both get identical parsing behaviour.
 */
export async function parseProduct(
  adapter: AIAdapter,
  text: string,
  imageBase64?: string,
  signal?: AbortSignal,
  principles: string[] = [],
): Promise<ParsedProduct> {
  const trimmed = text.trim()
  if (!trimmed && !imageBase64) throw new Error('请输入文字或上传截图')

  // Image-only input → give the model a real extraction instruction instead of a
  // placeholder. The fallback name stays the (possibly empty) user text, never the
  // placeholder, so a failed parse surfaces an error rather than polluting the DB.
  const input = trimmed || IMAGE_EXTRACT_PROMPT
  const result = await routeIntent(adapter, input, imageBase64, undefined, signal, principles)
  const product = extractProduct(result, trimmed)

  if (!product.item_name.trim()) {
    throw new Error('没能从截图里识别出商品，换张更清晰的图，或补一句文字描述')
  }
  return product
}
