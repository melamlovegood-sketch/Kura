import { useEffect, useRef, useState } from 'react'
import { Shirt } from 'lucide-react'
import { CardAlt } from '@/components/ui/card'
import { useWishPoolStore } from '@/store/wishpool'
import { useWishlistStore } from '@/store/wishlist'
import { useCountUp } from '@/hooks/useCountUp'
import { db } from '@/lib/db'
import { formatAmount, cn } from '@/lib/utils'
import {
  WishPoolDetailSheet,
  resistRemainHint,
  resistName,
  type ResistRow,
} from '@/components/wishpool/WishPoolDetailSheet'
import type { WishPoolData } from '@/types/db'

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
  // Product image/name come from the pool's focus wishlist item (the view only
  // carries focus_item_name); read it live so detail-sheet edits reflect here.
  const focusItem = useWishlistStore((s) => s.items.find((i) => i.id === pool.focus_item_id))

  const pct       = pool.target_amount > 0 ? Math.min((pool.saved_amount / pool.target_amount) * 100, 100) : 0
  const remaining = Math.max(pool.target_amount - pool.saved_amount, 0)
  const completed = pool.target_amount > 0 && pool.saved_amount >= pool.target_amount
  const animSaved = useCountUp(pool.saved_amount)

  const name     = focusItem?.item_name ?? pool.focus_item_name
  const imageUrl = focusItem?.image_url ?? null

  // 忍住 records drive 「忍住了 X 次」 + the 「再忍 X 杯」 hint. Refetch when the pooled
  // amount changes (a new 忍住 just landed). Summary only — the full list lives in
  // the detail sheet.
  const [resists, setResists] = useState<ResistRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void db
      .from('savings_records')
      .select('id, amount, description, recorded_at')
      .eq('wish_pool_id', pool.id)
      .order('recorded_at', { ascending: false })
      .then(({ data }: { data: ResistRow[] | null }) => {
        if (!cancelled) setResists(data ?? [])
      })
    return () => { cancelled = true }
  }, [pool.id, pool.saved_amount])

  const count  = resists?.length ?? 0
  const latest = resists && resists[0]
    ? { amount: Number(resists[0].amount), name: resistName(resists[0]) }
    : null

  // Amber pulse when a new 忍住 bumps the saved amount.
  const prevSaved = useRef(pool.saved_amount)
  const [pulse, setPulse] = useState(false)
  useEffect(() => {
    if (pool.saved_amount > prevSaved.current) {
      setPulse(true)
      const t = setTimeout(() => setPulse(false), 900)
      prevSaved.current = pool.saved_amount
      return () => clearTimeout(t)
    }
    prevSaved.current = pool.saved_amount
  }, [pool.saved_amount])

  const [open, setOpen] = useState(false)

  return (
    <>
      <CardAlt className={cn('p-0 transition-shadow duration-500', pulse && 'shadow-lg shadow-amber-100/60')}>
        <button onClick={() => setOpen(true)} className="flex w-full flex-col gap-3 p-4 text-left">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">许愿池</p>

          <div className="flex items-center gap-3">
            {/* 商品缩略图 52×52，无图回退衬衫占位 */}
            {imageUrl ? (
              <img src={imageUrl} alt={name} className="h-[52px] w-[52px] shrink-0 rounded-lg bg-card object-cover" />
            ) : (
              <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-lg bg-card text-ink-4">
                <Shirt size={22} strokeWidth={1.5} />
              </div>
            )}

            <div className="min-w-0 flex-1">
              <p className="truncate font-serif text-[16px] text-ink">{name}</p>
              <p className="mt-0.5 text-[13px] text-ink-4">
                忍住了 {count} 次 · 已存{' '}
                <span className={cn('font-medium tabular-nums transition-colors', pulse && 'text-amber-600')}>
                  {formatAmount(animSaved)}
                </span>{' '}
                / {formatAmount(pool.target_amount)}
              </p>
            </div>

            {completed && <span className="shrink-0 text-[13px] font-medium text-amber-600">达成 ✓</span>}
          </div>

          {/* 进度条 */}
          <div className="h-[2px] w-full overflow-hidden rounded-full bg-[#F5DEB3]">
            <div
              className={cn('h-full rounded-full transition-all duration-700 ease-out', completed ? 'bg-amber-500' : 'bg-amber-400')}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* 左：百分比 · 右：还差 ¥X · 再忍 X 杯 */}
          <div className="flex items-center justify-between text-[13px] text-ink-4">
            <span>{pct.toFixed(0)}%</span>
            <span className="truncate pl-3">
              {completed ? '目标达成 ✓' : resistRemainHint(remaining, latest)}
            </span>
          </div>
        </button>
      </CardAlt>

      {open && <WishPoolDetailSheet pool={pool} onClose={() => setOpen(false)} />}
    </>
  )
}
