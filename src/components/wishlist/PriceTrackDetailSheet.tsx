import { useEffect, useRef, useState } from 'react'
import { X, ImageIcon, Trash2, Check, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { usePriceTrackStore } from '@/store/priceTrack'
import { useSettingsStore } from '@/store/settings'
import { uploadWishlistImage } from '@/lib/wishlistImage'
import { extractWishlistFields } from '@/lib/wishlistExtract'
import { formatAmount } from '@/lib/utils'

/**
 * 蹲蹲详情页 — opened by tapping an item in the 蹲蹲 list. Deliberately simpler than
 * the 待购 detail: it's focused on price tracking, not the full 值不值 analysis.
 *
 * Shows the 主图 (with the same 截图上传 + AI 填写 flow as 待购, reusing analyzeImage
 * + uploadWishlistImage), editable 名称/品牌, the read-only 记录价 (the price at
 * creation), a manual 当前价 update that appends a new row to the price history, the
 * user-set 目标价, and the price history (newest first, max 10). Bottom actions:
 * 删除 / 标记已买到 — both stop tracking (there is no "bought" status on a track, so
 * both remove it; the two buttons just capture the different intent).
 *
 * AI 截图解析对蹲蹲只回填 名称/品牌/主图 —— 价格是手动追踪的，绝不让 AI 改价格。
 */
export function PriceTrackDetailSheet({ trackId, onClose }: { trackId: string; onClose: () => void }) {
  const track = usePriceTrackStore((s) => s.tracks.find((t) => t.id === trackId))
  const records = usePriceTrackStore((s) => s.records[trackId] ?? [])
  const update = usePriceTrackStore((s) => s.update)
  const addPriceRecord = usePriceTrackStore((s) => s.addPriceRecord)
  const setTargetPrice = usePriceTrackStore((s) => s.setTargetPrice)
  const dismiss = usePriceTrackStore((s) => s.dismiss)
  // The screenshot extraction calls our /api/analyze-image function (Qwen vision)
  // with the user's own key in the body — so we read the raw key, not the adapter.
  const aiApiKey = useSettingsStore((s) => s.aiApiKey)

  const [aiBusy, setAiBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState<null | 'delete' | 'bought'>(null)
  const [priceDraft, setPriceDraft] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track gone (deleted here or elsewhere) → close.
  useEffect(() => { if (!track) onClose() }, [track, onClose])
  useEffect(() => () => {
    abortRef.current?.abort()
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  if (!track) return null
  const t = track // narrowed, stable for the closures below

  function flash(msg: string) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  async function saveField(patch: Parameters<typeof update>[1]) {
    setError(null)
    try { await update(t.id, patch) }
    catch (e) { setError((e as Error).message || '保存失败，请重试') }
  }

  // 「上传截图让 AI 填写」: for 蹲蹲 we only touch 名称/品牌/主图 — price is manually
  // tracked, so AI never writes a price field. Conservative merge (a secondary
  // upload often returns junk for unrelated fields): only fill 名称/品牌 when empty,
  // and promote the upload to 主图 when it's a product photo or there's no image yet.
  async function runAiExtract(file: File) {
    if (!aiApiKey) { setError('请先在设置里填写 API Key'); return }

    setError(null); setAiBusy(true)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const fields = await extractWishlistFields(aiApiKey, file, ctrl.signal)

      const patch: Parameters<typeof update>[1] = {}
      if (shouldUpdate(t.item_name, fields.name)) patch.item_name = fields.name!
      if (shouldUpdate(t.brand, fields.brand)) patch.brand = fields.brand!

      let uploadError: string | null = null
      if (fields.is_product_photo || !t.image_url) {
        try { patch.image_url = await uploadWishlistImage(file, t.id) }
        catch (e) { uploadError = (e as Error).message || '图片上传失败' }
      }

      const count = Object.keys(patch).length
      if (count > 0) await update(t.id, patch)
      if (uploadError) setError(uploadError)
      else flash(count > 0 ? `已更新 ${count} 个字段` : 'AI 没识别出可填的信息')
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

  // 当前价更新 → 追加一条价格历史记录（不是改字段）。沿用 track 自己的平台。
  async function handleUpdatePrice() {
    const n = Number(priceDraft)
    if (!priceDraft.trim() || !Number.isFinite(n) || n <= 0) {
      setError('请输入有效的价格'); return
    }
    setError(null); setSavingPrice(true)
    try {
      await addPriceRecord(t.id, n, t.platform)
      setPriceDraft('')
      flash('已记录这次价格')
    } catch (e) {
      setError((e as Error).message || '记录价格失败，请重试')
    } finally {
      setSavingPrice(false)
    }
  }

  async function handleSaveTarget(raw: string) {
    const val = raw.trim() === '' ? null : Number(raw)
    if (val != null && (!Number.isFinite(val) || val <= 0)) return
    if (val === (t.target_price ?? null)) return
    setError(null)
    try { await setTargetPrice(t.id, val) }
    catch (e) { setError((e as Error).message || '保存失败，请重试') }
  }

  async function handleRemove(mode: 'delete' | 'bought') {
    if (acting) return
    setActing(mode)
    try { await dismiss(t.id); onClose() }
    catch (e) { setError((e as Error).message || '操作失败'); setActing(null) }
  }

  const busy = !!acting || aiBusy || savingPrice
  // 记录价：创建时记下的第一条价格（records 升序，[0] 是最早的一条）。
  const firstPrice = records[0]?.price ?? null
  // 当前价：track 的去规范化字段优先，没有就退回最新一条记录。
  const currentPrice = t.current_price ?? records[records.length - 1]?.price ?? null
  // 价格历史：最新在前，最多 10 条。
  const history = [...records].reverse().slice(0, 10)

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
          <h3 className="text-[17px] font-medium text-ink">蹲蹲详情</h3>
          <button onClick={onClose} disabled={busy} className="text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {/* 商品主图 / placeholder */}
          {t.image_url ? (
            <img
              src={t.image_url}
              alt={t.item_name}
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
            <Field label="名称" value={t.item_name} placeholder="未命名"
              onSave={(raw) => { if (raw) void saveField({ item_name: raw }) }} />
            <Field label="品牌" value={t.brand ?? ''} placeholder="未填写"
              onSave={(raw) => void saveField({ brand: raw || null })} />
          </Section>

          {/* 价格 */}
          <Section title="价格">
            <div className="flex items-center justify-between border-b-theme py-2.5">
              <span className="shrink-0 text-[13px] text-ink-4">记录价</span>
              <span className="text-[14px] text-ink-3">{firstPrice != null ? formatAmount(firstPrice) : '—'}</span>
            </div>
            <div className="flex items-center justify-between border-b-theme py-2.5">
              <span className="shrink-0 text-[13px] text-ink-4">当前价</span>
              <span className="font-serif text-[16px] text-ink">{currentPrice != null ? formatAmount(currentPrice) : '—'}</span>
            </div>
            <Field
              label="目标价" numeric
              value={t.target_price != null ? String(t.target_price) : ''}
              display={t.target_price != null ? formatAmount(t.target_price) : ''}
              placeholder="设个价，降到就提醒"
              onSave={(raw) => void handleSaveTarget(raw)}
            />
          </Section>

          {/* 更新当前价 → 追加一条价格记录 */}
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-card-alt px-3.5 py-3">
            <span className="text-[13px] text-ink-4">记一次新价</span>
            <span className="text-ink-4">¥</span>
            <input
              type="number"
              inputMode="decimal"
              value={priceDraft}
              onChange={(e) => setPriceDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleUpdatePrice() }}
              placeholder="当前价"
              disabled={busy}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
            />
            <Button size="sm" onClick={() => void handleUpdatePrice()} disabled={busy || !priceDraft.trim()}>
              {savingPrice ? '记录中…' : '更新'}
            </Button>
          </div>

          {/* 价格历史 — 最新在前，最多 10 条 */}
          <Section title="价格历史">
            {history.length === 0 ? (
              <p className="py-2.5 text-[13px] text-ink-4">还没有价格记录</p>
            ) : (
              history.map((r) => (
                <div key={r.id} className="flex items-center justify-between border-b-theme py-2.5 last:border-b-0">
                  <span className="text-[13px] text-ink-4">{formatDateTime(r.recorded_at)}</span>
                  <span className="font-serif text-[15px] text-ink-2">{formatAmount(r.price)}</span>
                </div>
              ))
            )}
          </Section>
        </div>

        {/* 底部操作：删除 / 标记已买到 */}
        <div className="flex gap-2 border-t-theme px-6 py-4">
          <Button variant="outline" className="flex-1" onClick={() => void handleRemove('delete')} disabled={busy}>
            <Trash2 size={15} className="mr-1.5" />
            {acting === 'delete' ? '删除中…' : '删除'}
          </Button>
          <Button className="flex-1" onClick={() => void handleRemove('bought')} disabled={busy}>
            <Check size={15} className="mr-1.5" />
            {acting === 'bought' ? '处理中…' : '标记已买到'}
          </Button>
        </div>
      </ImageDropZone>
    </div>
  )
}

// Generic placeholders the vision model spits out instead of a real value — never
// write any of these into a field.
const JUNK = ['ITEMINFO', '商品信息', '商品名称', '商品标题', '未知']
// Sentinel "empty" values a field may already hold that should still be fillable.
const PLACEHOLDER = ['未知商品', '未填写', '未命名', '未知']

/**
 * Whether an AI-extracted value should be written over what the track already has.
 * Conservative by design (secondary uploads return garbage for unrelated fields):
 * non-null, not a generic placeholder, and the field is currently empty.
 */
function shouldUpdate(existing: string | null, newVal: string | null): boolean {
  if (!newVal) return false
  if (JUNK.some((j) => newVal.includes(j))) return false
  const cur = existing?.trim()
  if (cur && !PLACEHOLDER.includes(cur)) return false
  return true
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
 * Inline-editable field. Tap the value to edit; commits on blur / Enter and only
 * writes when the trimmed value actually changed.
 */
function Field({ label, value, display, placeholder, numeric, onSave }: {
  label: string
  value: string
  display?: string
  placeholder: string
  numeric?: boolean
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

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
