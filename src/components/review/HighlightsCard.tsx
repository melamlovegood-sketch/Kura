import { Card } from '@/components/ui/card'
import { formatAmount } from '@/lib/utils'
import type { Highlights } from '@/lib/reviewData'

/**
 * ⑦ 本月高光：最贵一笔 / 最能忍的一笔 / 最后悔一笔。每条无数据则隐藏；全空则整卡隐藏。
 *
 * 注：spec 写的「忍住最久」在 savings_records 里没有时长字段，这里按「金额最大的一次
 * 忍住」呈现（你这个月忍下的最贵一笔）。
 */
export function HighlightsCard({ highlights }: { highlights: Highlights }) {
  const { mostExpensive, biggestResist, biggestRegret } = highlights
  const rows: { emoji: string; label: string; name: string; amount: number }[] = []

  if (mostExpensive) {
    rows.push({ emoji: '💸', label: '最贵一笔', name: mostExpensive.name, amount: mostExpensive.amount })
  }
  if (biggestResist) {
    rows.push({
      emoji: '🛡️',
      label: '最能忍',
      name: biggestResist.description?.trim() || '忍住没买',
      amount: biggestResist.amount,
    })
  }
  if (biggestRegret) {
    rows.push({ emoji: '😮‍💨', label: '最后悔', name: biggestRegret.name, amount: biggestRegret.amount })
  }

  if (rows.length === 0) return null

  return (
    <Card>
      <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">本月高光</p>
      <div className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="text-[22px] leading-none">{r.emoji}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-ink-4">{r.label}</p>
              <p className="truncate text-[14px] text-ink">{r.name}</p>
            </div>
            <span className="shrink-0 font-serif text-[16px] text-ink-2 tabular-nums">{formatAmount(r.amount)}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}
