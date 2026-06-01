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

/**
 * Send a screenshot to the vision model and return the raw extracted fields
 * object ({ name, brand, price, category, fabric, color, size, channel,
 * is_product_photo }). Throws on a network failure or when the model output
 * can't be parsed as JSON. Aborts cleanly when the signal fires.
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
    | { ok: true; fields: Record<string, unknown> }
    | { ok: false; raw?: string; error?: string }
  if (data.ok) return data.fields
  throw new Error('解析失败: ' + (data.raw ?? data.error ?? ''))
}

/** Trim a value to a non-empty string, treating "null"/empty as null. */
export function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t && t.toLowerCase() !== 'null' ? t : null
}

/** Coerce to a positive finite number, else null. */
export function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
