import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatMonth } from '@/lib/utils'
import { cn } from '@/lib/utils'

/**
 * 复盘页顶部月份切换。months 为有数据的月份（含当前月）降序列表。
 * 左箭头切到更早一个月，右箭头切到更晚一个月；越界（没有更早/更晚的有数据月份）时禁用。
 */
export function MonthSwitcher({
  months,
  month,
  onChange,
}: {
  months: string[]
  month: string
  onChange: (m: string) => void
}) {
  const idx = months.indexOf(month)
  const hasOlder = idx >= 0 && idx < months.length - 1
  const hasNewer = idx > 0

  return (
    <div className="flex items-center gap-1">
      <NavBtn
        disabled={!hasOlder}
        onClick={() => hasOlder && onChange(months[idx + 1])}
        aria-label="上一月"
      >
        <ChevronLeft size={18} />
      </NavBtn>
      <span className="min-w-[92px] text-center text-[15px] font-medium text-ink tabular-nums">
        {formatMonth(month)}
      </span>
      <NavBtn
        disabled={!hasNewer}
        onClick={() => hasNewer && onChange(months[idx - 1])}
        aria-label="下一月"
      >
        <ChevronRight size={18} />
      </NavBtn>
    </div>
  )
}

function NavBtn({
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      disabled={disabled}
      className={cn(
        'rounded-lg p-1 transition-colors',
        disabled ? 'text-ink-4 opacity-40' : 'text-ink-3 hover:bg-card-alt hover:text-ink',
      )}
      {...props}
    />
  )
}
