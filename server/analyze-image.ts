import { json, fetchDashscope } from './dashscope-http.js'

const PROMPT = `这是一张电商商品页面的截图。

第一步：读取图片中所有可见文字。
第二步：从文字中提取以下字段。

严格规则：
- 只从文字中提取，不要根据图片画面猜测
- 如果图片里有价格数字，必须提取
- 如果图片里有品牌名或店铺名，必须提取
- 如果图片里有商品标题文字，必须作为 name 字段
- 绝对不允许根据图片外观描述商品（如"织物展示牌"、"墙纸"等）

仅返回 JSON，不要任何其他文字或 markdown：
{
  "name": "商品标题文字",
  "brand": "品牌名或店铺名",
  "price": 价格数字或null,
  "category": "分类",
  "fabric": "面料成分文字",
  "color": "颜色文字",
  "size": "尺码文字",
  "channel": "平台名称",
  "is_product_photo": true或false
}
找不到的字段返回 null。`

interface AnalyzeImageBody {
  base64?: string
  mimeType?: string
  apiKey?: string
}

export async function handleAnalyzeImage(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ ok: false, error: '请使用 POST 请求' }, 405)
  let body: AnalyzeImageBody
  try {
    body = await request.json() as AnalyzeImageBody
    if (!body || typeof body !== 'object') throw new Error('invalid body')
  } catch {
    return json({ ok: false, error: '请求内容必须是 JSON 对象' }, 400)
  }
  const { base64, mimeType, apiKey } = body

  if (typeof apiKey !== 'string' || !apiKey.trim()) return json({ ok: false, error: '缺少 API Key（请在设置里填写）' }, 401)
  if (typeof base64 !== 'string' || !base64.trim()) return json({ ok: false, error: '缺少图片数据' }, 400)

  const response = await fetchDashscope({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: 'qwen-vl-plus',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${typeof mimeType === 'string' ? mimeType : 'image/jpeg'};base64,${base64}` },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
    signal: request.signal,
  })

  if (!response.ok) {
    const err = await response.text()
    return json({ ok: false, error: `dashscope ${response.status}: ${err}` }, response.status)
  }

  const data = await response.json() as {
    choices?: { message?: { content?: unknown } }[]
  }
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

