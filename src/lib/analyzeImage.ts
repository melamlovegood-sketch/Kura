/**
 * Shared client helper for screenshot → product-field extraction.
 *
 * Posts the image to our Cloudflare Pages Function (/api/analyze-image), which
 * proxies the Qwen vision API (dashscope) server-side — dashscope can't be called
 * directly from the browser (CORS / network block in mainland China). The user's
 * own API key (from Settings) is passed in the request body; there is no
 * server-side secret.
 *
 * Used by the home 「我现在想买」dialog and the 待购详情页「上传截图让 AI 填写」flow.
 */

/** File → bare base64 (no `data:…;base64,` prefix), which the function expects. */
const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })

// qwen-vl-plus is inconsistent about the JSON keys it returns: sometimes the
// English keys we asked for, sometimes the Chinese hints from the prompt template
// ("商品名称" etc.), sometimes camelCase. When the keys don't match, every field
// maps to null and the UI shows 未填写 across the board even though the call
// "succeeded". So we normalize the raw object to canonical English keys via a
// generous alias table before anyone reads it.
const FIELD_ALIASES: Record<string, string[]> = {
  name: ['name', 'title', 'product_name', 'productname', 'item_name', 'itemname', '商品名称', '名称', '品名', '商品名', '商品'],
  brand: ['brand', '品牌', '牌子'],
  price: ['price', 'amount', '价格', '价', '售价', '金额', '单价'],
  category: ['category', 'type', '分类', '品类', '类别', '类目'],
  fabric: ['fabric', 'material', '面料', '面料成分', '材质', '成分'],
  color: ['color', 'colour', '颜色', '色'],
  size: ['size', '尺码', '尺寸', '规格'],
  channel: ['channel', 'platform', 'source', '渠道', '购买渠道', '平台', '商家', '店铺'],
  is_product_photo: ['is_product_photo', 'isproductphoto', 'is_main_photo', '是否主图', '是否商品主图', '主图'],
}

function normalizeProductFields(raw: Record<string, unknown>): Record<string, unknown> {
  // Case-insensitive lookup of the raw keys (Chinese is unaffected by toLowerCase).
  const lookup = new Map<string, unknown>()
  for (const [k, v] of Object.entries(raw)) lookup.set(k.toLowerCase().trim(), v)

  const out: Record<string, unknown> = {}
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const v = lookup.get(alias.toLowerCase())
      if (v !== undefined) { out[canonical] = v; break }
    }
  }
  out.is_product_photo = toBool(out.is_product_photo)
  return out
}

/**
 * Send a screenshot to the vision model and return the normalized fields object
 * ({ name, brand, price, category, fabric, color, size, channel,
 * is_product_photo }) with canonical English keys. Throws on a network failure or
 * when the model output can't be parsed as JSON. Aborts cleanly when the signal
 * fires.
 */
export async function analyzeImage(
  file: File,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const base64 = await toBase64(file)
  const res = await fetch('/api/analyze-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64, mimeType: file.type, apiKey }),
    signal,
  })
  const data = (await res.json()) as
    | { ok: true; fields: unknown }
    | { ok: false; raw?: string; error?: string }

  // Surface the raw server payload so a "succeeded but empty" result is diagnosable.
  console.log('[analyzeImage] server response:', JSON.stringify(data))

  if (!data.ok) {
    throw new Error('解析失败: ' + (data.raw ?? data.error ?? ''))
  }

  // The function returns a parsed object, but guard against a double-encoded
  // string just in case.
  let fields = data.fields
  if (typeof fields === 'string') {
    try { fields = JSON.parse(fields) } catch { /* leave as-is */ }
  }
  if (!fields || typeof fields !== 'object') {
    throw new Error('解析失败: 返回内容不是对象')
  }

  const normalized = normalizeProductFields(fields as Record<string, unknown>)
  console.log('[analyzeImage] normalized fields:', JSON.stringify(normalized))
  return normalized
}

/** Trim a value to a non-empty string, treating "null"/empty as null. */
export function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.toLowerCase() !== 'null' ? t : null
}

/** Coerce to a positive finite number, pulling the number out of e.g. "¥599 元". */
export function numOrNull(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null
  if (typeof v === 'string') {
    const m = v.replace(/[,，\s]/g, '').match(/\d+(\.\d+)?/)
    if (m) {
      const n = Number(m[0])
      return Number.isFinite(n) && n > 0 ? n : null
    }
  }
  return null
}

function toBool(v: unknown): boolean {
  if (v === true || v === 1) return true
  if (typeof v === 'string') return ['true', 'yes', '是', '1'].includes(v.trim().toLowerCase())
  return false
}
