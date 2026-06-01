import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ArrowUpRight, Trash2 } from 'lucide-react'
import { CardAlt, CardHeader, CardTitle } from '@/components/ui/card'
import { ShareCardSheet } from '@/components/share/ShareCardSheet'
import { WishPoolShareCard } from '@/components/share/WishPoolShareCard'
import { useWishPoolStore } from '@/store/wishpool'
import { useCountUp } from '@/hooks/useCountUp'
import { db } from '@/lib/db'
import { formatAmount } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { WishPoolData } from '@/types/db'

/** One 忍住了 record under the active pool (商品名 + 金额). */
interface SavingRow {
  id: string
  amount: number
  description: string | null
  recorded_at: string
}

export function WishPoolCard() {
  const { pool, loaded } = useWishPoolStore()
  if (!loaded) return null

  if (!pool) {
    return (
      <CardAlt className="py-5 text-center text-[13px] text-ink-4">
        还没有许愿目标 — 在待购清单中 pin 一件商品
      </CardAlt>
    )
  }
  return <ActivePoolCard pool={pool} />
}

function ActivePoolCard({ pool }: { pool: WishPoolData }) {
  const deletePool = useWishPoolStore((s) => s.deletePool)
  const pct       = pool.target_amount > 0 ? Math.min((pool.saved_amount / pool.target_amount) * 100, 100) : 0
  const completed = pool.saved_amount >= pool.target_amount
  const animSaved = useCountUp(pool.saved_amount)

  // 删除许愿池：点垃圾桶 → 行内「确认删除？」→ 连带删掉攒进来的每一笔 (bug3)。
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  async function handleDelete() {
    setDeleting(true)
    try {
      await deletePool(pool.id, pool.focus_item_id)
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const prevSaved = useRef(pool.saved_amount)
  const [pulse, setPulse] = useState(false)

  // Expandable 忍住明细 — fetch the savings records on first open, then refresh
  // whenever the pooled amount changes (a new 忍住 was just added).
  const [open, setOpen] = useState(false)
  const [savings, setSavings] = useState<SavingRow[] | null>(null)

  // 分享进度卡：点击「↗ 分享进度」时拉取全部「忍住了」记录（累计次数 + 累计金额），
  // 再弹出深色分享卡。null = 未打开。
  const [share, setShare] = useState<{ count: number; total: number } | null>(null)

  async function openShare() {
    const { data } = await db.from('savings_records').select('amount')
    const rows = (data as { amount: number | string }[] | null) ?? []
    const total = rows.reduce((s, r) => s + Number(r.amount), 0)
    setShare({ count: rows.length, total })
  }

  useEffect(() => {
    if (pool.saved_amount > prevSaved.current) {
      setPulse(true)
      const t = setTimeout(() => setPulse(false), 900)
      prevSaved.current = pool.saved_amount
      return () => clearTimeout(t)
    }
    prevSaved.current = pool.saved_amount
  }, [pool.saved_amount])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void db
      .from('savings_records')
      .select('id, amount, description, recorded_at')
      .eq('wish_pool_id', pool.id)
      .order('recorded_at', { ascending: false })
      .then(({ data }: { data: SavingRow[] | null }) => {
        if (!cancelled) setSavings(data ?? [])
      })
    return () => { cancelled = true }
  }, [open, pool.id, pool.saved_amount])

  return (
    <CardAlt className={cn('transition-shadow duration-500', pulse && 'shadow-lg shadow-amber-100/60')}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>许愿池</CardTitle>
        <div className="flex items-center gap-3">
          {completed && <span className="text-[13px] font-medium text-amber-600">目标达成 ✓</span>}
          <button
            onClick={() => void openShare()}
            className="flex items-center gap-0.5 text-[13px] text-ink-4 transition-colors hover:text-ink-3"
          >
            <ArrowUpRight size={14} /> 分享进度
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            aria-label="删除许愿池"
            className="text-ink-4 transition-colors hover:text-red-500"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </CardHeader>

      {confirmDelete && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-card-alt px-3 py-2.5">
          <span className="text-[13px] text-ink-2">确认删除？攒进来的记录会一并清空</span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="text-[13px] text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40"
            >
              取消
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="text-[13px] font-medium text-red-500 transition-colors hover:text-red-600 disabled:opacity-40"
            >
              {deleting ? '删除中…' : '删除'}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <span className="font-serif text-[18px] text-ink leading-tight">{pool.focus_item_name}</span>
          <span className="shrink-0 ml-3">
            <span className={cn('font-serif text-[16px] font-medium text-ink tabular-nums transition-colors', pulse && 'text-amber-600')}>
              {formatAmount(animSaved)}
            </span>
            <span className="font-serif text-[13px] text-ink-4"> / {formatAmount(pool.target_amount)}</span>
          </span>
        </div>

        {/* Amber progress bar for wish pool */}
        <div className="h-[2px] w-full overflow-hidden rounded-full bg-[#F5DEB3]">
          <div
            className={cn('h-full rounded-full transition-all duration-700 ease-out', completed ? 'bg-amber-500' : 'bg-amber-400')}
            style={{ width: `${pct}%` }}
          />
        </div>

        <p className="text-right text-[13px] text-ink-4">
          {pct.toFixed(0)}%
          {pool.target_amount > pool.saved_amount && (
            <span> · 还差 {formatAmount(pool.target_amount - pool.saved_amount)}</span>
          )}
        </p>

        {/* 忍住明细 — tap to expand the list of 攒进来的每一笔. */}
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center justify-center gap-1 border-t-theme pt-2.5 text-[13px] text-ink-4 transition-colors hover:text-ink-3"
        >
          忍住明细
          <ChevronDown size={13} className={cn('transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div>
            {savings == null ? (
              <p className="py-1 text-center text-[13px] text-ink-4">加载中…</p>
            ) : savings.length === 0 ? (
              <p className="py-1 text-center text-[13px] text-ink-4">还没有忍住记录</p>
            ) : (
              <ul className="flex flex-col">
                {savings.map((s) => (
                  <li key={s.id} className="flex items-baseline justify-between gap-3 py-1.5 border-t-theme first:border-t-0">
                    <span className="truncate text-[14px] text-ink-2">
                      {(s.description ?? '').replace(/^忍住了：/, '') || '忍住了一笔'}
                    </span>
                    <span className="shrink-0 font-serif text-[14px] text-ink-2 tabular-nums">
                      {formatAmount(Number(s.amount))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {share && (
        <ShareCardSheet onClose={() => setShare(null)} filename="kura-许愿池进度">
          <WishPoolShareCard
            focusItemName={pool.focus_item_name}
            targetAmount={pool.target_amount}
            savedAmount={pool.saved_amount}
            savingsCount={share.count}
            savingsTotal={share.total}
          />
        </ShareCardSheet>
      )}
    </CardAlt>
  )
}
