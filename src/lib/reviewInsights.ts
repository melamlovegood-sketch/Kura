/**
 * 复盘页的 AI 文本 — 消费人格（④）与分类对比一句话总结（⑤）。
 *
 * 两者都「能用 AI 就用 AI、没配 Key 就退回确定性模板」，所以组件无论有没有 adapter
 * 都能渲染。AI 输出的关键数字用【】包裹，组件据此高亮（深色/琥珀）。
 */
import type { AIAdapter, AIMessage } from '@/lib/ai/types'
import type { MonthAgg, CategoryCompareRow } from '@/lib/reviewData'

const yuan = (n: number) => `¥${Math.round(n)}`

/** 把一段 markdown/代码块包裹的回复清洗成纯 JSON 文本。 */
function stripFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
}

// ─── ④ 消费人格 ────────────────────────────────────────────────────────────────

export interface PersonaInsight {
  persona: string          // 本月人格标签，如「谨慎储蓄型」
  lastPersona: string | null // 上月人格标签（无数据则 null）
  comment: string          // 一句评价，关键数字用【】包裹
  isAI: boolean
}

/** 没有 AI 时的确定性人格标签。 */
function fallbackPersona(a: MonthAgg): string {
  if (!a.hasData) return '—'
  if (a.regretCount >= 2) return '冲动消费型'
  if (a.savingsCount >= 3 && a.regretCount === 0) return '谨慎储蓄型'
  if (a.impulseHeld >= 2) return '即时满足型'
  if (a.savingsCount > 0 || a.savingsAdded > 0) return '计划执行型'
  if (a.totalSpent > 0 && a.discretionaryUsed > a.totalSpent * 0.6) return '随性消费型'
  return '稳健生活型'
}

/** 没有 AI 时的确定性评价（关键数字已用【】包裹）。 */
function fallbackComment(a: MonthAgg): string {
  if (!a.hasData) return '这个月还没有可复盘的消费数据。'
  const parts: string[] = []
  parts.push(`这个月一共花了【${yuan(a.totalSpent)}】`)
  if (a.savingsCount > 0) parts.push(`忍住了【${a.savingsCount}】次`)
  if (a.regretCount > 0) parts.push(`有【${a.regretCount}】笔被你标了后悔`)
  return parts.join('，') + '。'
}

function aggFacts(label: string, a: MonthAgg): string {
  if (!a.hasData) return `${label}：没有消费数据`
  const top = a.topCategories.map((c) => `${c.label}${yuan(c.amount)}`).join('、')
  return (
    `${label}（${a.monthLabel}）：总支出${yuan(a.totalSpent)}，可支配${yuan(a.discretionaryUsed)}，` +
    `忍住${a.savingsCount}次攒${yuan(a.savingsAdded)}，后悔标记${a.regretCount}笔，值得标记${a.worthCount}笔，` +
    `冷静期放弃${a.impulseHeld}件${top ? `，花得最多：${top}` : ''}`
  )
}

const PERSONA_SYSTEM =
  '你是 Kura 的消费人格分析师。根据用户本月与上月的消费聚合数据，给出本月的「消费人格标签」并和上月对比。\n' +
  '严格返回 JSON，不要任何解释或代码块：\n' +
  '{ "persona": "本月人格标签", "last_persona": "上月人格标签或null", "comment": "一句评价" }\n' +
  '规则：\n' +
  '1. persona / last_persona 是 3-6 个字、以「型」结尾的短标签，如「谨慎储蓄型」「冲动消费型」「计划执行型」「即时满足型」。上月无数据时 last_persona 为 null。\n' +
  '2. comment 只有一句话，克制、温和、不说教，必须引用数据里真实出现的关键数字，并把每个关键数字用【】包裹，例如「这个月你忍住了【6】次，可支配只花了【¥820】」。\n' +
  '3. 绝不编造数据里没有的数字或事实。'

/**
 * 生成消费人格洞察。adapter 为空或出错时回退到确定性模板（isAI=false）。
 */
export async function analyzeReviewPersona(
  adapter: AIAdapter | null,
  agg: MonthAgg,
  prevAgg: MonthAgg,
  signal?: AbortSignal,
): Promise<PersonaInsight> {
  const fallback: PersonaInsight = {
    persona: fallbackPersona(agg),
    lastPersona: prevAgg.hasData ? fallbackPersona(prevAgg) : null,
    comment: fallbackComment(agg),
    isAI: false,
  }
  if (!adapter || !agg.hasData) return fallback

  const messages: AIMessage[] = [
    { role: 'system', content: PERSONA_SYSTEM },
    { role: 'user', content: `${aggFacts('本月', agg)}\n${aggFacts('上月', prevAgg)}\n\n请分析本月消费人格。` },
  ]

  try {
    const raw = await adapter.streamChat(messages, () => {}, signal)
    const parsed = JSON.parse(stripFences(raw)) as {
      persona?: unknown; last_persona?: unknown; comment?: unknown
    }
    const persona = typeof parsed.persona === 'string' && parsed.persona.trim() ? parsed.persona.trim() : fallback.persona
    const lastPersona = typeof parsed.last_persona === 'string' && parsed.last_persona.trim()
      ? parsed.last_persona.trim()
      : null
    const comment = typeof parsed.comment === 'string' && parsed.comment.trim() ? parsed.comment.trim() : fallback.comment
    return { persona, lastPersona, comment, isAI: true }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return fallback
  }
}

// ─── ⑤ 分类对比一句话总结 ───────────────────────────────────────────────────────

/** 没有 AI 时，从涨跌最大的品类拼一句总结。 */
function fallbackSummary(rows: CategoryCompareRow[]): string {
  const moved = rows.filter((r) => r.delta !== 0)
  if (moved.length === 0) return '本月各类消费和上月基本持平。'
  const up = [...moved].sort((a, b) => b.delta - a.delta)[0]
  const down = [...moved].sort((a, b) => a.delta - b.delta)[0]
  const bits: string[] = []
  if (up.delta > 0) bits.push(`${up.label}多花了${yuan(up.delta)}`)
  if (down.delta < 0 && down.category !== up.category) bits.push(`${down.label}省下${yuan(-down.delta)}`)
  return bits.length > 0 ? `本月${bits.join('，')}。` : '本月各类消费和上月基本持平。'
}

const SUMMARY_SYSTEM =
  '你是 Kura 的消费分析助手。下面是用户本月 vs 上月各品类的支出对比。\n' +
  '用一句自然、口语、不说教的中文，点出哪类涨了、哪类降了（挑变化最明显的 1-2 类即可）。\n' +
  '只用给定数字，不要编造。不要用 markdown，不要列清单，只输出这一句话。'

/**
 * 生成分类对比一句话总结。adapter 为空或出错时回退到确定性模板。
 */
export async function summarizeSpendShift(
  adapter: AIAdapter | null,
  rows: CategoryCompareRow[],
  signal?: AbortSignal,
): Promise<string> {
  if (rows.length === 0) return '本月还没有可对比的分类消费。'
  if (!adapter) return fallbackSummary(rows)

  const facts = rows
    .map((r) => `${r.label}：本月${yuan(r.thisAmount)}，上月${yuan(r.lastAmount)}（${r.delta >= 0 ? '+' : ''}${yuan(r.delta)}）`)
    .join('\n')
  const messages: AIMessage[] = [
    { role: 'system', content: SUMMARY_SYSTEM },
    { role: 'user', content: facts },
  ]
  try {
    const raw = await adapter.streamChat(messages, () => {}, signal)
    const text = raw.trim()
    return text || fallbackSummary(rows)
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    return fallbackSummary(rows)
  }
}
