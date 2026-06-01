import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { HighlightText } from './HighlightText'
import { useSettingsStore } from '@/store/settings'
import { analyzeReviewPersona, type PersonaInsight } from '@/lib/reviewInsights'
import type { MonthAgg } from '@/lib/reviewData'
import { cn } from '@/lib/utils'

/**
 * ④ 消费人格卡。AI 分析本月消费 → 人格标签 + 上月对比 + 一句评价（关键数字高亮）。
 * 右上角刷新按钮可重新生成；没配 API Key 时回退到确定性标签与模板评价。
 */
export function ReviewPersonaCard({ agg, prevAgg }: { agg: MonthAgg; prevAgg: MonthAgg }) {
  const adapter = useSettingsStore((s) => s.adapter)
  const [insight, setInsight] = useState<PersonaInsight | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setInsight(null)
    setBusy(true)
    analyzeReviewPersona(adapter, agg, prevAgg)
      .then((res) => { if (alive) setInsight(res) })
      .finally(() => { if (alive) setBusy(false) })
    return () => { alive = false }
    // 仅在切月时重算；adapter 变化（填了 Key）也重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agg.month, adapter])

  async function refresh() {
    if (busy) return
    setBusy(true)
    try {
      const res = await analyzeReviewPersona(adapter, agg, prevAgg)
      setInsight(res)
    } finally {
      setBusy(false)
    }
  }

  if (!agg.hasData) return null

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">消费人格</p>
        <button
          onClick={() => void refresh()}
          disabled={busy}
          aria-label="重新生成"
          className="rounded-md p-1 text-ink-4 transition-colors hover:bg-card-alt hover:text-ink-2 disabled:opacity-50"
        >
          <RefreshCw size={14} className={cn(busy && 'animate-spin')} />
        </button>
      </div>

      {insight ? (
        <>
          <div className="flex items-baseline gap-2.5">
            <span className="text-[20px] font-medium text-ink">{insight.persona}</span>
            {insight.lastPersona && (
              <span className="text-[12px] text-ink-4">上月 · {insight.lastPersona}</span>
            )}
          </div>
          <p className="mt-2.5 text-[14px] leading-relaxed text-ink-2">
            <HighlightText text={insight.comment} />
          </p>
        </>
      ) : (
        <div className="h-12 animate-pulse rounded-lg bg-card-alt" />
      )}
    </Card>
  )
}
