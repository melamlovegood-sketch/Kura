import { Card } from '@/components/ui/card'
import { formatAmount } from '@/lib/utils'
import type { ReviewStats } from '@/lib/reviewData'

/**
 * ③ 核心数据三格：本月忍住次数 / 攒进许愿池金额 / 许愿池进度%。
 * 没有许愿池时第三格回退为「本月总支出」。
 */
export function StatTriple({ stats }: { stats: ReviewStats }) {
  const hasPool = stats.wishPoolPct != null
  return (
    <div className="grid grid-cols-3 gap-2.5">
      <StatBox label="本月忍住" value={`${stats.savingsCount}`} unit="次" />
      <StatBox label="攒进许愿池" value={formatAmount(stats.savingsAdded)} />
      {hasPool ? (
        <StatBox label="许愿池进度" value={`${stats.wishPoolPct}`} unit="%" />
      ) : (
        <StatBox label="本月总支出" value={formatAmount(stats.totalSpent)} />
      )}
    </div>
  )
}

function StatBox({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-1 px-2 py-3.5 text-center">
      <span className="font-serif text-[22px] leading-none text-ink tabular-nums">
        {value}
        {unit && <span className="ml-0.5 text-[13px] text-ink-3">{unit}</span>}
      </span>
      <span className="text-[11px] text-ink-4">{label}</span>
    </Card>
  )
}
