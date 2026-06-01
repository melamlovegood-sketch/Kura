/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Pages Function — extract product fields from a screenshot via the
 * Qwen vision model (dashscope), proxied server-side so it works from mainland
 * China (a direct browser call to dashscope fails with ERR_CONNECTION_CLOSED).
 *
 * The user's own dashscope API key is passed in the request body (entered in the
 * app's Settings, stored locally) — there is no server-side secret / env var.
 *
 * Powers the 待购详情页「上传截图让 AI 填写」flow. Returns { ok: true, fields }
 * on success, or { ok: false, raw } when the model's reply can't be parsed as
 * JSON so the caller can surface a useful error.
 */

const DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

const PROMPT = `分析这张商品截图（可能是商品页、购物车、小红书截图、吊牌、面料标签等），提取以下字段并仅返回 JSON，不要任何其他文字或 markdown 代码块：
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
如果某字段在图中找不到返回 null。is_product_photo：如果这张图是清晰展示商品本身的主图返回 true；如果是吊牌、面料标签、价格页、订单截图等非主图返回 false。`

interface AnalyzeImageBody {
  base64?: string
  mimeType?: string
  apiKey?: string
}

export const onRequestPost: PagesFunction = async (context) => {
  const { base64, mimeType, apiKey } = await context.request.json<AnalyzeImageBody>()

  if (!apiKey) return json({ ok: false, error: '缺少 API Key（请在设置里填写）' }, 401)
  if (!base64) return json({ ok: false, error: '缺少图片数据' }, 400)

  const response = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'qwen-vl-plus',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64}` },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    return json({ ok: false, error: `dashscope ${response.status}: ${err}` }, 502)
  }

  const data = await response.json<{
    choices?: { message?: { content?: unknown } }[]
  }>()
  const raw = data.choices?.[0]?.message?.content
  // qwen-vl can return content as a string or an array of parts — coalesce both.
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw
            .map((p: { text?: string } | string) => (typeof p === 'string' ? p : p?.text ?? ''))
            .join('')
        : ''
  const clean = text.replace(/```json|```/g, '').trim()

  try {
    return json({ ok: true, fields: JSON.parse(clean) })
  } catch {
    return json({ ok: false, raw: text })
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
