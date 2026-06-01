import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Paperclip, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { useSettingsStore } from '@/store/settings'
import { usePrinciplesStore } from '@/store/principles'
import { useWishlistStore } from '@/store/wishlist'
import { useWishPoolStore } from '@/store/wishpool'
import { usePriceTrackStore } from '@/store/priceTrack'
import { useAchievementsStore } from '@/store/achievements'
import { parseProduct, type ParsedProduct } from '@/lib/parseProduct'
import { analyzeImage, strOrNull, numOrNull } from '@/lib/analyzeImage'
import { uploadWishlistImage } from '@/lib/wishlistImage'
import { parsePriceTrack } from '@/lib/parsePriceTrack'
import { parseBudgetUpdate } from '@/lib/parseBudgetUpdate'
import { useBudgetStore } from '@/store/budget'
import { fileToBase64, formatAmount } from '@/lib/utils'
import type { BudgetData, CategoryMain, ParsedBudgetUpdate } from '@/types/db'

type Product = ParsedProduct
type Exit = 'impulse' | 'wishlist' | 'buy' | 'track' | 'budget'

function budgetCurrentLabel(data: BudgetData | null, scope: CategoryMain): string {
  if (!data) return '未设置'
  const v = scope === 'basic_life' ? data.basic_life_limit : data.discretionary_limit
  return v != null ? formatAmount(v) : '未设置'
}

/**
 * The single bottom-sheet entry behind the home "我现在想买……" button. Reuses the
 * original AI dialog's input mechanics (free text + screenshot upload) and the
 * `routeIntent` parser unchanged; the parsed product then flows to one of THREE
 * user-chosen exits (bug8) — the app never auto-decides a cooldown by category:
 *
 *   忍住，先忍忍   → 即时决定，不调 AI：弹「忍住了多少钱」确认框，确认后把这笔
 *                    钱攒进许愿池 (savings_records)，绝不写 wishlist_items，也不写
 *                    impulse_records——「忍住」就是一次了结，只攒钱、触发里程碑彩蛋
 *   加进清单再想想 → 待购清单 (wishlist_items, the active reconsideration list)
 *   确定要买，记一笔 → 执行层记账 (skip the cooldown entirely, record the buy)
 */
export function BuyDrawer({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  // `adapter` drives the text-only intent router; `aiApiKey` is passed straight to
  // the /api/analyze-image vision proxy when the input is a screenshot.
  const { adapter, aiApiKey } = useSettingsStore()
  const principlesStore = usePrinciplesStore()
  const wishlistStore = useWishlistStore()
  const wishPoolStore = useWishPoolStore()
  const priceTrackStore = usePriceTrackStore()
  const budgetStore = useBudgetStore()

  const [text, setText] = useState('')
  const [image, setImage] = useState<{ file: File; base64: string } | null>(null)
  const [parsed, setParsed] = useState<Product | null>(null)
  // Which exit is mid-flight, so we can show a per-button busy state while the
  // AI parse / write runs.
  const [busy, setBusy] = useState<null | Exit>(null)
  const [error, setError] = useState<string | null>(null)
  // 蹲一下 result message — kept inline so the user sees what was recorded.
  const [notice, setNotice] = useState<string | null>(null)
  // 「忍住」确认框：是否展开 + 忍住的金额（从输入正则预填，可改）。
  const [holdOpen, setHoldOpen] = useState(false)
  const [holdAmount, setHoldAmount] = useState(0)
  const [budgetDraft, setBudgetDraft] = useState<ParsedBudgetUpdate | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasInput = !!text.trim() || !!image

  const looksLikeBudget =
    !image &&
    (/(预算|额度|上限)/.test(text) || (/(限|改成|调到|设为|调整)/.test(text) && /\d/.test(text)))

  function handleFileSelect(base64: string, file: File) {
    setImage({ file, base64 })
    setParsed(null) // input changed → previous parse is stale
    setError(null)
    setNotice(null)
  }

  async function handleInputFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    handleFileSelect(await fileToBase64(file), file)
    e.target.value = ''
  }

  /**
   * Parse the current input into a product, reusing a previous parse if the input
   * hasn't changed. Returns null only when there is nothing to act on.
   */
  async function ensureParsed(): Promise<Product | null> {
    if (parsed) return parsed
    if (!hasInput) return null

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setError(null)

    let product: Product
    if (image) {
      // Screenshot → extract the product through the Qwen vision proxy
      // (/api/analyze-image). Prefer the model's name, fall back to typed text.
      if (!aiApiKey) { setError('请先在设置里填写 API Key'); return null }
      const fields = await analyzeImage(image.file, aiApiKey, ctrl.signal)
      console.log('AI fields:', JSON.stringify(fields))
      const name = strOrNull(fields.name) ?? text.trim()
      if (!name.trim()) {
        throw new Error('没能从截图里识别出商品，换张更清晰的图，或补一句文字描述')
      }
      product = { item_name: name, estimated_price: numOrNull(fields.price) }
    } else {
      // Text-only → intent router (server-proxied via /api/dashscope).
      if (!adapter) { setError('请先在设置里填写 API Key'); return null }
      const principles = principlesStore.items.map((p) => p.content)
      product = await parseProduct(adapter, text, undefined, ctrl.signal, principles)
    }

    setParsed(product)
    return product
  }

  /** Run an exit: parse first (shared), then route to the chosen destination. */
  async function runExit(exit: Exit, act: (p: Product) => Promise<void> | void) {
    if (busy) return
    setBusy(exit)
    try {
      const product = await ensureParsed()
      if (!product) return
      await act(product)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(`出错了：${(err as Error).message || '请稍后重试'}`)
    } finally {
      setBusy(null)
    }
  }

  // 忍住，先忍忍 → 即时决定，不走 AI 解析。直接用正则从输入里抓金额预填到确认框，
  // 让用户确认「忍住了多少钱」后再落库。
  function handleImpulse() {
    if (busy) return
    const m = text.match(/[¥￥]?\s*(\d+(?:\.\d+)?)/)
    setHoldAmount(m ? Number(m[1]) : 0)
    setHoldOpen(true)
  }

  // 确认忍住 → 只把这笔钱攒进许愿池（有目标直接攒入，没目标先暂存，等目标确立后
  // 回填）。绝不写 wishlist_items，也不写 impulse_records。
  async function handleHoldConfirm() {
    if (busy) return
    setBusy('impulse')
    try {
      const itemName = text.trim() || '忍住了一笔'
      if (holdAmount > 0) {
        const desc = `忍住了：${itemName}`
        if (wishPoolStore.pool) await wishPoolStore.addSavings(holdAmount, desc)
        else wishPoolStore.stashSavings(holdAmount, desc)
        // Re-check achievements so 「第一颗栗子」/「铁石心肠」 unlock (and toast)
        // right away instead of waiting for the next app launch.
        void useAchievementsStore.getState().recompute()
      }
      setHoldOpen(false)
      onClose()
    } catch (err) {
      setError(`出错了：${(err as Error).message || '请稍后重试'}`)
    } finally {
      setBusy(null)
    }
  }

  // 加进清单再想想 → 待购清单。若用户上传了截图，把它作为商品主图存进 Storage 并
  // 回填 image_url，这样详情页能直接显示（bug1：之前截图只用于解析，从不保存）。
  function handleWishlist() {
    return runExit('wishlist', async (product) => {
      const created = await wishlistStore.add({
        item_name: product.item_name,
        estimated_price: product.estimated_price,
        category: null,
        season_tag: 'year_round',
        need_intensity: null,
        worthiness_score: null,
        worthiness_reason: null,
      })
      if (created && image) {
        // Non-fatal: the item already exists; a failed upload just leaves it
        // without a 主图 rather than blocking the add.
        try {
          const url = await uploadWishlistImage(image.file, created.id)
          await wishlistStore.update(created.id, { image_url: url })
        } catch { /* ignore — item saved, image optional */ }
      }
      onClose()
    })
  }

  // 确定要买，记一笔 → 执行层记账（不进冷静期）
  function handleBuy() {
    return runExit('buy', (product) => {
      onClose()
      navigate('/execution', {
        state: { prefill: { category: product.item_name, estimatedPrice: product.estimated_price, skipToRecording: true } },
      })
    })
  }

  // 蹲一下价格 → 解析商品/价格/平台，AI 判断是否同款，追加或新建蹲蹲记录。
  // 不走 runExit/ensureParsed：这里用专门的 parsePriceTrack 提取平台字段。
  async function handleTrack() {
    if (busy) return
    if (!adapter) { setError('请先在设置里填写 API Key'); return }
    setBusy('track'); setError(null); setNotice(null)

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    try {
      const p = await parsePriceTrack(adapter, text, image?.base64, ctrl.signal)
      if (p.price == null) {
        setError('没识别到价格，试试「商品名 + 当前价格」，比如「耐克跑鞋 599」')
        return
      }
      const { action, track } = await priceTrackStore.intake(adapter, p.item_name, p.price, p.platform)
      setNotice(
        action === 'updated'
          ? `已更新 ${track.item_name} 的价格记录 · 当前 ${formatAmount(p.price)}`
          : `已开始蹲 ${track.item_name}，当前 ${formatAmount(p.price)}`,
      )
      // Clear the input so a second screenshot can be logged without stale text.
      setText(''); setImage(null); setParsed(null)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(`出错了：${(err as Error).message || '请稍后重试'}`)
    } finally {
      setBusy(null)
    }
  }

  // 一句话改预算（功能5）：解析→确认卡→写库。
  async function handleBudget() {
    if (busy) return
    if (!adapter) { setError('请先在设置里填写 API Key'); return }
    setBusy('budget'); setError(null); setNotice(null)
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const upd = await parseBudgetUpdate(adapter, text, ctrl.signal)
      if (!upd) { setError('没识别出要改哪项预算，试试「可支配预算改成1500」'); return }
      setBudgetDraft(upd)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(`出错了：${(err as Error).message || '请稍后重试'}`)
    } finally {
      setBusy(null)
    }
  }

  async function handleBudgetConfirm() {
    if (!budgetDraft || busy) return
    setBusy('budget')
    try {
      await budgetStore.updateLimit(budgetDraft.scope, budgetDraft.limit)
      onClose()
    } catch (err) {
      setError(`出错了：${(err as Error).message || '请稍后重试'}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30"
      style={{ animation: 'sheet-backdrop-in 0.2s ease-out' }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <ImageDropZone
        onFile={handleFileSelect}
        className="w-full max-w-[640px] rounded-t-2xl bg-card px-6 pt-5 pb-8 [animation:sheet-slide-up_0.28s_cubic-bezier(0.32,0.72,0,1)]"
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[17px] font-medium text-ink">我现在想买……</h3>
          <button onClick={onClose} disabled={!!busy} className="text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setParsed(null); setError(null); setNotice(null); setBudgetDraft(null) }}
          placeholder="说一句话，或拖拽截图到这里…"
          rows={2}
          autoFocus
          className="w-full resize-none rounded-xl border-theme bg-card-alt px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-4 transition-colors focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)]"
          style={{ maxHeight: 140 }}
        />

        {image && (
          <div className="mt-2 flex items-center gap-2">
            <span className="max-w-[240px] truncate text-[13px] text-ink-4">{image.file.name}</span>
            <button onClick={() => { setImage(null); setParsed(null) }} className="text-ink-4 transition-colors hover:text-ink-3">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Click-to-upload — mobile-friendly companion to drag-and-drop above. */}
        <button
          onClick={() => fileRef.current?.click()}
          className="mt-2.5 flex items-center gap-1.5 text-[13px] text-ink-3 transition-colors hover:text-ink-2"
        >
          <Paperclip size={14} /> 上传截图
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleInputFileSelect}
        />

        {parsed && (
          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
            识别为 <span className="font-medium text-ink-2">{parsed.item_name}</span>
            {parsed.estimated_price != null && <span> · 约 {formatAmount(parsed.estimated_price)}</span>}
          </p>
        )}

        {error && <p className="mt-3 text-[13px] text-red-500">{error}</p>}
        {notice && <p className="mt-3 text-[13px] text-emerald-600">{notice}</p>}

        {budgetDraft ? (
          <div className="mt-5 flex flex-col gap-3 rounded-xl border-theme bg-card-alt p-4">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">修改预算确认</p>
            <p className="text-[15px] text-ink">
              {budgetDraft.label}上限{' '}
              <span className="font-serif text-ink-3">{budgetCurrentLabel(budgetStore.data, budgetDraft.scope)}</span>
              {' → '}
              <span className="font-serif text-ink">{formatAmount(budgetDraft.limit)}</span>
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setBudgetDraft(null)} disabled={!!busy}>取消</Button>
              <Button size="sm" onClick={() => void handleBudgetConfirm()} disabled={!!busy}>
                {busy === 'budget' ? '保存中…' : '确认修改'}
              </Button>
            </div>
          </div>
        ) : looksLikeBudget ? (
          <div className="mt-5 flex flex-col gap-2.5">
            <Button onClick={() => void handleBudget()} disabled={!hasInput || !!busy}>
              {busy === 'budget' ? '解析中…' : '✎ 改预算'}
            </Button>
            <p className="text-center text-[12px] text-ink-4">看起来你想改预算 · 清空文字可回到「想买」</p>
          </div>
        ) : (
          /* Three user-chosen exits (bug8) — the app no longer forces a cooldown. */
          <div className="mt-5 flex flex-col gap-2.5">
            <Button
              variant="outline"
              onClick={() => handleImpulse()}
              disabled={!hasInput || !!busy}
            >
              忍住，先忍忍
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleWishlist()}
              disabled={!hasInput || !!busy}
            >
              {busy === 'wishlist' ? '分析中…' : '加进清单再想想'}
            </Button>
            <Button
              onClick={() => void handleBuy()}
              disabled={!hasInput || !!busy}
            >
              {busy === 'buy' ? '分析中…' : '确定要买，记一笔 →'}
            </Button>

            {/* 蹲一下：手动记录当前价格，持续追踪走势（不下购买决定）。 */}
            <button
              onClick={() => void handleTrack()}
              disabled={!hasInput || !!busy}
              className="mt-1 text-center text-[13px] text-ink-3 transition-colors hover:text-ink-2 disabled:opacity-40"
            >
              {busy === 'track' ? '分析中…' : '蹲一下价格 — 记录当前价，盯着降不降'}
            </button>
          </div>
        )}
      </ImageDropZone>

      {/* 忍住确认框：问「忍住了多少钱」，确认后攒进许愿池 + 记冲动，不写清单。 */}
      {holdOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-end justify-center bg-black/30"
          style={{ animation: 'sheet-backdrop-in 0.2s ease-out' }}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setHoldOpen(false) }}
        >
          <div className="w-full max-w-[640px] rounded-t-2xl bg-card px-6 pt-6 pb-8 [animation:sheet-slide-up_0.28s_cubic-bezier(0.32,0.72,0,1)]">
            <h3 className="text-[17px] font-medium text-ink">忍住了多少钱？</h3>
            <p className="mt-1 mb-4 text-[13px] text-ink-4">把这笔忍住的钱攒进许愿池</p>
            <div className="flex items-center gap-2 rounded-xl bg-card-alt px-4 py-3">
              <input
                autoFocus
                type="number"
                inputMode="decimal"
                value={holdAmount || ''}
                onChange={(e) => setHoldAmount(Number(e.target.value) || 0)}
                placeholder="0"
                className="flex-1 bg-transparent font-serif text-[22px] text-ink outline-none"
              />
              <span className="text-[15px] text-ink-4">元</span>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setHoldOpen(false)} disabled={!!busy}>
                取消
              </Button>
              <Button size="sm" onClick={() => void handleHoldConfirm()} disabled={!!busy}>
                {busy === 'impulse' ? '保存中…' : '存进许愿池 ✓'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
