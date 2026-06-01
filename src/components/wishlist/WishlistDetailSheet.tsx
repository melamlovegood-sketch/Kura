import { useEffect, useRef, useState } from 'react'
import { X, ImageIcon, Trash2, Check, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { WorthItCard } from '@/components/wishlist/WorthItCard'
import { useWishlistStore } from '@/store/wishlist'
import { useSettingsStore } from '@/store/settings'
import { uploadWishlistImage } from '@/lib/wishlistImage'
import { extractWishlistFields } from '@/lib/wishlistExtract'
import { formatAmount, cn } from '@/lib/utils'
import type { WishlistItem } from '@/types/db'

/**
 * 待购详情页 — opened by tapping an item in the 待购 list. Bottom sheet showing the
 * product photo, inline-editable basic info / attributes / notes, the 值不值 analysis
 * (reused), and an 「上传截图让 AI 填写」 action that vision-extracts fields. Bottom
 * actions: 删除 / 标记已购.
 *
 * Reads the live item from the store by id, so every inline edit and AI fill is
 * reflected immediately. When the item leaves the active list (deleted / bought),
 * the sheet closes itself.
 */
export function WishlistDetailSheet({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  const item = useWishlistStore((s) => s.items.find((i) => i.id === itemId))
  const update = useWishlistStore((s) => s.update)
  const dismiss = useWishlistStore((s) => s.dismiss)
  const markPurchased = useWishlistStore((s) => s.markPurchased)
  // The screenshot extraction calls our /api/analyze-image function (Qwen vision)
  // with the user's own key in the body — so we read the raw key, not the adapter.
  const aiApiKey = useSettingsStore((s) => s.aiApiKey)

  const [showWorth, setShowWorth] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<null | 'delete' | 'purchase'>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Item gone (deleted / marked bought, here or elsewhere) → close.
  useEffect(() => { if (!item) onClose() }, [item, onClose])
  useEffect(() => () => {
    abortRef.current?.abort()
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  if (!item) return null
  const it = item // narrowed, stable for the closures below

  function flash(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function saveField(patch: Partial<WishlistItem>) {
    setError(null)
    try { await update(it.id, patch) }
    catch (e) { setError((e as Error).message || '保存失败，请重试') }
  }

  // 「上传截图让 AI 填写」: extract fields from the screenshot, write back only the
  // non-null ones (never clobber what's already there). Upload + set as 主图 only
  // when the model says it's a product photo, not a label/tag. Shared by the
  // click-to-upload button and the drag-and-drop zone.
  async function runAiExtract(file: File) {
    if (!aiApiKey) { setError('请先在设置里填写 API Key'); return }

    setError(null); setAiBusy(true)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const fields = await extractWishlistFields(aiApiKey, file, ctrl.signal)

      const patch: Partial<WishlistItem> = {}
      if (fields.name) patch.item_name = fields.name
      if (fields.brand) patch.brand = fields.brand
      if (fields.price != null) patch.estimated_price = fields.price
      if (fields.category) patch.category = fields.category
      if (fields.fabric) patch.fabric = fields.fabric
      if (fields.color) patch.color = fields.color
      if (fields.size) patch.size = fields.size
      if (fields.channel) patch.channel = fields.channel

      // Only persist (and reference) the upload when it's a usable main photo.
      if (fields.is_product_photo) {
        try { patch.image_url = await uploadWishlistImage(file, it.id) }
        catch { /* upload failed — keep the extracted text fields */ }
      }

      const count = Object.keys(patch).length
      if (count > 0) await update(it.id, patch)
      flash(count > 0 ? `已更新 ${count} 个字段` : 'AI 没识别出可填的信息')
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

  async function handleDelete() {
    if (acting) return
    setActing('delete')
    try { await dismiss(it.id); onClose() }
    catch (e) { setError((e as Error).message || '删除失败'); setActing(null) }
  }

  async function handlePurchase() {
    if (acting) return
    setActing('purchase')
    try { await markPurchased(it.id); onClose() }
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
          <h3 className="text-[17px] font-medium text-ink">商品详情</h3>
          <button onClick={onClose} disabled={busy} className="text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {/* 商品主图 / placeholder */}
          {it.image_url ? (
            <img
              src={it.image_url}
              alt={it.item_name}
              className="mb-4 max-h-[260px] w-full rounded-xl bg-card-alt object-contain"
            />
          ) : (
            <div className="mb-4 flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl bg-card-alt text-ink-4">
              <ImageIcon size={28} strokeWidth={1.5} />
              <span className="text-[12px]">暂无主图</span>
            </div>
          )}

          {/* 上传截图让 AI 填写 — secondary style */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="mb-1 flex w-full items-center justify-center gap-1.5 rounded-lg border-theme py-2 text-[13px] text-ink-3 transition-colors hover:bg-card-alt hover:text-ink-2 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {aiBusy ? 'AI 分析中…' : '上传截图让 AI 填写'}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAiFile} />

          {toast && <p className="mt-3 text-center text-[13px] text-emerald-600">{toast}</p>}
          {error && <p className="mt-3 text-center text-[13px] text-red-500">{error}</p>}

          {/* 基本信息 */}
          <Section title="基本信息">
            <Field label="名称" value={it.item_name} placeholder="未命名"
              onSave={(raw) => { if (raw) void saveField({ item_name: raw }) }} />
            <Field label="品牌" value={it.brand ?? ''} placeholder="未填写"
              onSave={(raw) => void saveField({ brand: raw || null })} />
            <Field label="分类" value={it.category ?? ''} placeholder="未分类"
              onSave={(raw) => void saveField({ category: raw || null })} />
            <Field
              label="价格" numeric
              value={it.estimated_price != null ? String(it.estimated_price) : ''}
              display={it.estimated_price != null ? formatAmount(it.estimated_price) : ''}
              placeholder="未填写"
              onSave={(raw) => {
                const n = Number(raw)
                void saveField({ estimated_price: raw && Number.isFinite(n) && n > 0 ? n : null })
              }}
            />
          </Section>

          {/* 属性 */}
          <Section title="属性">
            <Field label="面料成分" value={it.fabric ?? ''} placeholder="未填写"
              onSave={(raw) => void saveField({ fabric: raw || null })} />
            <Field label="颜色" value={it.color ?? ''} placeholder="未填写"
              onSave={(raw) => void saveField({ color: raw || null })} />
            <Field label="尺码" value={it.size ?? ''} placeholder="未填写"
              onSave={(raw) => void saveField({ size: raw || null })} />
            <Field label="购买渠道" value={it.channel ?? ''} placeholder="未填写"
              onSave={(raw) => void saveField({ channel: raw || null })} />
          </Section>

          {/* 添加时间（只读） */}
          <Section title="其他">
            <div className="flex items-center justify-between py-2">
              <span className="text-[13px] text-ink-4">添加时间</span>
              <span className="text-[14px] text-ink-3">{formatDate(it.added_at)}</span>
            </div>
          </Section>

          {/* 备注 */}
          <div className="mt-4">
            <Field label="备注" multiline value={it.notes ?? ''} placeholder="点击添加备注…"
              onSave={(raw) => void saveField({ notes: raw || null })} />
          </div>

          {/* 值不值分析 */}
          <div className="mt-5">
            <button
              onClick={() => setShowWorth((v) => !v)}
              className={cn('text-[13px] font-medium transition-colors', showWorth ? 'text-ink-2' : 'text-ink-3 hover:text-ink-2')}
            >
              值不值分析 {showWorth ? '· 收起' : '· 展开'}
            </button>
            {showWorth && (
              <div className="mt-3">
                <WorthItCard item={it} onClose={() => setShowWorth(false)} />
              </div>
            )}
          </div>
        </div>

        {/* 底部操作：删除 / 标记已购 */}
        <div className="flex gap-2 border-t-theme px-6 py-4">
          <Button variant="outline" className="flex-1" onClick={() => void handleDelete()} disabled={busy}>
            <Trash2 size={15} className="mr-1.5" />
            {acting === 'delete' ? '删除中…' : '删除'}
          </Button>
          <Button className="flex-1" onClick={() => void handlePurchase()} disabled={busy}>
            <Check size={15} className="mr-1.5" />
            {acting === 'purchase' ? '处理中…' : '标记已购'}
          </Button>
        </div>
      </ImageDropZone>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">{title}</p>
      <div className="rounded-xl bg-card-alt px-3.5">{children}</div>
    </div>
  )
}

/**
 * Inline-editable field. Tap the value to edit; commits on blur / Enter (single
 * line) and only writes when the trimmed value actually changed. `multiline`
 * renders a labelled textarea block instead of a label/value row.
 */
function Field({ label, value, display, placeholder, numeric, multiline, onSave }: {
  label: string
  value: string
  display?: string
  placeholder: string
  numeric?: boolean
  multiline?: boolean
  onSave: (raw: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  // Keep the draft in sync with external updates (e.g. AI fill) while idle.
  useEffect(() => { if (!editing) setDraft(value) }, [value, editing])

  function commit() {
    setEditing(false)
    if (draft.trim() !== value.trim()) onSave(draft.trim())
  }

  if (multiline) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">{label}</span>
        {editing ? (
          <textarea
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            className="w-full resize-none rounded-xl border-theme bg-card-alt px-3.5 py-2.5 text-[14px] text-ink outline-none transition-colors focus:bg-card focus:ring-1 focus:ring-[var(--border)]"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className="rounded-xl bg-card-alt px-3.5 py-2.5 text-left text-[14px] transition-colors hover:bg-card"
          >
            {value
              ? <span className="whitespace-pre-wrap text-ink-2">{value}</span>
              : <span className="text-ink-4">{placeholder}</span>}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b-theme py-2.5 last:border-b-0">
      <span className="shrink-0 text-[13px] text-ink-4">{label}</span>
      {editing ? (
        <input
          autoFocus
          type={numeric ? 'number' : 'text'}
          inputMode={numeric ? 'decimal' : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          className="min-w-0 flex-1 bg-transparent text-right text-[14px] text-ink outline-none"
        />
      ) : (
        <button onClick={() => setEditing(true)} className="min-w-0 flex-1 truncate text-right text-[14px]">
          {value
            ? <span className="text-ink-2">{display ?? value}</span>
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
