/**
 * 复盘页数据层 — 所有按月聚合的纯数据（不含 AI）。Review.tsx 每次切月调用一次
 * loadReviewMonth(month)，拿到三格数据、分类对比、后悔/值得榜、当月明细（标记弹窗用）、
 * 本月高光，以及供 AI 人格/对比总结使用的本月+上月聚合。
 *
 * 后悔/值得榜走的是 transactions.review_tag 这套「手动标记」机制（migration 0017），
 * 与 review_tasks / review_results 的 7天/30天复盘是两条独立的线。
 */
import { db } from '@/lib/db'
import { CATEGORY_META } from '@/lib/categories'
import type { CategoryMain, ItemCategory } from '@/types/db'

export type ReviewTag = 'regret' | 'worth'

/** 一笔交易（后悔/值得榜与标记弹窗共用）。 */
export interface TaggedTxn {
  id: string
  amount: number
  date: string
  category: ItemCategory
  category_main: CategoryMain
  description: string | null
  review_tag: ReviewTag | null
  /** 展示名：description 优先，否则用品类中文名。 */
  name: string
}

/** 三格核心数据。 */
export interface ReviewStats {
  savingsCount: number          // 本月忍住次数（savings_records 条数）
  savingsAdded: number          // 攒进许愿池金额
  totalSpent: number            // 本月总支出（无许愿池时第三格回退展示）
  wishPoolName: string | null
  wishPoolPct: number | null    // 当前许愿池进度（非按月）
}

/** 分类对比的一行。 */
export interface CategoryCompareRow {
  category: ItemCategory
  label: string
  emoji: string
  thisAmount: number
  lastAmount: number
  delta: number                 // thisAmount - lastAmount
}

export interface Highlights {
  mostExpensive: TaggedTxn | null   // 最贵一笔
  biggestResist: { amount: number; description: string | null } | null // 最能忍的一笔（金额最大的忍住）
  biggestRegret: TaggedTxn | null   // 最后悔一笔（review_tag='regret' 里金额最大）
}

/** 供 AI 人格 / 对比总结使用的单月聚合。 */
export interface MonthAgg {
  month: string
  monthLabel: string
  totalSpent: number
  discretionaryUsed: number
  savingsCount: number
  savingsAdded: number
  regretCount: number
  worthCount: number
  impulseHeld: number
  topCategories: { label: string; amount: number }[]
  hasData: boolean
}

export interface ReviewMonthData {
  month: string
  stats: ReviewStats
  categories: CategoryCompareRow[]
  regret: TaggedTxn[]
  worth: TaggedTxn[]
  allTxns: TaggedTxn[]
  highlights: Highlights
  agg: MonthAgg
  prevAgg: MonthAgg
}

const pad = (n: number) => String(n).padStart(2, '0')

interface RawTxn {
  id: string
  amount: number | string
  date: string
  category: ItemCategory
  category_main: CategoryMain
  description: string | null
  review_tag: ReviewTag | null
}

function monthBounds(month: string) {
  const [y, m] = month.split('-').map(Number)
  const start = new Date(y, m - 1, 1)
  const end = new Date(y, m, 1)
  const prevStart = new Date(y, m - 2, 1)
  return {
    startISO: `${y}-${pad(m)}-01`,
    endISO: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-01`,
    prevStartISO: `${prevStart.getFullYear()}-${pad(prevStart.getMonth() + 1)}-01`,
    startTs: start.toISOString(),
    endTs: end.toISOString(),
    prevStartTs: prevStart.toISOString(),
    prevEndTs: start.toISOString(),
    monthNum: m,
  }
}

function txnName(t: { description: string | null; category: ItemCategory }): string {
  const d = t.description?.trim()
  if (d) return d
  return CATEGORY_META[t.category]?.label ?? '一笔消费'
}

function toTagged(r: RawTxn): TaggedTxn {
  return {
    id: r.id,
    amount: Number(r.amount),
    date: r.date,
    category: r.category,
    category_main: r.category_main,
    description: r.description,
    review_tag: r.review_tag ?? null,
    name: txnName(r),
  }
}

/** Build a single-month aggregate from its transactions / savings / impulses. */
function aggregate(
  month: string,
  txns: TaggedTxn[],
  savings: number[],
  impulseHeld: number,
): MonthAgg {
  const m = Number(month.split('-')[1])
  const totalSpent = txns.reduce((s, t) => s + t.amount, 0)
  const discretionaryUsed = txns
    .filter((t) => t.category_main === 'discretionary')
    .reduce((s, t) => s + t.amount, 0)

  const byCat = new Map<ItemCategory, number>()
  for (const t of txns) byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount)
  const topCategories = [...byCat.entries()]
    .map(([cat, amount]) => ({ label: CATEGORY_META[cat]?.label ?? '其他', amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3)

  return {
    month,
    monthLabel: `${m}月`,
    totalSpent,
    discretionaryUsed,
    savingsCount: savings.length,
    savingsAdded: savings.reduce((s, a) => s + a, 0),
    regretCount: txns.filter((t) => t.review_tag === 'regret').length,
    worthCount: txns.filter((t) => t.review_tag === 'worth').length,
    impulseHeld,
    topCategories,
    hasData: txns.length > 0 || savings.length > 0 || impulseHeld > 0,
  }
}

/** 列出有数据的月份（含当前月，永远在列），降序 'YYYY-MM'。 */
export async function listAvailableMonths(now = new Date()): Promise<string[]> {
  const [txnRes, savRes] = await Promise.all([
    db.from('transactions').select('date'),
    db.from('savings_records').select('recorded_at'),
  ])
  const months = new Set<string>()
  months.add(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`) // 当前月永远可选
  for (const r of (txnRes.data as { date: string }[] | null) ?? []) {
    if (r.date) months.add(r.date.slice(0, 7))
  }
  for (const r of (savRes.data as { recorded_at: string }[] | null) ?? []) {
    if (r.recorded_at) months.add(r.recorded_at.slice(0, 7))
  }
  return [...months].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

/** 拉取某月复盘页所需的全部非 AI 数据。 */
export async function loadReviewMonth(month: string): Promise<ReviewMonthData> {
  const r = monthBounds(month)

  const [txnRes, prevTxnRes, savRes, prevSavRes, impRes, prevImpRes, poolRes] = await Promise.all([
    db.from('transactions')
      .select('id, amount, date, category, category_main, description, review_tag')
      .gte('date', r.startISO).lt('date', r.endISO)
      .order('amount', { ascending: false }),
    db.from('transactions')
      .select('id, amount, date, category, category_main, description, review_tag')
      .gte('date', r.prevStartISO).lt('date', r.startISO),
    db.from('savings_records').select('amount, description, recorded_at')
      .gte('recorded_at', r.startTs).lt('recorded_at', r.endTs),
    db.from('savings_records').select('amount')
      .gte('recorded_at', r.prevStartTs).lt('recorded_at', r.prevEndTs),
    db.from('impulse_records').select('status')
      .gte('recorded_at', r.startTs).lt('recorded_at', r.endTs),
    db.from('impulse_records').select('status')
      .gte('recorded_at', r.prevStartTs).lt('recorded_at', r.prevEndTs),
    db.from('v_active_wish_pool').select('focus_item_name, target_amount, saved_amount').maybeSingle(),
  ])

  const allTxns = ((txnRes.data as RawTxn[] | null) ?? []).map(toTagged)
  const prevTxns = ((prevTxnRes.data as RawTxn[] | null) ?? []).map(toTagged)

  type Sav = { amount: number | string; description: string | null }
  const savings = (savRes.data as Sav[] | null) ?? []
  const savingsAmounts = savings.map((s) => Number(s.amount))
  const prevSavings = ((prevSavRes.data as { amount: number | string }[] | null) ?? []).map((s) => Number(s.amount))

  const impulses = (impRes.data as { status: string }[] | null) ?? []
  const prevImpulses = (prevImpRes.data as { status: string }[] | null) ?? []
  const impulseHeld = impulses.filter((i) => i.status === 'dismissed').length
  const prevImpulseHeld = prevImpulses.filter((i) => i.status === 'dismissed').length

  // ── 三格 ──
  const totalSpent = allTxns.reduce((s, t) => s + t.amount, 0)
  const pool = poolRes.data as { focus_item_name: string; target_amount: number | string; saved_amount: number | string } | null
  const wishPoolName = pool?.focus_item_name ?? null
  const wishPoolPct = pool && Number(pool.target_amount) > 0
    ? Math.round((Number(pool.saved_amount) / Number(pool.target_amount)) * 100)
    : null
  const stats: ReviewStats = {
    savingsCount: savings.length,
    savingsAdded: savingsAmounts.reduce((s, a) => s + a, 0),
    totalSpent,
    wishPoolName,
    wishPoolPct,
  }

  // ── 分类对比（按 item_category 聚合，本月 vs 上月）──
  const thisByCat = new Map<ItemCategory, number>()
  for (const t of allTxns) thisByCat.set(t.category, (thisByCat.get(t.category) ?? 0) + t.amount)
  const lastByCat = new Map<ItemCategory, number>()
  for (const t of prevTxns) lastByCat.set(t.category, (lastByCat.get(t.category) ?? 0) + t.amount)
  const cats = new Set<ItemCategory>([...thisByCat.keys(), ...lastByCat.keys()])
  const categories: CategoryCompareRow[] = [...cats]
    .map((category) => {
      const thisAmount = Math.round(thisByCat.get(category) ?? 0)
      const lastAmount = Math.round(lastByCat.get(category) ?? 0)
      const meta = CATEGORY_META[category]
      return {
        category,
        label: meta?.label ?? '其他',
        emoji: meta?.emoji ?? '🧾',
        thisAmount,
        lastAmount,
        delta: thisAmount - lastAmount,
      }
    })
    .sort((a, b) => Math.max(b.thisAmount, b.lastAmount) - Math.max(a.thisAmount, a.lastAmount))

  // ── 后悔 / 值得榜 ──
  const regret = allTxns.filter((t) => t.review_tag === 'regret').sort((a, b) => b.amount - a.amount)
  const worth = allTxns.filter((t) => t.review_tag === 'worth').sort((a, b) => b.amount - a.amount)

  // ── 本月高光 ──
  const mostExpensive = allTxns.length > 0 ? allTxns.reduce((m, t) => (t.amount > m.amount ? t : m)) : null
  let biggestResist: Highlights['biggestResist'] = null
  for (const s of savings) {
    const amt = Number(s.amount)
    if (!biggestResist || amt > biggestResist.amount) biggestResist = { amount: amt, description: s.description }
  }
  const biggestRegret = regret.length > 0 ? regret[0] : null

  // ── 聚合（AI 用）──
  const agg = aggregate(month, allTxns, savingsAmounts, impulseHeld)
  const prevAgg = aggregate(prevMonthOf(month), prevTxns, prevSavings, prevImpulseHeld)

  return {
    month,
    stats,
    categories,
    regret,
    worth,
    allTxns,
    highlights: { mostExpensive, biggestResist, biggestRegret },
    agg,
    prevAgg,
  }
}

function prevMonthOf(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 2, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

/** 标记 / 取消标记一笔交易的后悔/值得。tag=null 清除标记。 */
export async function setReviewTag(id: string, tag: ReviewTag | null): Promise<void> {
  await db.from('transactions').update({ review_tag: tag }).eq('id', id)
}
