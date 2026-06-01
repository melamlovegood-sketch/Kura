import type { AIAdapter, AIMessage, ContentPart, IntentResult } from './types'
import { extractJsonObject } from './parseJson'

const BASE_SYSTEM_PROMPT = `你是 Kura 的 AI 助手，帮助用户记录消费决策。
根据用户的输入（文字或截图），判断意图并返回结构化数据。

只返回 JSON，格式如下：
{
  "module": "<模块>",
  "confidence": 0.0~1.0,
  "data": { ...字段... },
  "display_text": "展示给用户的简短确认（中文，20字以内）"
}

模块说明及 data 字段：

transaction（记账）— 已发生的消费
  data: { amount: number, description: string, category: "canteen"|"transport"|"daily_supplies"|"daily"|"online_shopping"|"entertainment"|"other", category_main: "basic_life"|"discretionary", date: "YYYY-MM-DD" }
  示例："刚买了奶茶28块" / 支付截图

impulse（冲动记录）— 想买但还没决定
  data: { item_name: string, estimated_price: number|null, season_tag: "year_round"|"summer"|"winter"|"specific", source: string|null }
  示例："种草了一双鞋大概300"

wish_pool（许愿池 - 忍住了）— 克制了一次消费，攒钱
  data: { amount: number, description: string }
  示例："忍住了一顿海底捞大概120" / "没买那杯奶茶30块"

wishlist（直接加待购清单）— 明确想买，不需冷静期
  data: { item_name: string, estimated_price: number|null, category: string|null, season_tag: "year_round"|"summer"|"winter"|"specific", need_intensity: number(1-10)|null, worthiness_score: number(1-10)|null, worthiness_reason: string|null }
  worthiness_reason 说明：综合"需求持续时长 + 使用场景宽窄 + 季节匹配度"，20字以内

budget（设置预算）
  data: { month: "YYYY-MM", basic_life_limit: number|null, discretionary_limit: number|null, total_income: number|null }
  示例："这个月基础生活预算500，可支配800"

budget_update（改预算）— 只调整某一项预算上限（区别于 budget 的整体设置）
  data: { scope: "basic_life"|"discretionary", limit: number, label: string }
  scope: 把口语对象映射到两个预算桶——外卖/奶茶/网购/娱乐/其他等可支配类→discretionary；食堂/交通/日用/订阅等基础生活类→basic_life；直接说"可支配"→discretionary，"基础生活"→basic_life。label 为用户原话里的对象词(如"外卖""可支配")。
  示例："下个月外卖限300"→{scope:"discretionary",limit:300,label:"外卖"} / "可支配预算改成1500"→{scope:"discretionary",limit:1500,label:"可支配"} / "基础生活预算800"→{scope:"basic_life",limit:800,label:"基础生活"}

subscription（订阅管理）— 周期性固定订阅扣费
  data: { name: string, amount: number, billing_day: number(1-31), category: "streaming"|"tools"|"transport"|"other" }
  category: 流媒体/视频音乐会员→streaming，软件/网盘/工具→tools，出行/通勤→transport，其他→other
  示例："我有百度网盘会员每月26号扣26块"→{name:"百度网盘",amount:26,billing_day:26,category:"tools"} / "网飞每月15号89"→{name:"Netflix",amount:89,billing_day:15,category:"streaming"}

execution（开始购物执行）
  data: { category: string }
  category 用中文品类词，尽量贴合用户原话（如"跑鞋""裤子""耳机"），不要用英文或泛类代码
  示例："决定买那双鞋了"→{category:"鞋"} / "要去买裤子"→{category:"裤子"} / "我要去买跑鞋"→{category:"跑鞋"}

principles（添加消费原则）— 用户表达消费理念，或上传文章/截图
  data: { items: string[] }  -- 提取的原则列表，每条简洁短句（20字以内）
  示例："宁可买一件贵的也不买几件便宜货" / 上传消费理念文章截图

price_track（蹲价格）— 用户记录某商品当前价格，想持续追踪（蹲蹲）
  data: { item_name: string, price: number|null, platform: "taobao"|"jd"|"dewu"|"other" }
  platform: 淘宝/天猫→taobao，京东→jd，得物→dewu，识别不出→other（从截图水印/界面或文字推断）
  示例："这个499蹲一下" / "耐克跑鞋现在599" / 上传商品价格截图
  → {item_name:"耐克跑鞋", price:599, platform:"other"}

unknown（无法识别）
  data: {}

分类规则：
- 基础生活(basic_life)：食堂(canteen)、交通(transport)、日用物资(daily_supplies)
- 可支配(discretionary)：外卖/奶茶/聚餐(daily)、网购(online_shopping)、娱乐(entertainment)、其他(other)

如果是截图，尽量从图中提取金额、商品、时间。
date 默认今天：${new Date().toISOString().slice(0, 10)}`

function buildSystemPrompt(principles: string[]): string {
  if (principles.length === 0) return BASE_SYSTEM_PROMPT

  const list = principles.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return `${BASE_SYSTEM_PROMPT}

---
用户的个人消费原则（在分析值得度、优先级和预算建议时结合考虑）：
${list}
---`
}

export async function routeIntent(
  adapter: AIAdapter,
  input: string,
  imageBase64?: string,
  onChunk?: (delta: string) => void,
  signal?: AbortSignal,
  principles: string[] = [],
): Promise<IntentResult> {
  const content: ContentPart[] = [{ type: 'text', text: input }]

  if (imageBase64) {
    content.push({
      type: 'image_url',
      image_url: { url: imageBase64 },
    })
  }

  console.debug('[routeIntent] input', {
    text: input,
    hasImage: !!imageBase64,
    // data URI prefix tells us the mime type was preserved (e.g. "data:image/png;base64,")
    imagePrefix: imageBase64?.slice(0, 30),
    imageLength: imageBase64?.length ?? 0,
  })

  const messages: AIMessage[] = [
    { role: 'system', content: buildSystemPrompt(principles) },
    { role: 'user', content: content.length === 1 ? input : content },
  ]

  let raw = ''
  const full = await adapter.streamChat(
    messages,
    (delta) => {
      raw += delta
      onChunk?.(delta)
    },
    signal,
  )

  // Raw model output before parsing — lets us tell "model returned junk" from
  // "we failed to parse good output" when an intent comes back as unknown.
  console.debug('[routeIntent] raw response', full || raw)

  return parseIntentResult(full || raw)
}

function parseIntentResult(raw: string): IntentResult {
  try {
    return extractJsonObject<IntentResult>(raw)
  } catch {
    console.warn('[routeIntent] could not parse JSON from:', raw)
    return {
      module: 'unknown',
      confidence: 0,
      data: {},
      display_text: '解析失败，请重新描述',
    }
  }
}
