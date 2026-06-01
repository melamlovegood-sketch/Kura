import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Paperclip, Plus, Sparkles, X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { useExecutionStore, type BrandEntry, type ExecutionStore } from '@/store/execution'
import { useReviewStore, type ReviewStore } from '@/store/review'
import { useSettingsStore } from '@/store/settings'
import { usePrinciplesStore } from '@/store/principles'
import { addExecutionTransaction } from '@/store/transactions'
import { useBudgetStore } from '@/store/budget'
import { parseProduct } from '@/lib/parseProduct'
import { fileToBase64 } from '@/lib/utils'
import { DecisionBrief } from '@/components/execution/DecisionBrief'
import { ShoppingPrinciplesSection } from '@/components/execution/ShoppingPrinciples'
import { ResearchChecklist } from '@/components/execution/ResearchChecklist'
import { DecisionChat } from '@/components/execution/DecisionChat'
import { WrapUpCard } from '@/components/execution/WrapUpCard'
import type { DecisionMode, ExecutionContext } from '@/lib/generateDecisionBrief'
import { cn } from '@/lib/utils'

type Phase =
  | { name: 'setup' }
  | { name: 'brief'; category: string }
  | { name: 'execute'; category: string; sessionId: string; mode: DecisionMode; startedAt: number; totalSeconds: number; ctx: ExecutionContext }
  | { name: 'recording'; category: string; sessionId: string; startedAt: number; prefillName?: string; prefillAmount?: number | null }
  | { name: 'wrapup'; category: string; sessionId: string; itemName: string; brand: string; amount: number; elapsedSeconds: number }
  | { name: 'done'; decision: 'skipped' | 'undecided' }

export function Execution() {
  const navigate    = useNavigate()
  const location    = useLocation()
  const execStore   = useExecutionStore()
  const reviewStore = useReviewStore()
  const budgetStore = useBudgetStore()
  const timerMinutes    = useSettingsStore((s) => s.timerMinutes)
  const durationSeconds = Math.max(1, timerMinutes) * 60
  const [phase, setPhase] = useState<Phase>({ name: 'setup' })

  // Optional prefill passed from Home's intent routing (e.g. "我要去买球鞋").
  // `skipToRecording` is set when the user chose "确定要买，记一笔" in the buy drawer
  // (bug8) — that exit skips the cooldown/timer and jumps straight to recording.
  const prefill = (location.state as { prefill?: { category?: string; estimatedPrice?: number | null; skipToRecording?: boolean } } | null)?.prefill
  const initialCategory = prefill?.category ?? ''
  const estimatedPrice  = prefill?.estimatedPrice ?? null

  // "确定要买" fast-path: open a session and drop straight into recording. Tolerate
  // a session-create failure by recording without one (session id stays empty,
  // which addExecutionTransaction coalesces to null).
  const fastDone = useRef(false)
  useEffect(() => {
    if (!prefill?.skipToRecording || fastDone.current) return
    fastDone.current = true
    void (async () => {
      let sessionId = ''
      try { sessionId = await execStore.createSession(initialCategory || '生活必需品', durationSeconds) } catch { /* record without a session */ }
      setPhase({ name: 'recording', category: initialCategory || '生活必需品', sessionId, startedAt: Date.now(), prefillName: initialCategory, prefillAmount: estimatedPrice })
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col gap-4 pt-6 w-full max-w-[640px] mx-auto px-6">
      <h1 className="text-base font-medium text-ink">执行层</h1>

      {phase.name === 'setup' && (
        <SetupPhase execStore={execStore} initialCategory={initialCategory}
          onStart={(category) => setPhase({ name: 'brief', category })}
        />
      )}

      {phase.name === 'brief' && (
        <DecisionBrief
          category={phase.category}
          estimatedPrice={estimatedPrice}
          execStore={execStore}
          onStart={async (mode, ctx) => {
            const sessionId = await execStore.createSession(phase.category, durationSeconds)
            setPhase({ name: 'execute', category: phase.category, sessionId, mode, startedAt: Date.now(), totalSeconds: durationSeconds, ctx })
          }}
        />
      )}

      {phase.name === 'execute' && (
        <ExecutePhase phase={phase}
          onBuy={() => setPhase({ name: 'recording', category: phase.category, sessionId: phase.sessionId, startedAt: phase.startedAt, prefillName: initialCategory || phase.category, prefillAmount: phase.ctx.estimatedPrice ?? estimatedPrice })}
          onSkip={async () => { await execStore.endSession(phase.sessionId, 'skipped'); setPhase({ name: 'done', decision: 'skipped' }) }}
          onUndecided={async () => { await execStore.endSession(phase.sessionId, 'undecided'); setPhase({ name: 'done', decision: 'undecided' }) }}
        />
      )}

      {phase.name === 'recording' && (
        <RecordingPhase phase={phase} execStore={execStore} reviewStore={reviewStore}
          onSaved={({ itemName, brand, amount }) => {
            const elapsedSeconds = Math.round((Date.now() - phase.startedAt) / 1000)
            setPhase({ name: 'wrapup', category: phase.category, sessionId: phase.sessionId, itemName, brand, amount, elapsedSeconds })
          }}
        />
      )}

      {phase.name === 'wrapup' && (
        <WrapUpCard category={phase.category} sessionId={phase.sessionId}
          itemName={phase.itemName} brand={phase.brand} amount={phase.amount} elapsedSeconds={phase.elapsedSeconds}
          onContinue={() => { void budgetStore.refresh(); navigate('/') }}
        />
      )}

      {phase.name === 'done' && (
        <DonePhase decision={phase.decision} onBack={() => navigate('/')} />
      )}
    </div>
  )
}

function SetupPhase({ execStore, onStart, initialCategory = '' }: {
  execStore: ExecutionStore; onStart: (c: string) => void; initialCategory?: string
}) {
  const [category, setCategory] = useState(initialCategory)
  const categoryBrands = category.trim() ? execStore.brandsForCategory(category.trim()) : []

  function handleStart() {
    if (!category.trim()) return
    onStart(category.trim())
  }

  return (
    <>
      <Card>
        <CardHeader><CardTitle>买什么？</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <input
            type="text" value={category} onChange={(e) => setCategory(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleStart() }}
            placeholder="品类，如：球鞋、裤子、耳机…" autoFocus
            className="w-full bg-transparent text-[15px] text-ink outline-none border-b-theme focus:border-b-[var(--text-muted)] pb-1 placeholder:text-ink-4 transition-colors"
          />
          <Button onClick={handleStart} disabled={!category.trim()}>生成决策简报 →</Button>
        </CardContent>
      </Card>
      {category.trim() && <BrandSection category={category.trim()} brands={categoryBrands} execStore={execStore} />}
      <ShoppingPrinciplesSection collapsible defaultOpen />
    </>
  )
}

function ExecutePhase({ phase, onBuy, onSkip, onUndecided }: {
  phase: Extract<Phase, { name: 'execute' }>
  onBuy: () => void; onSkip: () => Promise<void>; onUndecided: () => Promise<void>
}) {
  const execStore = useExecutionStore()
  const [mode, setMode] = useState<DecisionMode>(phase.mode)
  const brands = execStore.brandsForCategory(phase.category)

  return (
    <>
      {/* Mode toggle — AI suggested one on entry, user can switch any time. */}
      <div className="flex gap-2">
        <ModeChip active={mode === 'fast'} onClick={() => setMode('fast')} label="⚡ 快速决策" />
        <ModeChip active={mode === 'research'} onClick={() => setMode('research')} label="🔍 研究模式" />
      </div>

      {mode === 'fast' ? (
        <FastMode phase={phase} onBuy={onBuy} onSkip={onSkip} onUndecided={onUndecided} />
      ) : (
        <ResearchChecklist category={phase.category} estimatedPrice={phase.ctx.estimatedPrice}
          startedAt={phase.startedAt} onConfirm={onBuy} />
      )}

      {brands.length > 0 && <BrandSection category={phase.category} brands={brands} execStore={execStore} readonly />}

      <Card>
        <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-3">决策助手</p>
        <DecisionChat context={phase.ctx} />
      </Card>
    </>
  )
}

function ModeChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
      className={cn('flex-1 rounded-xl border px-3 py-2 text-[14px] font-medium transition-colors',
        active ? 'border-[var(--accent)] bg-card-alt text-ink' : 'border-theme text-ink-3 hover:bg-card-alt')}>
      {label}
    </button>
  )
}

function FastMode({ phase, onBuy, onSkip, onUndecided }: {
  phase: Extract<Phase, { name: 'execute' }>
  onBuy: () => void; onSkip: () => Promise<void>; onUndecided: () => Promise<void>
}) {
  const [decided, setDecided] = useState(false)
  const [loading, setLoading] = useState(false)
  const remaining = useCountdown(phase.totalSeconds, () => setDecided(true))
  async function handle(action: () => Promise<void>) { setLoading(true); try { await action() } finally { setLoading(false) } }

  if (decided) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-6 text-center">
          <p className="font-serif text-2xl text-ink">{remaining <= 0 ? '时间到了' : '做出决定'}</p>
          <p className="text-[15px] text-ink-3">{phase.category}</p>
          <div className="flex w-full gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={() => void handle(onSkip)} disabled={loading}>跳过</Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={() => void handle(onUndecided)} disabled={loading}>留着想</Button>
            <Button size="sm" className="flex-1" onClick={onBuy} disabled={loading}>买了 →</Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-4">
        <p className="text-[13px] text-ink-4">{phase.category}</p>
        <CountdownDisplay remaining={remaining} total={phase.totalSeconds} />
        <Button variant="outline" size="sm" onClick={() => setDecided(true)}>提前决策</Button>
      </CardContent>
    </Card>
  )
}

function RecordingPhase({ phase, execStore, reviewStore, onSaved }: {
  phase: Extract<Phase, { name: 'recording' }>; execStore: ExecutionStore
  reviewStore: ReviewStore; onSaved: (r: { itemName: string; brand: string; amount: number }) => void
}) {
  const [itemName, setItemName] = useState(phase.prefillName?.trim() ?? '')
  const [amount, setAmount]     = useState(phase.prefillAmount ?? 0)
  const [brand, setBrand]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const brands = execStore.brandsForCategory(phase.category)

  async function handleConfirm() {
    if (amount <= 0) return
    setSaving(true); setError(null)
    try {
      const name = itemName.trim() || phase.category
      const brandName = brand.trim()
      await execStore.endSession(phase.sessionId, 'bought', name)
      // A hand-typed brand that isn't in the library yet must be added now (weight
      // 5, same as manual adds), otherwise day7/day30 review can't feed weight back.
      if (brandName) {
        const known = brands.some((b) => b.brand_name.toLowerCase() === brandName.toLowerCase())
        if (!known) await execStore.addBrand(phase.category, brandName)
      }
      const txId = await addExecutionTransaction({ amount, description: name, executionCategory: phase.category, executionSessionId: phase.sessionId })
      await reviewStore.createTasksForPurchase({ item_name: name, brand: brandName || undefined, category: phase.category, transactionId: txId })
      onSaved({ itemName: name, brand: brandName, amount })
    } catch (err) {
      // Surface the failure (e.g. a 401/400 write) instead of silently doing nothing.
      setError(`保存失败：${(err as Error).message || '请稍后重试'}`)
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <CardHeader><CardTitle>记录购买</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* AI 填表：自然语言 / 截图 → 自动填入金额与商品（bug2） */}
        <RecordingAIFill onFilled={(p) => {
          if (p.item_name) setItemName(p.item_name)
          if (p.estimated_price != null && p.estimated_price > 0) setAmount(p.estimated_price)
        }} />

        <div className="flex items-baseline gap-1.5 border-b-theme pb-3">
          <span className="text-lg text-ink-4">¥</span>
          <input type="number" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value) || 0)} placeholder="0" autoFocus
            className="w-full bg-transparent font-serif text-4xl text-ink outline-none placeholder:text-ink-4" />
        </div>
        <input type="text" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder={`买了什么（默认：${phase.category}）`}
          className="w-full bg-transparent text-[15px] text-ink-2 outline-none border-b-theme focus:border-b-[var(--text-muted)] transition-colors pb-1 placeholder:text-ink-4" />

        {brands.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px] text-ink-4">买的哪个品牌？</p>
            <div className="flex flex-wrap gap-1.5">
              {brands.map((b) => (
                <button key={b.id} onClick={() => setBrand(b.brand_name === brand ? '' : b.brand_name)}
                  className={cn('rounded-lg border-theme px-3 py-1.5 text-[13px] font-medium transition-colors', brand === b.brand_name ? 'bg-accent text-on-accent' : 'text-ink-2 hover:bg-card-alt')}>
                  {b.brand_name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <input type="text" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="品牌（可选）"
            className="w-full bg-transparent text-[15px] text-ink-2 outline-none border-b-theme focus:border-b-[var(--text-muted)] transition-colors pb-1 placeholder:text-ink-4" />
        )}

        <p className="text-[13px] text-ink-4">会自动生成 7 天和 30 天复盘提醒</p>
        {error && <p className="text-[13px] text-red-500">{error}</p>}
        <div className="flex justify-end border-t-theme pt-3">
          <Button onClick={() => void handleConfirm()} disabled={saving || amount <= 0}>{saving ? '保存中…' : '确认购买'}</Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * AI quick-fill for the buy-recording form (bug2): reuses the home dialog's
 * natural-language + screenshot parsing so the user no longer has to hand-type
 * the amount / item. Manual editing of the fields below remains the fallback.
 */
function RecordingAIFill({ onFilled }: { onFilled: (p: { item_name: string; estimated_price: number | null }) => void }) {
  const adapter = useSettingsStore((s) => s.adapter)
  const principles = usePrinciplesStore((s) => s.items)
  const [text, setText] = useState('')
  const [image, setImage] = useState<{ name: string; base64: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasInput = !!text.trim() || !!image

  async function handleParse() {
    if (!hasInput || busy) return
    if (!adapter) { setError('请先在设置里填写 API Key'); return }
    setBusy(true); setError(null)
    try {
      const p = await parseProduct(adapter, text, image?.base64, undefined, principles.map((x) => x.content))
      onFilled({ item_name: p.item_name, estimated_price: p.estimated_price })
      setText(''); setImage(null)
    } catch (err) {
      setError(`解析失败：${(err as Error).message || '请稍后重试'}`)
    } finally { setBusy(false) }
  }

  return (
    <ImageDropZone
      onFile={(base64, file) => { setImage({ name: file.name, base64 }); setError(null) }}
      className="flex flex-col gap-2 rounded-xl border-theme bg-card-alt p-3"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
        <Sparkles size={13} /> 用一句话或截图自动填写
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null) }}
        placeholder="如：刚买了 Nike 跑鞋 699，或拖入支付截图…"
        rows={2}
        className="w-full resize-none bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-4"
      />
      {image && (
        <div className="flex items-center gap-2">
          <span className="max-w-[200px] truncate text-[12px] text-ink-4">{image.name}</span>
          <button onClick={() => setImage(null)} className="text-ink-4 transition-colors hover:text-ink-3"><X size={12} /></button>
        </div>
      )}
      {error && <p className="text-[12px] text-red-500">{error}</p>}
      <div className="flex items-center gap-3">
        <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1 text-[12px] text-ink-4 transition-colors hover:text-ink-3">
          <Paperclip size={13} /> 上传截图
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden"
          onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setImage({ name: f.name, base64: await fileToBase64(f) }); e.target.value = '' }} />
        <div className="flex-1" />
        <Button size="sm" onClick={() => void handleParse()} disabled={!hasInput || busy}>{busy ? '识别中…' : 'AI 填写'}</Button>
      </div>
    </ImageDropZone>
  )
}

function DonePhase({ decision, onBack }: { decision: 'skipped' | 'undecided'; onBack: () => void }) {
  return (
    <Card className="py-8 text-center">
      <p className="font-serif text-lg text-ink">{decision === 'skipped' ? '理智战胜冲动' : '先记着，慢慢想'}</p>
      <Button variant="ghost" size="sm" className="mt-4" onClick={onBack}>回首页</Button>
    </Card>
  )
}

function BrandSection({ category, brands, execStore, readonly = false }: {
  category: string; brands: BrandEntry[]; execStore: ExecutionStore; readonly?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [newBrand, setNewBrand] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleAdd() {
    if (!newBrand.trim()) return; setSaving(true)
    await execStore.addBrand(category, newBrand.trim()); setNewBrand(''); setAdding(false); setSaving(false)
  }

  return (
    <Card>
      <CardHeader><CardTitle>信任品牌 · {category}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {brands.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {brands.map((b) => (
              <div key={b.id} className="flex items-center gap-1.5 rounded-lg border-theme bg-card-alt px-2.5 py-1.5">
                <span className="text-[13px] font-medium text-ink-2">{b.brand_name}</span>
                <span className="text-[11px] text-amber-500">★{b.weight}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-4">暂无 {category} 品牌</p>
        )}
        {!readonly && (
          adding ? (
            <div className="flex gap-2">
              <input type="text" value={newBrand} onChange={(e) => setNewBrand(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd() }}
                placeholder="品牌名称" autoFocus
                className="flex-1 rounded-lg border-theme bg-card-alt px-3 py-1.5 text-[15px] text-ink outline-none focus:ring-1 focus:ring-[var(--border)]" />
              <Button size="sm" onClick={() => void handleAdd()} disabled={saving || !newBrand.trim()}>添加</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>取消</Button>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex items-center gap-1 text-[13px] text-ink-4 hover:text-ink-3 transition-colors">
              <Plus size={13} /> 添加品牌
            </button>
          )
        )}
      </CardContent>
    </Card>
  )
}

function useCountdown(totalSeconds: number, onExpire: () => void): number {
  const [remaining, setRemaining] = useState(totalSeconds)
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining((s) => {
        if (s <= 1) { clearInterval(id); setTimeout(() => onExpireRef.current(), 0); return 0 }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return remaining
}

function CountdownDisplay({ remaining, total }: { remaining: number; total: number }) {
  const mins   = Math.floor(remaining / 60)
  const secs   = remaining % 60
  const pct    = (remaining / total) * 100
  const urgent = remaining <= 60

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <span className={cn('font-serif text-6xl tabular-nums transition-colors', urgent ? 'text-red-500' : 'text-ink')}>
        {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
      </span>
      <div className="h-[2px] w-full overflow-hidden rounded-full bg-track">
        <div className={cn('h-full rounded-full transition-all duration-1000 ease-linear', urgent ? 'bg-red-400' : 'bg-progress')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
