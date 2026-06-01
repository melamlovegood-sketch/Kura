import { useEffect, useRef, useState } from 'react'
import { X, ImageIcon, Trash2, Check, Sparkles, ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { ShareCardSheet } from '@/components/share/ShareCardSheet'
import { WishPoolShareCard } from '@/components/share/WishPoolShareCard'
import { useWishlistStore } from '@/store/wishlist'
import { useWishPoolStore } from '@/store/wishpool'
import { useSettingsStore } from '@/store/settings'
import { useCountUp } from '@/hooks/useCountUp'
import { db } from '@/lib/db'
import { uploadWishlistImage } from '@/lib/wishlistImage'
import { extractWishlistFields } from '@/lib/wishlistExtract'
import { formatAmount, cn } from '@/lib/utils'
import type { WishPoolData, WishlistItem } from '@/types/db'

/** One 忍住了 record under the active pool (商品名 + 金额 + 日期). */
export interface ResistRow {
  id: string
  amount: number
  description: string | null
  recorded_at: string
}

/** The item name a 忍住 record was made for — strips the stored "忍住了：" prefix. */
export function resistName(r: ResistRow): string {
  return (r.description ?? '').replace(/^忍住了：/, '') || '忍住了一笔'
}

/**
 * 「还差 ¥X · 再忍 N 个<最近忍住的商品>」. The cup count divides the remaining amount
 * by the most-recent 忍住 record's amount (四舍五入), labelled with that record's
 * product name. With no 忍住 records yet (or a non-positive amount) it degrades to
 * just 「还差 ¥X」 (SPEC: 没有忍住记录就只显示还差金额).
 */
export function resistRemainHint(
  remaining: number,
  latest: { amount: number; name: string } | null,
): string {
  const base = `还差 ${formatAmount(remaining)}`
  if (!latest || latest.amount <= 0) return base
  const cups = Math.round(remaining / latest.amount)
  if (cups <= 0) return base
  return `${base} · 再忍 ${cups} 个${latest.name}`
}

/**
 * 许愿池详情页 — opened by tapping the home wish-pool card. Bottom sheet showing the
 * 主图 (with a 许愿中 badge), an 「上传截图让 AI 填写」 action (fills 名称/品牌/主图 on the
 * focus 待购 item only — never the money fields), inline-editable 名称/品牌, the 存钱
 * progress module, the reverse-chronological 忍住记录 list, and 删除 / 已达成 actions.
 *
 * The pool's product fields live on its focus wishlist_item, so name/brand/image
 * edits go through the wishlist store; the saved/target amounts come live from the
 * wish-pool store (refreshes as new 忍住 records land).
 */
export function WishPoolDetailSheet({ pool, onClose }: { pool: WishPoolData; onClose: () => void }) {
  const focusItem = useWishlistStore((s) => s.items.find((i) => i.id === pool.focus_item_id))
  const updateItem = useWishlistStore((s) => s.update)
  const livePool = useWishPoolStore((s) => s.pool)
  const deletePool = useWishPoolStore((s) => s.deletePool)
  const markReached = useWishPoolStore((s) => s.markReached)
  // /api/analyze-image (Qwen vision) takes the user's own key in the body.
  const aiApiKey = useSettingsStore((s) => s.aiApiKey)

  // Prefer the live store pool (its saved_amount updates as 忍住 records land) but
  // fall back to the prop so the sheet still renders if the store pool changed.
  const p = livePool && livePool.id === pool.id ? livePool : pool

  const [resists, setResists] = useState<ResistRow[] | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<null | 'delete' | 'reached'>(null)
  const [share, setShare] = useState<{ count: number; total: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    abortRef.current?.abort()
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  // Pull the 忍住 records (newest first) on open and whenever a new one lands.
  useEffect(() => {
    let cancelled = false
    void db
      .from('savings_records')
      .select('id, amount, description, recorded_at')
      .eq('wish_pool_id', p.id)
      .order('recorded_at', { ascending: false })
      .then(({ data }: { data: ResistRow[] | null }) => {
        if (!cancelled) setResists(data ?? [])
      })
    return () => { cancelled = true }
  }, [p.id, p.saved_amount])

  const name = focusItem?.item_name ?? p.focus_item_name
  const brand = focusItem?.brand ?? null
  const imageUrl = focusItem?.image_url ?? null

  const pct       = p.target_amount > 0 ? Math.min((p.saved_amount / p.target_amount) * 100, 100) : 0
  const remaining = Math.max(p.target_amount - p.saved_amount, 0)
  const completed = p.target_amount > 0 && p.saved_amount >= p.target_amount
  const count     = resists?.length ?? 0
  const latest    = resists && resists[0]
    ? { amount: Number(resists[0].amount), name: resistName(resists[0]) }
    : null
  const animSaved = useCountUp(p.saved_amount)

  function flash(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function saveField(patch: Partial<WishlistItem>) {
    if (!focusItem) return
    setError(null)
    try { await updateItem(focusItem.id, patch) }
    catch (e) { setError((e as Error).message || '保存失败，请重试') }
  }

  // 「上传截图让 AI 填写」: extract fields and write back ONLY 名称/品牌/主图 — the money
  // fields (target / saved) are never touched. 主图 is set only when the item has no
  // existing image (a secondary upload must not replace a good main photo).
  async function runAiExtract(file: File) {
    if (!focusItem) { setError('找不到关联的待购商品'); return }
    if (!aiApiKey) { setError('请先在设置里填写 API Key'); return }

    setError(null); setAiBusy(true)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const fields = await extractWishlistFields(aiApiKey, file, ctrl.signal)
      console.log('AI fields:', JSON.stringify(fields))

      const patch: Partial<WishlistItem> = {}
      if (shouldUpdate(focusItem.item_name, fields.name)) patch.item_name = fields.name!
      if (shouldUpdate(focusItem.brand, fields.brand)) patch.brand = fields.brand!

      let uploadError: string | null = null
      if (!focusItem.image_url) {
        try { patch.image_url = await uploadWishlistImage(file, focusItem.id) }
        catch (e) { uploadError = (e as Error).message || '图片上传失败' }
      }

      const n = Object.keys(patch).length
      if (n > 0) await updateItem(focusItem.id, patch)
      if (uploadError) setError(uploadError)
      else flash(n > 0 ? `已更新 ${n} 个字段` : 'AI 没识别出可填的信息')
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message || 'AI 分析失败，请重试')
    } finally {
      setAiBusy(false)
    }
  }

  function handleAiFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) void runAiExtract(file)
  }

  async function openShare() {
    const { data } = await db.from('savings_records').select('amount').eq('wish_pool_id', p.id)
    const rows = (data as { amount: number | string }[] | null) ?? []
    setShare({ count: rows.length, total: rows.reduce((s, r) => s + Number(r.amount), 0) })
  }

  async function handleDelete() {
    if (acting) return
    setActing('delete')
    try { await deletePool(p.id, p.focus_item_id); onClose() }
    catch (e) { setError((e as Error).message || '删除失败'); setActing(null) }
  }

  async function handleReached() {
    if (acting) return
    setActing('reached')
    try { await markReached(p.id); onClose() }
    catch (e) { setError((e as Error).message || '操作失败'); setActing(null) }
  }

  const busy = !!acting || aiBusy

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30"
      style={{ animation: 'sheet-backdrop-in 0.2s ease-out' }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <ImageDropZone
        onFile={(_base64, file) => void runAiExtract(file)}
        overlayContent={<span className="text-sm text-ink-3">松开，让 AI 识别商品</span>}
        className="flex max-h-[92vh] w-full max-w-[640px] flex-col rounded-t-2xl bg-card [animation:sheet-slide-up_0.28s_cubic-bezier(0.32,0.72,0,1)]"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h3 className="text-[17px] font-medium text-ink">许愿池</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void openShare()}
              disabled={busy}
              className="flex items-center gap-0.5 text-[13px] text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40"
            >
              <ArrowUpRight size={14} /> 分享进度
            </button>
            <button onClick={onClose} disabled={busy} className="text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {/* 主图区（160px 高）+ 许愿中 badge */}
          <div className="relative mb-4 h-40 w-full overflow-hidden rounded-xl bg-card-alt">
            {imageUrl ? (
              <img src={imageUrl} alt={name} className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-ink-4">
                <ImageIcon size={28} strokeWidth={1.5} />
                <span className="text-[12px]">暂无主图</span>
              </div>
            )}
            <span className="absolute bottom-2 right-2 rounded-full bg-amber-500/90 px-2.5 py-1 text-[11px] font-medium text-white">
              许愿中
            </span>
          </div>

          {/* 上传截图让 AI 填写 */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy || !focusItem}
            className="mb-1 flex w-full items-center justify-center gap-1.5 rounded-lg border-theme py-2 text-[13px] text-ink-3 transition-colors hover:bg-card-alt hover:text-ink-2 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {aiBusy ? 'AI 分析中…' : '上传截图让 AI 填写'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAiFile} />

          {toast && <p className="mt-3 text-center text-[13px] text-emerald-600">{toast}</p>}
          {error && <p className="mt-3 text-center text-[13px] text-red-500">{error}</p>}

          {/* 商品名 + 品牌（tap to edit） */}
          <Section title="基本信息">
            <EditableField
              label="名称" value={name} placeholder="未命名" disabled={!focusItem}
              onSave={(raw) => { if (raw) void saveField({ item_name: raw }) }}
            />
            <EditableField
              label="品牌" value={brand ?? ''} placeholder="未填写" disabled={!focusItem}
              onSave={(raw) => void saveField({ brand: raw || null })}
            />
          </Section>

          {/* 存钱进度模块 */}
          <div className="mt-5 rounded-xl bg-card-alt p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">已存入</p>
            <p className="mt-1">
              <span className="font-serif text-[28px] leading-none text-ink tabular-nums">{formatAmount(animSaved)}</span>
              <span className="font-serif text-[15px] text-ink-4"> / {formatAmount(p.target_amount)}</span>
            </p>

            <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-[#F5DEB3]">
              <div
                className={cn('h-full rounded-full transition-all duration-700 ease-out', completed ? 'bg-amber-500' : 'bg-amber-400')}
                style={{ width: `${pct}%` }}
              />
            </div>

            <div className="mt-2.5 flex items-center justify-between text-[13px] text-ink-3">
              <span>忍住了 {count} 次</span>
              <span className="truncate pl-3 text-ink-4">
                {completed ? '目标达成 ✓' : resistRemainHint(remaining, latest)}
              </span>
            </div>
          </div>

          {/* 忍住记录列表（倒序） */}
          <Section title="忍住记录">
            {resists == null ? (
              <p className="py-3 text-center text-[13px] text-ink-4">加载中…</p>
            ) : resists.length === 0 ? (
              <p className="py-3 text-center text-[13px] text-ink-4">还没有忍住记录</p>
            ) : (
              <ul className="flex flex-col">
                {resists.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-3 border-b-theme py-2.5 last:border-b-0">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] text-ink-2">{resistName(r)}</p>
                      <p className="mt-0.5 text-[12px] text-amber-600">存入 {formatAmount(Number(r.amount))}</p>
                    </div>
                    <span className="shrink-0 text-[12px] text-ink-4">{formatDate(r.recorded_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        {/* 底部操作：删除 / 已达成 */}
        <div className="flex gap-2 border-t-theme px-6 py-4">
          <Button variant="outline" className="flex-1" onClick={() => void handleDelete()} disabled={busy}>
            <Trash2 size={15} className="mr-1.5" />
            {acting === 'delete' ? '删除中…' : '删除'}
          </Button>
          <Button className="flex-1" onClick={() => void handleReached()} disabled={busy}>
            <Check size={15} className="mr-1.5" />
            {acting === 'reached' ? '处理中…' : '已达成'}
          </Button>
        </div>
      </ImageDropZone>

      {share && (
        <ShareCardSheet onClose={() => setShare(null)} filename="kura-许愿池进度">
          <WishPoolShareCard
            focusItemName={name}
            targetAmount={p.target_amount}
            savedAmount={p.saved_amount}
            savingsCount={share.count}
            savingsTotal={share.total}
          />
        </ShareCardSheet>
      )}
    </div>
  )
}

// Generic placeholders the vision model spits out instead of a real value — never
// write any of these into a field. Mirrors WishlistDetailSheet.
const JUNK = ['ITEMINFO', '商品信息', '商品名称', '商品标题', '未知']
const PLACEHOLDER = ['未知商品', '未填写', '未命名', '未分类', '未知']

/** Whether an AI-extracted value should overwrite what the item already has. */
function shouldUpdate(existing: string | null, newVal: string | null): boolean {
  if (!newVal) return false
  if (JUNK.some((j) => newVal.includes(j))) return false
  const cur = existing?.trim()
  if (cur && !PLACEHOLDER.includes(cur)) return false
  return true
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">{title}</p>
      <div className="rounded-xl bg-card-alt px-3.5">{children}</div>
    </div>
  )
}

/** Inline-editable label/value row; commits on blur / Enter when the value changed. */
function EditableField({ label, value, placeholder, disabled, onSave }: {
  label: string
  value: string
  placeholder: string
  disabled?: boolean
  onSave: (raw: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  function commit() {
    setEditing(false)
    if (draft.trim() !== value.trim()) onSave(draft.trim())
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b-theme py-2.5 last:border-b-0">
      <span className="shrink-0 text-[13px] text-ink-4">{label}</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="min-w-0 flex-1 bg-transparent text-right text-[14px] text-ink outline-none"
        />
      ) : (
        <button
          onClick={() => { if (!disabled) setEditing(true) }}
          disabled={disabled}
          className="min-w-0 flex-1 truncate text-right text-[14px] disabled:cursor-default"
        >
          {value
            ? <span className="text-ink-2">{value}</span>
            : <span className="text-ink-4">{placeholder}</span>}
        </button>
      )}
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
