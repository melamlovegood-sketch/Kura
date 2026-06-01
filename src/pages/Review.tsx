import { useCallback, useEffect, useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { MonthlyStoryCard } from '@/components/review/MonthlyStoryCard'
import { ReviewCard } from '@/components/review/ReviewCard'
import { MonthSwitcher } from '@/components/review/MonthSwitcher'
import { StatTriple } from '@/components/review/StatTriple'
import { ReviewPersonaCard } from '@/components/review/ReviewPersonaCard'
import { CategoryCompareCard } from '@/components/review/CategoryCompareCard'
import { RegretWorthBoard } from '@/components/review/RegretWorthBoard'
import { HighlightsCard } from '@/components/review/HighlightsCard'
import { useReviewStore, type ReviewTask } from '@/store/review'
import { monthString } from '@/lib/generateMonthlyStory'
import { listAvailableMonths, loadReviewMonth, type ReviewMonthData } from '@/lib/reviewData'
import { formatMonth } from '@/lib/utils'

/**
 * 复盘页（重新设计）。结构自上而下：
 *   ① 顶部导航 + 月份切换（只切有数据的月份）
 *   ② 本月故事卡（MonthlyStoryCard，未生成则给生成按钮）
 *   ③ 核心数据三格
 *   ④ 消费人格卡（AI）
 *   ⑤ 本月 vs 上月分类对比
 *   ⑥ 后悔榜 / 值得榜（transactions.review_tag）
 *   ⑦ 本月高光
 *   ＋ 待复盘清单（到期的 7天/30天复盘任务，保留原有功能）
 */
export function Review() {
  const thisMonth = monthString(new Date())

  const stories = useReviewStore((s) => s.stories)
  const storyBusy = useReviewStore((s) => s.storyBusy)
  const generateStory = useReviewStore((s) => s.generateStory)
  const loadStories = useReviewStore((s) => s.loadStories)
  const pendingTasks = useReviewStore((s) => s.pendingTasks)

  const [months, setMonths] = useState<string[]>([thisMonth])
  const [month, setMonth] = useState<string>(thisMonth)
  const [data, setData] = useState<ReviewMonthData | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void loadStories()
    void listAvailableMonths().then((ms) => setMonths(ms.length > 0 ? ms : [thisMonth]))
  }, [loadStories, thisMonth])

  const refetch = useCallback(() => {
    void loadReviewMonth(month).then(setData)
  }, [month])

  useEffect(() => {
    setData(null)
    setMsg(null)
    void loadReviewMonth(month).then(setData)
  }, [month])

  async function generate() {
    setMsg(null)
    const res = await generateStory(month, { force: true })
    if (!res.ok) setMsg(res.message)
  }

  const story = stories[month]
  // 只在当月（含未来锁定）展示待复盘清单，避免历史月份混入到期任务。
  const showPending = month === thisMonth && pendingTasks.length > 0

  return (
    <div className="flex flex-col gap-4 pt-6 w-full max-w-[640px] mx-auto px-6">
      {/* ① 顶部导航 */}
      <div className="flex items-center justify-between">
        <h1 className="text-base font-medium text-ink">复盘</h1>
        <MonthSwitcher months={months} month={month} onChange={setMonth} />
      </div>

      {/* ② 本月故事 */}
      {story ? (
        <MonthlyStoryCard story={story} />
      ) : (
        <Card>
          <p className="text-[15px] leading-relaxed text-ink-2">{formatMonth(month)}的复盘故事还没生成。</p>
          <p className="mt-1 text-[13px] text-ink-3">把这个月的消费、克制和复盘串成一段话。</p>
          <Button variant="outline" className="mt-3 w-full" onClick={() => void generate()} disabled={storyBusy}>
            {storyBusy ? '生成中…' : `生成${formatMonth(month)}故事`}
          </Button>
          {msg && <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{msg}</p>}
        </Card>
      )}

      {data ? (
        <>
          {/* ③ 核心数据三格 */}
          <StatTriple stats={data.stats} />

          {/* ④ 消费人格 */}
          <ReviewPersonaCard agg={data.agg} prevAgg={data.prevAgg} />

          {/* ⑤ 本月 vs 上月分类对比 */}
          <CategoryCompareCard rows={data.categories} />

          {/* ⑥ 后悔榜 / 值得榜 */}
          <RegretWorthBoard
            regret={data.regret}
            worth={data.worth}
            allTxns={data.allTxns}
            onChanged={refetch}
          />

          {/* ⑦ 本月高光 */}
          <HighlightsCard highlights={data.highlights} />
        </>
      ) : (
        <div className="h-24 animate-pulse rounded-[14px] bg-card-alt" />
      )}

      {/* ＋ 待复盘清单 */}
      {showPending && <PendingReviewList tasks={pendingTasks} />}

      <div className="h-4" />
    </div>
  )
}

/** 待复盘清单：列出到期的复盘任务，点「去复盘」就地展开 ReviewCard 打分。 */
function PendingReviewList({ tasks }: { tasks: ReviewTask[] }) {
  const [activeId, setActiveId] = useState<string | null>(null)

  if (tasks.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">待复盘清单</p>
      {tasks.map((task) =>
        activeId === task.id ? (
          <ReviewCard key={task.id} task={task} />
        ) : (
          <Card key={task.id}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[15px] text-ink">{task.item_name}</p>
                <p className="mt-0.5 text-[12px] text-ink-4">
                  {task.review_type === 'day7' ? '7天复盘' : '30天复盘'} · 购于 {task.created_at.slice(0, 10)}
                </p>
              </div>
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setActiveId(task.id)}>
                去复盘
              </Button>
            </div>
          </Card>
        ),
      )}
    </div>
  )
}
