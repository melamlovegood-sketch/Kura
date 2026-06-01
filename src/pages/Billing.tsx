import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Paperclip, Sparkles, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { ConfirmTransactionCard } from '@/components/transaction/ConfirmTransactionCard'
import { ReceiptSplitCard } from '@/components/transaction/ReceiptSplitCard'
import { SubscriptionManager } from '@/components/subscription/SubscriptionManager'
import { useSettingsStore } from '@/store/settings'
import { useBudgetStore } from '@/store/budget'
import { db } from '@/lib/db'
import { addTransaction } from '@/store/transactions'
import { parseTransaction, parseReceipt, isSupermarketReceipt } from '@/lib/parseTransaction'
import { CATEGORY_META, CATEGORY_GROUPS } from '@/lib/categories'
import { fileToCompressedBase64, formatAmount, formatMonth, cn } from '@/lib/utils'
import { monthString } from '@/lib/generateMonthlyStory'
import type { CategoryMain, ItemCategory, ParsedTransaction } from '@/types/db'

interface TxRow {
  id: string
  date: string
  amount: number | string
  category: ItemCategory
  category_main: CategoryMain
  description: string | null
  source: 'text' | 'screenshot' | 'import' | null
  created_at: string
}

interface MonthBudget {
  basic_life_limit: number
  discretionary_limit: number
}

const pad = (n: number) => String(n).padStart(2, '0')
function nextMonthStart(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m, 1) // m is 1-based → Date month index gives the next month
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
}

/** First day (YYYY-MM-DD) of the month 5 calendar months before `month` — the
 *  left edge of the 近6个月 trend window (the 6th month being `month` itself). */
function sixMonthsStart(month: string): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 - 5, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
}

/** The 6 month strings ending at (and including) `month`, oldest → newest. */
function last6Months(month: string): string[] {
  const [y, m] = month.split('-').map(Number)
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(y, m - 1 - (5 - i), 1)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
  })
}

/** Today as a local YYYY-MM-DD string (toISOString would shift to UTC). */
function todayStr(): string {
  const n = new Date()
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`
}

/** getDay() index (0 = 周日) → label, for the day-detail header. */
const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** Calendar column header, Monday-first. */
const WEEKDAY_HEADER = ['一', '二', '三', '四', '五', '六', '日']

/** ¥ with thousands separators (formatAmount has none, the calendar stats want them). */
const yuan = (n: number) => `¥${Math.round(n).toLocaleString('en-US')}`

type BillingView = 'detail' | 'calendar' | 'trend'

/**
 * 账单页 (/billing). Top: this-month 基础/可支配 overview. Then AI 记账 (text +
 * screenshot → confirm → transactions). Then 消费明细 grouped by the two main
 * categories, reverse-chronological, with a month switcher. 订阅管理 lives at the
 * bottom (moved here out of 设置).
 */
export function Billing() {
  const thisMonth = monthString(new Date())
  const [month, setMonth] = useState(thisMonth)
  const [view, setView] = useState<BillingView>('detail')
  const [txns, setTxns] = useState<TxRow[]>([])
  const [budget, setBudget] = useState<MonthBudget | null>(null)
  const [trend, setTrend] = useState<{ month: string; total: number }[]>([])
  const refreshHomeBudget = useBudgetStore((s) => s.refresh)

  async function reload(m: string) {
    const [txRes, bRes, trendRes] = await Promise.all([
      db.from('transactions')
        .select('id, date, amount, category, category_main, description, source, created_at')
        .gte('date', `${m}-01`)
        .lt('date', nextMonthStart(m))
        .order('created_at', { ascending: false }),
      db.from('monthly_budgets')
        .select('basic_life_limit, discretionary_limit')
        .eq('month', m)
        .maybeSingle(),
      // 近6个月 totals (for the 趋势 view) — span the whole window in one query.
      db.from('transactions')
        .select('date, amount')
        .gte('date', sixMonthsStart(m))
        .lt('date', nextMonthStart(m)),
    ])
    setTxns((txRes.data as TxRow[] | null) ?? [])
    setBudget((bRes.data as MonthBudget | null) ?? null)

    const rows = (trendRes.data as { date: string; amount: number | string }[] | null) ?? []
    const sums: Record<string, number> = {}
    rows.forEach((r) => {
      const mk = r.date.slice(0, 7)
      sums[mk] = (sums[mk] ?? 0) + Number(r.amount)
    })
    setTrend(last6Months(m).map((mk) => ({ month: mk, total: sums[mk] ?? 0 })))
  }

  useEffect(() => { void reload(month) }, [month])

  const basicUsed = txns.filter((t) => t.category_main === 'basic_life').reduce((s, t) => s + Number(t.amount), 0)
  const discrUsed = txns.filter((t) => t.category_main === 'discretionary').reduce((s, t) => s + Number(t.amount), 0)

  async function handleSaved() {
    await reload(month)
    // Keep Home's budget card in sync when we just recorded into the current month.
    if (month === thisMonth) void refreshHomeBudget()
  }

  const canGoNext = month < thisMonth

  return (
    <div className="flex flex-col gap-5 pt-6 w-full max-w-[640px] mx-auto px-6">
      <div className="flex items-center justify-between">
        <h1 className="text-base font-medium text-ink">账单</h1>
        <MonthSwitcher
          month={month}
          canGoNext={canGoNext}
          onPrev={() => setMonth(shiftMonth(month, -1))}
          onNext={() => canGoNext && setMonth(shiftMonth(month, 1))}
        />
      </div>

      {/* ① 本月概览 */}
      <Card>
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">
          {month === thisMonth ? '本月概览' : `${formatMonth(month)}概览`}
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <OverviewRow label="基础支出" used={basicUsed} limit={budget?.basic_life_limit ?? null} />
          <OverviewRow label="可支配"   used={discrUsed} limit={budget?.discretionary_limit ?? null} />
        </div>
      </Card>

      {/* 视图切换：明细 / 日历 / 趋势 */}
      <ViewSwitcher view={view} onChange={setView} />

      {/* ② AI 记账入口 */}
      <AIRecordCard onSaved={handleSaved} />

      {/* 历史账单批量导入入口 */}
      <Link
        to="/import-history"
        className="flex items-center justify-between rounded-2xl border-theme bg-card px-4 py-3 shadow-card transition-colors hover:bg-card-alt"
      >
        <span className="text-[14px] text-ink-2">📥 导入历史账单</span>
        <ChevronRight size={16} className="text-ink-4" />
      </Link>

      {/* ③ 明细 / 日历 / 趋势 */}
      {view === 'detail' && <TransactionDetail txns={txns} />}
      {view === 'calendar' && (
        <SpendCalendar key={month} month={month} thisMonth={thisMonth} txns={txns} />
      )}
      {view === 'trend' && <TrendChart data={trend} />}

      {/* ④ 订阅管理（从设置页迁移过来） */}
      <SubscriptionManager />

      <div className="h-16 md:h-4" />
    </div>
  )
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + delta, 1)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

function MonthSwitcher({ month, canGoNext, onPrev, onNext }: {
  month: string; canGoNext: boolean; onPrev: () => void; onNext: () => void
}) {
  return (
    <div className="flex items-center gap-1.5 text-[13px] text-ink-3">
      <button onClick={onPrev} className="rounded-md p-1 text-ink-4 transition-colors hover:text-ink-2">
        <ChevronLeft size={16} />
      </button>
      <span className="min-w-[72px] text-center tabular-nums">{formatMonth(month)}</span>
      <button
        onClick={onNext}
        disabled={!canGoNext}
        className="rounded-md p-1 text-ink-4 transition-colors hover:text-ink-2 disabled:opacity-30"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  )
}

function OverviewRow({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const over = limit != null && used > limit
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[14px] text-ink-2">{label}</span>
      <span className="font-serif tabular-nums">
        <span className={cn('text-[18px]', over ? 'text-red-500' : 'text-ink')}>{formatAmount(used)}</span>
        <span className="text-[13px] text-ink-4"> / {limit != null ? formatAmount(limit) : '未设置'}</span>
      </span>
    </div>
  )
}

/* ── ② AI 记账 ─────────────────────────────────────────────────────────────── */

function AIRecordCard({ onSaved }: { onSaved: () => Promise<void> }) {
  const adapter = useSettingsStore((s) => s.adapter)
  const [text, setText] = useState('')
  const [image, setImage] = useState<{ file: File; base64: string } | null>(null)
  const [parsed, setParsed] = useState<ParsedTransaction | null>(null)
  const [receipt, setReceipt] = useState<ParsedTransaction[] | null>(null)
  const [source, setSource] = useState<'text' | 'screenshot'>('text')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasInput = !!text.trim() || !!image

  // base64 流向视觉模型(parseTransaction / parseReceipt → routeIntent)，先压缩再编码，
  // 否则手机原图(4–12MB)会让请求卡死/失败。file 保留原图用于文件名展示。
  async function pickImage(_base64: string, file: File) {
    setImage({ file, base64: await fileToCompressedBase64(file) }); setParsed(null); setReceipt(null); setError(null)
  }
  async function onInputFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await pickImage('', file)
    e.target.value = ''
  }

  async function handleParse() {
    if (busy || !hasInput) return
    if (!adapter) { setError('请先在设置里填写 API Key'); return }
    setBusy(true); setError(null)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const tx = await parseTransaction(adapter, text, image?.base64, ctrl.signal)
      const src = image ? 'screenshot' : 'text'
      // 超市/便利店多品类小票 → 试着 AI 拆分成多条（功能4）。
      if (isSupermarketReceipt(tx, text)) {
        try {
          const items = await parseReceipt(adapter, text, image?.base64, ctrl.signal)
          if (items.length >= 2) { setSource(src); setReceipt(items); return }
        } catch { /* 拆分失败 → 退回单条 */ }
      }
      setSource(src)
      setParsed(tx)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(`解析失败：${(err as Error).message || '请稍后重试'}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm(tx: ParsedTransaction) {
    await addTransaction(tx, source)
    setParsed(null); setText(''); setImage(null)
    await onSaved()
  }

  async function handleConfirmAll(txs: ParsedTransaction[]) {
    for (const t of txs) await addTransaction(t, source)
    setReceipt(null); setText(''); setImage(null)
    await onSaved()
  }

  if (receipt) {
    return (
      <ReceiptSplitCard
        items={receipt}
        source={source}
        onConfirmAll={handleConfirmAll}
        onCancel={() => setReceipt(null)}
      />
    )
  }

  if (parsed) {
    return (
      <ConfirmTransactionCard
        initial={parsed}
        source={source}
        onConfirm={handleConfirm}
        onCancel={() => setParsed(null)}
      />
    )
  }

  return (
    <Card>
      <div className="mb-3 flex items-center gap-1.5 text-[13px] font-medium text-ink-3">
        <Sparkles size={14} /> AI 记账
      </div>
      <ImageDropZone onFile={pickImage} className="flex flex-col gap-2.5">
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setParsed(null); setReceipt(null); setError(null) }}
          placeholder="说一句话，如「中午食堂15块」，或拖拽 / 上传支付截图…"
          rows={2}
          className="w-full resize-none rounded-xl border-theme bg-card-alt px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-4 transition-colors focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)]"
          style={{ maxHeight: 140 }}
        />

        {image && (
          <div className="flex items-center gap-2">
            <span className="max-w-[240px] truncate text-[13px] text-ink-4">{image.file.name}</span>
            <button onClick={() => { setImage(null); setParsed(null); setReceipt(null) }} className="text-ink-4 transition-colors hover:text-ink-3">
              <X size={14} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 text-[13px] text-ink-3 transition-colors hover:text-ink-2"
          >
            <Paperclip size={14} /> 上传截图
          </button>
          <Button size="sm" onClick={() => void handleParse()} disabled={!hasInput || busy}>
            {busy ? '识别中…' : 'AI 解析'}
          </Button>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onInputFile} />
      </ImageDropZone>

      {error && <p className="mt-3 text-[13px] text-red-500">{error}</p>}
    </Card>
  )
}

/* ── ③ 消费明细 ─────────────────────────────────────────────────────────────── */

function TransactionDetail({ txns }: { txns: TxRow[] }) {
  if (txns.length === 0) {
    return (
      <Card>
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">消费明细</p>
        <p className="mt-2 text-[13px] text-ink-4">这个月还没有记账</p>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">消费明细</p>
      {CATEGORY_GROUPS.map((group) => {
        const rows = txns.filter((t) => t.category_main === group.main)
        if (rows.length === 0) return null
        const total = rows.reduce((s, t) => s + Number(t.amount), 0)
        return <CategoryGroup key={group.main} label={group.label} total={total} rows={rows} />
      })}
    </div>
  )
}

function CategoryGroup({ label, total, rows }: { label: string; total: number; rows: TxRow[] }) {
  const [open, setOpen] = useState(true)
  return (
    <Card className="py-0 overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between py-4">
        <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
          {label}
          <ChevronDown size={14} className={cn('text-ink-4 transition-transform', !open && '-rotate-90')} />
          <span className="text-[12px] font-normal text-ink-4">{rows.length} 笔</span>
        </span>
        <span className="font-serif text-[15px] text-ink-2 tabular-nums">{formatAmount(total)}</span>
      </button>
      {open && (
        <ul className="flex flex-col pb-2">
          {rows.map((t) => (
            <li key={t.id} className="flex items-baseline justify-between gap-3 border-t-theme py-2.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[14px] text-ink-2">{t.description || CATEGORY_META[t.category].label}</span>
                <span className="shrink-0 rounded border-theme px-1.5 py-0.5 text-[11px] text-ink-4">{CATEGORY_META[t.category].label}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="text-[11px] text-ink-4 tabular-nums">{t.date.slice(5)}</span>
                <span className="font-serif text-[15px] text-ink tabular-nums">{formatAmount(Number(t.amount))}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ── 视图切换胶囊 ───────────────────────────────────────────────────────────── */

function ViewSwitcher({ view, onChange }: { view: BillingView; onChange: (v: BillingView) => void }) {
  const tabs: { key: BillingView; label: string }[] = [
    { key: 'detail', label: '明细' },
    { key: 'calendar', label: '日历' },
    { key: 'trend', label: '趋势' },
  ]
  return (
    <div className="flex gap-1 rounded-[14px] border-theme bg-card p-1">
      {tabs.map((t) => {
        const active = view === t.key
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={cn(
              'flex-1 rounded-[10px] py-2 text-[13px] font-medium transition-colors',
              active ? 'bg-[#3D2B1F] text-white' : 'text-ink-4 hover:text-ink-2',
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

/* ── 日历热力图 ─────────────────────────────────────────────────────────────── */

const HEAT_BG = ['#F5F0EB', '#E8D8C8', '#D4B898', '#B8906A', '#8B6A4A', '#3D2B1F']
const heatText = (lvl: number) =>
  lvl <= 1 ? '#7A6A5C' : lvl === 2 ? '#5A4A3A' : 'rgba(255,255,255,0.9)'

function SpendCalendar({ month, thisMonth, txns }: { month: string; thisMonth: string; txns: TxRow[] }) {
  // 当月按日聚合金额。
  const dailyMap: Record<string, number> = {}
  txns.forEach((t) => {
    const d = t.date.slice(0, 10)
    dailyMap[d] = (dailyMap[d] ?? 0) + Number(t.amount)
  })

  const values = Object.values(dailyMap)
  const max = values.length ? Math.max(...values) : 0
  // 基于当月最大单日动态分5级，避免固定阈值不适配不同消费水平。
  const level = (amt: number) => {
    if (!amt || max === 0) return 0
    const r = amt / max
    if (r < 0.15) return 1
    if (r < 0.35) return 2
    if (r < 0.6) return 3
    if (r < 0.85) return 4
    return 5
  }

  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(y, m, 0).getDate()
  // Monday-first offset: JS getDay() is Sunday-first (0=日), shift so 一=0…日=6.
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7
  const today = todayStr()

  // 默认选中：本月看今天，历史月看消费最高的一天。
  const maxDay = values.length
    ? Object.entries(dailyMap).reduce((a, b) => (b[1] > a[1] ? b : a))[0]
    : null
  const [selected, setSelected] = useState<string>(month === thisMonth ? today : maxDay ?? `${month}-01`)

  // 月统计
  const monthTotal = values.reduce((s, v) => s + v, 0)
  const spentDays = values.filter((v) => v > 0).length

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3">
        {/* 图例 */}
        <div className="flex items-center justify-center gap-1.5 text-[11px] text-ink-4">
          <span>少</span>
          {HEAT_BG.map((c) => (
            <span key={c} className="h-3 w-3 rounded-[3px]" style={{ background: c }} />
          ))}
          <span>多</span>
        </div>

        {/* 星期头 */}
        <div className="grid grid-cols-7 gap-[3px]">
          {WEEKDAY_HEADER.map((w) => (
            <div key={w} className="text-center text-[11px] text-ink-4">{w}</div>
          ))}
        </div>

        {/* 日期网格 */}
        <div className="grid grid-cols-7 gap-[3px]">
          {Array.from({ length: lead }).map((_, i) => <div key={`lead-${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1
            const dateStr = `${month}-${pad(day)}`
            const amt = dailyMap[dateStr] ?? 0
            const lvl = level(amt)
            const isToday = dateStr === today
            const isSel = dateStr === selected
            return (
              <button
                key={dateStr}
                onClick={() => setSelected(dateStr)}
                className="flex flex-col items-center justify-center rounded-[8px] leading-none"
                style={{
                  aspectRatio: '1',
                  background: HEAT_BG[lvl],
                  color: heatText(lvl),
                  outline: isSel
                    ? '2px solid #C4A882'
                    : isToday
                      ? '2px solid #3D2B1F'
                      : undefined,
                  outlineOffset: '-2px',
                }}
              >
                <span className="text-[11px] tabular-nums">{day}</span>
                {amt > 0 && <span className="mt-0.5 text-[9px] tabular-nums">{yuan(amt)}</span>}
              </button>
            )
          })}
        </div>

        {/* 月统计 */}
        <div className="grid grid-cols-3 gap-[3px]">
          <StatCell label="本月总支出" value={yuan(monthTotal)} />
          <StatCell label="有消费" value={`${spentDays} 天`} />
          <StatCell
            label="最高单日"
            value={maxDay ? `${Number(maxDay.slice(5, 7))}/${maxDay.slice(8)} ${yuan(max)}` : '—'}
            highlight
          />
        </div>
      </Card>

      <DayDetail date={selected} txns={txns.filter((t) => t.date.slice(0, 10) === selected)} />
    </div>
  )
}

function StatCell({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-1 rounded-[8px] py-2.5"
      style={{ background: highlight ? '#F3E3CC' : '#F5F0EB' }}
    >
      <span className="text-[10px] text-ink-4">{label}</span>
      <span
        className="font-serif text-[13px] tabular-nums"
        style={{ color: highlight ? '#8B6A4A' : undefined }}
      >
        {value}
      </span>
    </div>
  )
}

/* ── 当天消费详情 ───────────────────────────────────────────────────────────── */

function DayDetail({ date, txns }: { date: string; txns: TxRow[] }) {
  const [, mm, dd] = date.split('-')
  const wd = WEEKDAY_SHORT[new Date(date + 'T00:00:00').getDay()]
  const dayTotal = txns.reduce((s, t) => s + Number(t.amount), 0)

  if (txns.length === 0) {
    return (
      <Card>
        <div className="flex items-baseline gap-2 text-[14px] text-ink">
          <span className="font-medium">{Number(mm)}月{Number(dd)}日</span>
          <span className="text-[12px] text-ink-4">{wd}</span>
        </div>
        <p className="mt-3 text-center text-[13px] text-ink-4">这天没有消费记录 🌿</p>
      </Card>
    )
  }

  return (
    <Card>
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2 text-[14px] text-ink">
          <span className="font-medium">{Number(mm)}月{Number(dd)}日</span>
          <span className="text-[12px] text-ink-4">{wd}</span>
        </div>
        <span className="font-serif text-[16px] text-ink tabular-nums">{formatAmount(dayTotal)}</span>
      </div>
      <ul className="mt-1 flex flex-col">
        {txns.map((t) => {
          const meta = CATEGORY_META[t.category]
          return (
            <li key={t.id} className="flex items-center justify-between gap-3 border-t-theme py-2.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-[16px]">{meta.emoji}</span>
                <span className="truncate text-[14px] text-ink-2">{t.description || meta.label}</span>
                <span className="shrink-0 rounded border-theme px-1.5 py-0.5 text-[11px] text-ink-4">{meta.label}</span>
              </span>
              <span className="shrink-0 font-serif text-[15px] text-ink tabular-nums">{formatAmount(Number(t.amount))}</span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ── 近6个月趋势 ────────────────────────────────────────────────────────────── */

function TrendChart({ data }: { data: { month: string; total: number }[] }) {
  if (data.every((d) => d.total === 0)) {
    return (
      <Card>
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">近6个月趋势</p>
        <p className="mt-2 text-[13px] text-ink-4">近6个月还没有消费记录</p>
      </Card>
    )
  }

  const W = 320, H = 140, padX = 24, padTop = 16, padBot = 28
  const max = Math.max(...data.map((d) => d.total), 1)
  const stepX = (W - padX * 2) / (data.length - 1)
  const x = (i: number) => padX + i * stepX
  const y = (v: number) => padTop + (1 - v / max) * (H - padTop - padBot)
  const pts = data.map((d, i) => `${x(i)},${y(d.total)}`).join(' ')

  return (
    <Card className="flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">近6个月趋势</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ overflow: 'visible' }}>
        <polyline points={pts} fill="none" stroke="#8B6A4A" strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <g key={d.month}>
            <circle cx={x(i)} cy={y(d.total)} r={3} fill="#3D2B1F" />
            {d.total > 0 && (
              <text x={x(i)} y={y(d.total) - 7} textAnchor="middle"
                fontSize={9} fill="#8B6A4A" className="tabular-nums">
                {yuan(d.total)}
              </text>
            )}
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#A89A8C">
              {Number(d.month.slice(5))}月
            </text>
          </g>
        ))}
      </svg>
    </Card>
  )
}
