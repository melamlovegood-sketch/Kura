import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Pin, X, Clock, ChevronUp, ChevronDown } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, CardContent } from '@/components/ui/card'
import { useWishlistStore } from '@/store/wishlist'
import { useImpulseStore } from '@/store/impulse'
import { useWishPoolStore } from '@/store/wishpool'
import { usePriceTrackStore } from '@/store/priceTrack'
import { formatAmount } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { CostLabels } from '@/components/cost/CostLabels'
import { WorthItCard } from '@/components/wishlist/WorthItCard'
import { WishlistDetailSheet } from '@/components/wishlist/WishlistDetailSheet'
import type { ImpulseRecord, PricePlatform, PriceRecord, PriceTrack, WishlistItem } from '@/types/db'

const SEASON_LABEL: Record<string, string> = {
  year_round: '常年', summer: '夏季', winter: '冬季', specific: '特定',
}

const PLATFORM_LABEL: Record<PricePlatform, string> = {
  taobao: '淘宝', jd: '京东', dewu: '得物', other: '其他',
}

type Tab = 'wishlist' | 'track'

export function Wishlist() {
  const wishlistStore = useWishlistStore()
  const impulseStore  = useImpulseStore()
  const wishPoolStore = useWishPoolStore()
  const priceTrackStore = usePriceTrackStore()
  const location = useLocation()

  // Home's "去看看" on a price-drop card lands here with state.tab = 'track'.
  const initialTab: Tab = (location.state as { tab?: Tab } | null)?.tab === 'track' ? 'track' : 'wishlist'
  const [tab, setTab] = useState<Tab>(initialTab)
  // 待购详情：点列表项打开底部 sheet。
  const [detailId, setDetailId] = useState<string | null>(null)

  const activeItems    = wishlistStore.items.filter((i) => i.status === 'active')
  const pendingImpulse = impulseStore.items.filter((i) => i.status === 'pending')
  const tracks         = priceTrackStore.tracks

  return (
    <div className="flex flex-col gap-5 pt-6 w-full max-w-[640px] mx-auto px-6">
      <h1 className="text-base font-medium text-ink">清单</h1>

      {/* 待购 / 蹲蹲 tabs */}
      <div className="flex gap-1 rounded-xl bg-card-alt p-1">
        <TabButton active={tab === 'wishlist'} onClick={() => setTab('wishlist')}>
          待购{activeItems.length > 0 && ` · ${activeItems.length}`}
        </TabButton>
        <TabButton active={tab === 'track'} onClick={() => setTab('track')}>
          蹲蹲{tracks.length > 0 && ` · ${tracks.length}`}
        </TabButton>
      </div>

      {tab === 'wishlist' ? (
        <>
          <section className="flex flex-col gap-3">
            {activeItems.length === 0 ? (
              <Card className="py-6 text-center text-[13px] text-ink-4">还没有待购商品 — 通过对话框添加，或从冷静期通过</Card>
            ) : (
              activeItems.map((item, i) => (
                <WishlistItemCard
                  key={item.id}
                  item={item}
                  isPoolFocus={wishPoolStore.pool?.focus_item_id === item.id}
                  isFirst={i === 0}
                  isLast={i === activeItems.length - 1}
                  onMoveUp={() => wishlistStore.move(item.id, 'up')}
                  onMoveDown={() => wishlistStore.move(item.id, 'down')}
                  onPin={async () => { await wishlistStore.pin(item); await wishPoolStore.load() }}
                  onDismiss={() => wishlistStore.dismiss(item.id)}
                  onOpen={() => setDetailId(item.id)}
                />
              ))
            )}
          </section>

          {pendingImpulse.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">
                冷静期中 · {pendingImpulse.length}
              </h2>
              {pendingImpulse.map((record) => (
                <ImpulseActiveCard key={record.id} record={record} onDismiss={() => impulseStore.dismiss(record.id)} />
              ))}
            </section>
          )}
        </>
      ) : (
        <section className="flex flex-col gap-3">
          {tracks.length === 0 ? (
            <Card className="py-6 text-center text-[13px] text-ink-4">
              还没在蹲的商品 — 在主页对话框上传截图或输入「商品名 + 当前价」，点「蹲一下价格」
            </Card>
          ) : (
            tracks.map((track) => (
              <TrackCard
                key={track.id}
                track={track}
                records={priceTrackStore.records[track.id] ?? []}
                onAddToWishlist={async () => {
                  await priceTrackStore.moveToWishlist(track.id)
                  await wishlistStore.load()
                }}
                onDismiss={() => priceTrackStore.dismiss(track.id)}
                onSetTarget={(target) => priceTrackStore.setTargetPrice(track.id, target)}
              />
            ))
          )}
        </section>
      )}

      {detailId && <WishlistDetailSheet itemId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 rounded-lg py-1.5 text-[13px] font-medium transition-colors',
        active ? 'bg-card text-ink shadow-sm' : 'text-ink-4 hover:text-ink-2',
      )}
    >
      {children}
    </button>
  )
}

function WishlistItemCard({ item, isPoolFocus, isFirst, isLast, onMoveUp, onMoveDown, onPin, onDismiss, onOpen }: {
  item: WishlistItem; isPoolFocus: boolean; isFirst: boolean; isLast: boolean
  onMoveUp: () => void; onMoveDown: () => void; onPin: () => Promise<void>; onDismiss: () => void
  onOpen: () => void
}) {
  const [pinning, setPinning] = useState(false)
  const [showWorth, setShowWorth] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  async function handlePin() {
    setPinning(true); setPinError(null)
    try { await onPin() }
    catch (err) { setPinError((err as Error).message || '设为目标失败，请重试') }
    finally { setPinning(false) }
  }

  return (
    <Card className={cn('transition-colors', isPoolFocus && 'bg-amber-50/60 border-amber-200')}>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <div
            className="flex-1 min-w-0 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
          >
            {item.image_url && (
              <img
                src={item.image_url}
                alt=""
                className="mb-2 h-16 w-16 rounded-lg bg-card-alt object-cover"
              />
            )}
            <p className="text-[15px] font-medium text-ink leading-snug">{item.item_name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {item.estimated_price != null && (
                <span className="font-serif text-[16px] text-ink-3">约 {formatAmount(item.estimated_price)}</span>
              )}
              <span className="rounded border-theme px-1.5 py-0.5 text-[11px] text-ink-4">
                {SEASON_LABEL[item.season_tag] ?? item.season_tag}
              </span>
              {item.worthiness_score != null && (
                <span className={cn('text-[11px] font-medium tabular-nums',
                  item.worthiness_score >= 8 ? 'text-amber-600' : item.worthiness_score >= 5 ? 'text-ink-2' : 'text-ink-4'
                )}>★ {item.worthiness_score}</span>
              )}
            </div>
            {item.worthiness_reason && (
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-4 italic">{item.worthiness_reason}</p>
            )}
            <CostLabels amount={item.estimated_price} />
          </div>
          <div className="flex shrink-0 items-start gap-1">
            <div className="flex flex-col">
              <button
                onClick={onMoveUp}
                disabled={isFirst}
                className="rounded-lg p-1 text-ink-4 transition-colors hover:bg-card-alt hover:text-ink-2 disabled:opacity-30 disabled:hover:bg-transparent"
                aria-label="上移"
              >
                <ChevronUp size={14} />
              </button>
              <button
                onClick={onMoveDown}
                disabled={isLast}
                className="rounded-lg p-1 text-ink-4 transition-colors hover:bg-card-alt hover:text-ink-2 disabled:opacity-30 disabled:hover:bg-transparent"
                aria-label="下移"
              >
                <ChevronDown size={14} />
              </button>
            </div>
            <button
              onClick={() => void handlePin()}
              disabled={pinning || isPoolFocus}
              className={cn('rounded-lg p-1.5 transition-colors', isPoolFocus ? 'text-amber-500' : 'text-ink-4 hover:bg-card-alt hover:text-ink-2')}
            >
              <Pin size={15} />
            </button>
            <button onClick={onDismiss} className="rounded-lg p-1.5 text-ink-4 hover:bg-card-alt hover:text-ink-2 transition-colors">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={() => setShowWorth((v) => !v)}
            className={cn('text-[12px] font-medium transition-colors', showWorth ? 'text-ink-2' : 'text-ink-4 hover:text-ink-2')}
          >
            值不值？
          </button>
        </div>

        {pinError && <p className="text-[12px] text-red-500">{pinError}</p>}

        {showWorth && <WorthItCard item={item} onClose={() => setShowWorth(false)} />}
      </CardContent>
    </Card>
  )
}

function ImpulseActiveCard({ record, onDismiss }: { record: ImpulseRecord; onDismiss: () => void }) {
  const remaining = getRemainingTime(record.expires_at)
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-medium text-ink-2">{record.item_name}</p>
          <div className="mt-1 flex items-center gap-2">
            {record.estimated_price != null && (
              <span className="font-serif text-[16px] text-ink-4">约 {formatAmount(record.estimated_price)}</span>
            )}
            <span className="flex items-center gap-1 text-[13px] text-ink-4">
              <Clock size={11} />{remaining}
            </span>
          </div>
          <CostLabels amount={record.estimated_price} />
        </div>
        <button onClick={onDismiss} className="shrink-0 text-ink-4 hover:text-ink-3 transition-colors">
          <X size={15} />
        </button>
      </CardContent>
    </Card>
  )
}

function getRemainingTime(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return '已到期'
  const h = Math.floor(ms / 3_600_000)
  return h < 24 ? `还剩 ${h}h` : `还剩 ${Math.floor(h / 24)}天`
}

/**
 * A single 蹲蹲 card: product + platform, days tracked, a price-trend line chart
 * (only with ≥2 data points), the textual price history, and the net change vs
 * the first recorded price. Two actions: 加入清单 / 不蹲了.
 */
function TrackCard({ track, records, onAddToWishlist, onDismiss, onSetTarget }: {
  track: PriceTrack
  records: PriceRecord[]
  onAddToWishlist: () => Promise<void>
  onDismiss: () => void
  onSetTarget: (target: number | null) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState<string>(track.target_price != null ? String(track.target_price) : '')
  const [savingTarget, setSavingTarget] = useState(false)
  async function commitTarget() {
    const val = target.trim() === '' ? null : Number(target)
    if (val != null && (!Number.isFinite(val) || val <= 0)) return
    if (val === (track.target_price ?? null)) return
    setSavingTarget(true)
    try { await onSetTarget(val) } finally { setSavingTarget(false) }
  }

  const days = daysSince(track.created_at)
  const prices = records.map((r) => r.price)
  const first = prices[0]
  const last = prices[prices.length - 1]
  const delta = first != null && last != null ? last - first : 0

  const chartData = records.map((r) => ({
    label: formatDay(r.recorded_at),
    price: r.price,
  }))

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[15px] font-medium text-ink leading-snug">{track.item_name}</p>
          <span className="shrink-0 rounded border-theme px-1.5 py-0.5 text-[11px] text-ink-4">
            {PLATFORM_LABEL[track.platform] ?? '其他'}
          </span>
        </div>
        <p className="-mt-1.5 text-[12px] text-ink-4">{days === 0 ? '今天开始蹲' : `已蹲 ${days} 天`}</p>

        {records.length >= 2 && (
          <div className="h-32 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--ink-4)' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: 'var(--ink-4)' }} tickLine={false} axisLine={false} width={44} domain={['auto', 'auto']} />
                <Tooltip
                  formatter={(v) => [formatAmount(Number(v)), '价格']}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid var(--border)' }}
                />
                <Line type="monotone" dataKey="price" stroke="#d97706" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Textual history — always shown; the only view when <2 points. */}
        <p className="font-serif text-[14px] text-ink-3">
          {prices.map((p) => formatAmount(p)).join(' → ')}
        </p>

        {delta !== 0 && (
          <p className={cn('text-[12px] font-medium', delta < 0 ? 'text-emerald-600' : 'text-red-500')}>
            {delta < 0
              ? `比最初低了 ${formatAmount(-delta)} ↓`
              : `比最初高了 ${formatAmount(delta)} ↑`}
          </p>
        )}

        {/* 目标价：填了之后降到该价主页提醒（蹲蹲 §3） */}
        <div className="flex items-center gap-2 border-t-theme pt-3 text-[13px]">
          <span className="text-ink-3">目标价</span>
          <span className="text-ink-4">¥</span>
          <input
            type="number"
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={() => void commitTarget()}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            placeholder="设个价"
            disabled={savingTarget}
            className="w-20 bg-transparent border-b-theme pb-0.5 text-ink outline-none transition-colors focus:border-b-[var(--text-muted)] placeholder:text-ink-4"
          />
          <span className="text-ink-4">设好了降价就提醒我</span>
        </div>

        <div className="mt-1 flex gap-2">
          <button
            onClick={async () => { setBusy(true); try { await onAddToWishlist() } finally { setBusy(false) } }}
            disabled={busy}
            className="flex-1 rounded-lg border-theme bg-card-alt py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink disabled:opacity-50"
          >
            加入清单
          </button>
          <button
            onClick={onDismiss}
            disabled={busy}
            className="flex-1 rounded-lg border-theme py-2 text-[13px] text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-50"
          >
            不蹲了
          </button>
        </div>
      </CardContent>
    </Card>
  )
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

/** Short "M/D" label for chart axis + tooltip. */
function formatDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}
