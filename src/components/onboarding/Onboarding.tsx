import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { db } from '@/lib/db'
import { useBudgetStore } from '@/store/budget'
import { useWishlistStore } from '@/store/wishlist'
import { useWishPoolStore } from '@/store/wishpool'
import { useSettingsStore } from '@/store/settings'
import { usePrinciplesStore } from '@/store/principles'
import { CostPerspectiveFields, EMPTY_COST_VALUE, type CostPerspectiveValue } from '@/components/cost/CostPerspectiveFields'
import { createAdapter, DEFAULT_MODELS } from '@/lib/ai/factory'
import { routeIntent } from '@/lib/ai/router'
import { cn } from '@/lib/utils'
import type { AIProvider } from '@/lib/ai/types'
import type { ParsedWishlistItem } from '@/types/db'

export const DONE_KEY = 'kura-onboarding-done'
export const API_SKIPPED_KEY = 'kura-onboarding-api-skipped'

type Phase = 'checking' | 'hidden' | 0 | 1 | 2 | 3 | 4 | 5

const PROVIDERS: { value: AIProvider; label: string }[] = [
  { value: 'claude', label: 'Anthropic Claude' },
  { value: 'gpt',    label: 'OpenAI' },
  { value: 'qwen',   label: '通义千问' },
  { value: 'gemini', label: 'Gemini' },
]

/**
 * Cold-start guide. Shows a full-screen flow only on a genuinely fresh install —
 * no budget, no transactions, no wishlist items. Every step can be skipped (which
 * advances to the next step, not straight out). Marks `kura-onboarding-done` once
 * finished so it never shows again.
 *
 * Phase 0: API Key   — validate before advancing; skip sets API_SKIPPED_KEY
 * Phase 1: Budget    — set monthly limits
 * Phase 2: 代价视角   — identity + 月生活费/伙食费 (bug4)
 * Phase 3: Wish      — pick a wish-pool goal
 * Phase 4: 消费原则   — describe spending principles, skippable (bug10)
 * Phase 5: Done      — finish screen
 */
export function Onboarding() {
  const [phase, setPhase] = useState<Phase>('checking')

  useEffect(() => {
    if (localStorage.getItem(DONE_KEY) === 'true') { setPhase('hidden'); return }
    let cancelled = false
    void (async () => {
      try {
        const [b, t, w] = await Promise.all([
          db.from('monthly_budgets').select('id', { count: 'exact', head: true }),
          db.from('transactions').select('id', { count: 'exact', head: true }),
          db.from('wishlist_items').select('id', { count: 'exact', head: true }),
        ])
        if (cancelled) return
        const errored = !!(b.error || t.error || w.error)
        const empty = (b.count ?? 0) === 0 && (t.count ?? 0) === 0 && (w.count ?? 0) === 0
        if (empty && !errored) {
          setPhase(0)
        } else {
          if (!errored) localStorage.setItem(DONE_KEY, 'true')
          setPhase('hidden')
        }
      } catch {
        if (!cancelled) setPhase('hidden')
      }
    })()
    return () => { cancelled = true }
  }, [])

  function finish() {
    localStorage.setItem(DONE_KEY, 'true')
    // No SOP-rule seeding: new users start with an empty 购物原则 list and add
    // their own (执行层 / 我的消费观). The old default-seed step was removed.
    setPhase('hidden')
  }

  function skipApiKey() {
    localStorage.setItem(API_SKIPPED_KEY, 'true')
    setPhase(1)
  }

  if (phase === 'checking' || phase === 'hidden') return null

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-page px-6">
      <div className="w-full max-w-[420px]">
        {phase === 0 && <ApiKeyStep     onSkip={skipApiKey}        onNext={() => setPhase(1)} />}
        {phase === 1 && <BudgetStep     onSkip={() => setPhase(2)} onNext={() => setPhase(2)} />}
        {phase === 2 && <CostStep       onSkip={() => setPhase(3)} onNext={() => setPhase(3)} />}
        {phase === 3 && <WishStep       onSkip={() => setPhase(4)} onNext={() => setPhase(4)} />}
        {phase === 4 && <PrinciplesStep onSkip={() => setPhase(5)} onNext={() => setPhase(5)} />}
        {phase === 5 && <DoneStep       onStart={finish} />}
      </div>
    </div>
  )
}

/* ── Step 0: API Key ──────────────────────────────────────────────────── */

function ApiKeyStep({ onSkip, onNext }: { onSkip: () => void; onNext: () => void }) {
  const [provider, setProvider] = useState<AIProvider>('claude')
  const [apiKey,   setApiKey]   = useState('')
  const [status,   setStatus]   = useState<'idle' | 'validating' | 'error'>('idle')
  const [error, setError] = useState('')

  async function handleNext() {
    const key = apiKey.trim()
    if (!key) { onSkip(); return }

    setStatus('validating')
    try {
      await validateKey(provider, key)
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接失败，请稍后重试')
      setStatus('error')
      return
    }

    // Save to settings store (shared with Settings page).
    await useSettingsStore.getState().update({
      aiProvider: provider,
      aiModel:    DEFAULT_MODELS[provider],
      aiApiKey:   key,
    })
    setStatus('idle')
    onNext()
  }

  return (
    <StepShell>
      <div>
        <p className="font-serif text-[22px] text-ink">Kura 需要 AI 才能工作</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-3">填入你的 API Key 开始使用</p>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <p className="mb-2 text-[13px] text-ink-3">选择 AI 服务商</p>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.value}
                onClick={() => { setProvider(p.value); setStatus('idle') }}
                className={cn(
                  'rounded-lg border-theme px-3 py-1.5 text-[13px] font-medium transition-colors',
                  provider === p.value ? 'bg-accent text-on-accent' : 'text-ink-3 hover:bg-card-alt hover:text-ink-2',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <Field label="API Key">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setStatus('idle') }}
            placeholder="sk-…"
            autoComplete="off"
            autoFocus
          />
        </Field>

        {status === 'error' && (
          <p className="text-[13px] text-red-500" role="alert">{error}</p>
        )}
      </div>

      <Actions
        skipLabel="跳过"
        onSkip={onSkip}
        nextLabel={status === 'validating' ? '验证中…' : '确认，下一步'}
        onNext={() => void handleNext()}
        nextDisabled={status === 'validating'}
      />
    </StepShell>
  )
}

/* ── Step 1: Budget ───────────────────────────────────────────────────── */

function BudgetStep({ onSkip, onNext }: { onSkip: () => void; onNext: () => void }) {
  const [basic, setBasic] = useState('')
  const [discr, setDiscr] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleNext() {
    const b = Number(basic), d = Number(discr)
    setSaving(true)
    try {
      if (b > 0 && d > 0) {
        await useBudgetStore.getState().upsert({ basic_life_limit: b, discretionary_limit: d })
      }
      onNext()
    } finally { setSaving(false) }
  }

  return (
    <StepShell>
      <div>
        <p className="font-serif text-[22px] text-ink">欢迎来到 Kura 🌰</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-3">先告诉我这个月你能花多少？</p>
      </div>

      <div className="flex flex-col gap-3">
        <Field label="基础生活额度">
          <Input type="number" inputMode="numeric" value={basic} onChange={(e) => setBasic(e.target.value)} placeholder="¥" min={0} autoFocus />
        </Field>
        <Field label="可支配消费额度">
          <Input type="number" inputMode="numeric" value={discr} onChange={(e) => setDiscr(e.target.value)} placeholder="¥" min={0} />
        </Field>
      </div>

      <Actions skipLabel="跳过" onSkip={onSkip} nextLabel={saving ? '保存中…' : '确认，下一步'} onNext={() => void handleNext()} nextDisabled={saving} />
    </StepShell>
  )
}

/* ── Step 2: 代价视角 (bug4) ───────────────────────────────────────────── */

function CostStep({ onSkip, onNext }: { onSkip: () => void; onNext: () => void }) {
  const [cost, setCost] = useState<CostPerspectiveValue>(EMPTY_COST_VALUE)
  const [saving, setSaving] = useState(false)

  async function handleNext() {
    setSaving(true)
    try {
      const num = (s: string) => { const n = Number(s); return s.trim() && n > 0 ? n : null }
      await useSettingsStore.getState().update({
        identity: cost.identity,
        monthlyIncome:     cost.identity ? num(cost.income) : null,
        monthlyFoodBudget: cost.identity === 'student' ? num(cost.foodBudget) : null,
        dailyWorkHours:    cost.identity === 'worker' ? num(cost.workHours) : null,
      })
      onNext()
    } finally { setSaving(false) }
  }

  return (
    <StepShell>
      <div>
        <p className="font-serif text-[22px] text-ink">把钱换算成你有感的代价</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-3">选个身份，金额就会换算成你熟悉的尺度。</p>
      </div>

      <CostPerspectiveFields value={cost} onChange={setCost} />

      <Actions skipLabel="跳过" onSkip={onSkip} nextLabel={saving ? '保存中…' : '确认，下一步'} onNext={() => void handleNext()} nextDisabled={saving} />
    </StepShell>
  )
}

/* ── Step 3: Wish ─────────────────────────────────────────────────────── */

function WishStep({ onSkip, onNext }: { onSkip: () => void; onNext: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleNext() {
    const v = text.trim()
    if (!v) { onNext(); return }
    setBusy(true)
    try {
      const parsed = await parseWish(v)
      const item = await useWishlistStore.getState().add(parsed)
      if (item) {
        await useWishlistStore.getState().pin(item)
        await useWishPoolStore.getState().load()
      }
      onNext()
    } finally { setBusy(false) }
  }

  return (
    <StepShell>
      <div>
        <p className="font-serif text-[22px] text-ink">你现在最想买的一件东西是什么？</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-3">说一句话就好，比如「一双 Nike 699 块」</p>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="一双 Nike 699 块…"
        rows={2}
        autoFocus
        className="w-full resize-none rounded-xl border-theme bg-card-alt px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-4 focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)] transition-colors"
      />

      <Actions skipLabel="跳过" onSkip={onSkip} nextLabel={busy ? '处理中…' : '确认，下一步'} onNext={() => void handleNext()} nextDisabled={busy} />
    </StepShell>
  )
}

/* ── Step 4: 消费原则 (bug10) ──────────────────────────────────────────── */

function PrinciplesStep({ onSkip, onNext }: { onSkip: () => void; onNext: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleNext() {
    const v = text.trim()
    if (!v) { onNext(); return }
    setBusy(true)
    try {
      const adapter = useSettingsStore.getState().adapter
      let added = false
      if (adapter) {
        try {
          const r = await routeIntent(adapter, v)
          const items = (r.data as { items?: unknown }).items
          if (r.module === 'principles' && Array.isArray(items)) {
            await usePrinciplesStore.getState().add(items as string[])
            added = true
          }
        } catch { /* fall through to raw save */ }
      }
      if (!added) await usePrinciplesStore.getState().add([v])
      onNext()
    } finally { setBusy(false) }
  }

  return (
    <StepShell>
      <div>
        <p className="font-serif text-[22px] text-ink">你的消费原则是什么？</p>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-3">
          用大白话写下来，AI 会在每次分析时帮你守住它。不想填也可以跳过。
        </p>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'例："宁可买一件贵的也不买几件便宜货"'}
        rows={3}
        autoFocus
        className="w-full resize-none rounded-xl border-theme bg-card-alt px-3.5 py-2.5 text-[15px] text-ink placeholder:text-ink-4 focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)] transition-colors"
      />

      <Actions skipLabel="跳过" onSkip={onSkip} nextLabel={busy ? '处理中…' : '确认，下一步'} onNext={() => void handleNext()} nextDisabled={busy} />
    </StepShell>
  )
}

/* ── Step 5: Done ─────────────────────────────────────────────────────── */

function DoneStep({ onStart }: { onStart: () => void }) {
  const navigate = useNavigate()

  // 「去导入」：先结束引导（隐藏覆盖层），再跳到历史账单导入页。
  function goImport() {
    onStart()
    navigate('/import-history')
  }

  return (
    <StepShell>
      <div className="text-center">
        <p className="font-serif text-[24px] text-ink">好了，Kura 准备好了 🎉</p>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-3">
          记账、忍住、许愿池——<br />从对话框开始就行。
        </p>
      </div>

      {/* 可选：导入过去几个月的账单 */}
      <div className="flex flex-col gap-2 rounded-xl bg-card-alt p-4 text-left">
        <p className="text-[14px] font-medium text-ink-2">📥 导入过去几个月的账单？（可跳过）</p>
        <p className="text-[12px] leading-relaxed text-ink-4">AI 帮你分析，第一天就有完整数据</p>
        <div className="mt-1 flex gap-2">
          <Button variant="ghost" size="sm" className="flex-1" onClick={onStart}>跳过</Button>
          <Button size="sm" className="flex-1" onClick={goImport}>去导入 →</Button>
        </div>
      </div>

      <Button className="w-full" onClick={onStart}>开始使用</Button>
    </StepShell>
  )
}

/* ── Shared primitives ────────────────────────────────────────────────── */

function StepShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex flex-col gap-6"
      style={{ animation: 'milestone-pop-in 0.4s cubic-bezier(0.34,1.56,0.64,1) both' }}
    >
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] text-ink-3">{label}</span>
      {children}
    </label>
  )
}

function Actions({ skipLabel, onSkip, nextLabel, onNext, nextDisabled }: {
  skipLabel: string; onSkip: () => void; nextLabel: string; onNext: () => void; nextDisabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between">
      <Button variant="ghost" size="sm" onClick={onSkip}>{skipLabel}</Button>
      <Button size="sm" onClick={onNext} disabled={nextDisabled}>{nextLabel}</Button>
    </div>
  )
}

/* ── API key validation ───────────────────────────────────────────────── */

async function validateKey(provider: AIProvider, key: string): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const adapter = createAdapter(provider, key, DEFAULT_MODELS[provider])
    // Send the smallest possible request — we only care if the API accepts the key.
    await adapter.streamChat(
      [{ role: 'user', content: '1' }],
      () => {},
      ctrl.signal,
    )
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error('连接超时，请稍后重试')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/* ── AI wish parse ────────────────────────────────────────────────────── */

async function parseWish(text: string): Promise<ParsedWishlistItem> {
  const adapter = useSettingsStore.getState().adapter
  if (adapter) {
    try {
      const r = await routeIntent(adapter, text)
      if (r.module === 'wishlist' && typeof (r.data as { item_name?: unknown }).item_name === 'string') {
        return r.data as unknown as ParsedWishlistItem
      }
    } catch { /* fall through to local parse */ }
  }
  return localParse(text)
}

function localParse(text: string): ParsedWishlistItem {
  const m = text.match(/\d+(?:\.\d+)?/)
  return {
    item_name: text,
    estimated_price: m ? Number(m[0]) : null,
    category: null,
    season_tag: 'year_round',
    need_intensity: null,
    worthiness_score: null,
    worthiness_reason: null,
  }
}
