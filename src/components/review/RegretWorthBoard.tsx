import { useState } from 'react'
import { X, Plus } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { formatAmount, cn } from '@/lib/utils'
import { setReviewTag, type TaggedTxn, type ReviewTag } from '@/lib/reviewData'

/**
 * ⑥ 后悔榜 / 值得榜。两个 tab 切换，列出当月标记为 regret / worth 的消费。
 * 「标记一笔」弹窗列出当月全部消费，可标记后悔 / 值得 / 取消。数据落在
 * transactions.review_tag。标记后通过 onChanged 让父级重新拉取。
 */
export function RegretWorthBoard({
  regret,
  worth,
  allTxns,
  onChanged,
}: {
  regret: TaggedTxn[]
  worth: TaggedTxn[]
  allTxns: TaggedTxn[]
  onChanged: () => void
}) {
  const [tab, setTab] = useState<ReviewTag>('regret')
  const [dialogOpen, setDialogOpen] = useState(false)

  const list = tab === 'regret' ? regret : worth

  return (
    <Card>
      <div className="mb-3 flex items-center gap-1">
        <TabBtn active={tab === 'regret'} onClick={() => setTab('regret')}>
          后悔榜{regret.length > 0 && ` · ${regret.length}`}
        </TabBtn>
        <TabBtn active={tab === 'worth'} onClick={() => setTab('worth')}>
          值得榜{worth.length > 0 && ` · ${worth.length}`}
        </TabBtn>
      </div>

      {list.length === 0 ? (
        <p className="py-3 text-[13px] text-ink-4">
          {tab === 'regret' ? '本月还没有标记后悔的消费。' : '本月还没有标记值得的消费。'}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {list.map((t, i) => (
            <li key={t.id} className="flex items-baseline justify-between gap-3">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 font-serif text-[13px] text-ink-4 tabular-nums">{i + 1}</span>
                <span className="truncate text-[14px] text-ink">{t.name}</span>
                <span className="shrink-0 text-[11px] text-ink-4">{t.date.slice(5)}</span>
              </span>
              <span className="shrink-0 font-serif text-[15px] text-ink-2 tabular-nums">{formatAmount(t.amount)}</span>
            </li>
          ))}
        </ol>
      )}

      <Button variant="outline" className="mt-3 w-full" onClick={() => setDialogOpen(true)}>
        <Plus size={15} className="mr-1" /> 标记一笔
      </Button>

      {dialogOpen && (
        <MarkDialog txns={allTxns} onClose={() => setDialogOpen(false)} onChanged={onChanged} />
      )}
    </Card>
  )
}

function TabBtn({ active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button
      className={cn(
        'rounded-full px-3 py-1 text-[13px] font-medium transition-colors',
        active ? 'bg-card-alt text-ink' : 'text-ink-4 hover:text-ink-2',
      )}
      {...props}
    />
  )
}

/* ── 标记弹窗 ─────────────────────────────────────────────────────────────── */

function MarkDialog({
  txns,
  onClose,
  onChanged,
}: {
  txns: TaggedTxn[]
  onClose: () => void
  onChanged: () => void
}) {
  // 本地维护各笔的当前 tag，避免每次标记都等父级整页刷新。
  const [tags, setTags] = useState<Record<string, ReviewTag | null>>(
    () => Object.fromEntries(txns.map((t) => [t.id, t.review_tag])),
  )
  const [busyId, setBusyId] = useState<string | null>(null)

  async function mark(t: TaggedTxn, next: ReviewTag) {
    if (busyId) return
    const current = tags[t.id]
    const value: ReviewTag | null = current === next ? null : next // 再点一次取消
    setBusyId(t.id)
    try {
      await setReviewTag(t.id, value)
      setTags((m) => ({ ...m, [t.id]: value }))
      onChanged()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/40"
        style={{ animation: 'sheet-backdrop-in 0.2s ease-out' }}
        onClick={onClose}
      />
      <div
        className="relative z-10 max-h-[80vh] w-full max-w-[480px] overflow-hidden rounded-t-2xl bg-card sm:rounded-2xl"
        style={{ animation: 'sheet-slide-up 0.26s cubic-bezier(0.16,1,0.3,1)' }}
      >
        <div className="flex items-center justify-between border-b-theme px-5 py-3.5">
          <p className="text-[15px] font-medium text-ink">标记本月消费</p>
          <button onClick={onClose} aria-label="关闭" className="rounded-md p-1 text-ink-4 hover:text-ink-2">
            <X size={18} />
          </button>
        </div>

        {txns.length === 0 ? (
          <p className="px-5 py-8 text-center text-[14px] text-ink-4">本月还没有消费记录。</p>
        ) : (
          <ul className="max-h-[64vh] overflow-y-auto px-5 py-2">
            {txns.map((t) => {
              const tag = tags[t.id]
              return (
                <li key={t.id} className="flex items-center gap-3 border-b-theme py-2.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] text-ink">{t.name}</p>
                    <p className="mt-0.5 text-[12px] text-ink-4 tabular-nums">
                      {formatAmount(t.amount)} · {t.date.slice(5)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <MarkChip
                      active={tag === 'regret'}
                      tone="regret"
                      disabled={busyId === t.id}
                      onClick={() => void mark(t, 'regret')}
                    >
                      后悔
                    </MarkChip>
                    <MarkChip
                      active={tag === 'worth'}
                      tone="worth"
                      disabled={busyId === t.id}
                      onClick={() => void mark(t, 'worth')}
                    >
                      值得
                    </MarkChip>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function MarkChip({
  active,
  tone,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; tone: ReviewTag }) {
  const activeCls = tone === 'regret' ? 'bg-red-500 text-white' : 'bg-emerald-600 text-white'
  return (
    <button
      className={cn(
        'rounded-full px-3 py-1 text-[12px] font-medium transition-colors disabled:opacity-50',
        active ? activeCls : 'border-theme text-ink-3 hover:bg-card-alt',
      )}
      {...props}
    >
      {children}
    </button>
  )
}
