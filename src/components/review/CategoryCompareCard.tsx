import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { useSettingsStore } from '@/store/settings'
import { summarizeSpendShift } from '@/lib/reviewInsights'
import { formatAmount } from '@/lib/utils'
import type { CategoryCompareRow } from '@/lib/reviewData'

const THIS_BAR = '#C4A882' // 本月（深）
const LAST_BAR = '#E8D5C0' // 上月（浅）

/**
 * ⑤ 本月 vs 上月分类对比卡。顶部一句 AI 总结（哪类涨/降），下面每个品类两条对比条
 * （本月深 #C4A882 / 上月浅 #E8D5C0），右侧差值：下降绿、上升红、持平灰。
 */
export function CategoryCompareCard({ rows }: { rows: CategoryCompareRow[] }) {
  const adapter = useSettingsStore((s) => s.adapter)
  const [summary, setSummary] = useState<string | null>(null)

  // signature 用来在切月（数据变化）时重新取总结，但避免每次渲染都重算。
  const sig = rows.map((r) => `${r.category}:${r.thisAmount}:${r.lastAmount}`).join('|')

  useEffect(() => {
    let alive = true
    setSummary(null)
    summarizeSpendShift(adapter, rows).then((s) => { if (alive) setSummary(s) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, adapter])

  if (rows.length === 0) return null

  const max = Math.max(1, ...rows.flatMap((r) => [r.thisAmount, r.lastAmount]))

  return (
    <Card>
      <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">本月 vs 上月</p>

      <p className="mb-4 text-[14px] leading-relaxed text-ink-2">
        {summary ?? <span className="inline-block h-4 w-40 animate-pulse rounded bg-card-alt align-middle" />}
      </p>

      <div className="flex flex-col gap-3.5">
        {rows.map((r) => (
          <div key={r.category}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] text-ink-2">
                <span className="mr-1">{r.emoji}</span>
                {r.label}
              </span>
              <Delta delta={r.delta} />
            </div>
            <Bar amount={r.thisAmount} max={max} color={THIS_BAR} />
            <div className="h-1" />
            <Bar amount={r.lastAmount} max={max} color={LAST_BAR} />
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-4 border-t-theme pt-2.5 text-[11px] text-ink-4">
        <Legend color={THIS_BAR} label="本月" />
        <Legend color={LAST_BAR} label="上月" />
      </div>
    </Card>
  )
}

function Bar({ amount, max, color }: { amount: number; max: number; color: string }) {
  const pct = Math.max(amount > 0 ? 4 : 0, (amount / max) * 100) // 给非零值一个最小可见宽度
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-card-alt">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-14 shrink-0 text-right text-[12px] text-ink-3 tabular-nums">{formatAmount(amount)}</span>
    </div>
  )
}

function Delta({ delta }: { delta: number }) {
  if (delta === 0) return <span className="text-[12px] text-ink-4">持平</span>
  const up = delta > 0
  return (
    <span className={up ? 'text-[12px] text-red-500 tabular-nums' : 'text-[12px] text-emerald-600 tabular-nums'}>
      {up ? '+' : '−'}
      {formatAmount(Math.abs(delta))}
    </span>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  )
}
