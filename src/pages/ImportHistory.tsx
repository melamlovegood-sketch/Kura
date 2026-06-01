import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronDown, Check, Upload, AlertTriangle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { CategoryPicker } from '@/components/transaction/CategoryPicker'
import { useSettingsStore } from '@/store/settings'
import { db } from '@/lib/db'
import { getCurrentUserId } from '@/lib/auth'
import { CATEGORY_META } from '@/lib/categories'
import { cn, formatAmount } from '@/lib/utils'
import {
  decodeCsvFile,
  parseBillCsv,
  parseWechatXlsx,
  dedupe,
  withinSixMonths,
  type Platform,
  type RawRecord,
} from '@/lib/importBill'
import { classifyDescriptions } from '@/lib/importClassify'
import type { CategoryMain, ItemCategory } from '@/types/db'

interface Draft extends RawRecord {
  id: string
  category: ItemCategory
  category_main: CategoryMain
  needs_review: boolean
  confirmed: boolean
}

interface Stats {
  total: number
  skipped: number
  dedupRemoved: number
  sixMoFiltered: number
  prepared: number
  reviewCount: number
}

const PLATFORM_LABEL: Record<Platform, string> = { wechat: '💚 微信', alipay: '💙 支付宝' }
type Filter = 'all' | 'review' | 'basic' | 'discretionary'

export function ImportHistory() {
  const navigate = useNavigate()
  const adapter = useSettingsStore((s) => s.adapter)

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '准备解析…' })
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importedCount, setImportedCount] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function handleFiles(files: FileList | null, platform: Platform) {
    if (!files || files.length === 0) return
    setError(null)
    setStep(2)
    setProgress({ done: 0, total: 0, label: '正在读取文件…' })

    if (!adapter) {
      setError('请先在设置里填写 AI 服务的 API Key，再来导入。')
      return
    }

    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl

    try {
      let total = 0
      let skipped = 0
      const all: RawRecord[] = []

      for (const file of Array.from(files)) {
        const res =
          platform === 'wechat'
            ? await parseWechatXlsx(file)
            : parseBillCsv(await decodeCsvFile(file), 'alipay')
        total += res.total
        skipped += res.skipped
        all.push(...res.records)
      }

      if (all.length === 0) {
        setError(
          platform === 'wechat'
            ? '没能从文件里识别出消费记录。请确认上传的是微信导出的 .xlsx 账单文件。'
            : '没能从文件里识别出消费记录。请确认上传的是支付宝导出的 .csv 账单文件。',
        )
        return
      }

      // 去重 → 近6个月
      const { kept, removed } = dedupe(all)
      const recent = withinSixMonths(kept)
      const sixMoFiltered = kept.length - recent.length

      // AI 批量分类
      setProgress({ done: 0, total: recent.length, label: '🌰 栗子正在归类…' })
      const classes = await classifyDescriptions(
        adapter,
        recent.map((r) => r.description),
        (done, t) => setProgress({ done, total: t, label: '🌰 栗子正在归类…' }),
        ctrl.signal,
      )

      const built: Draft[] = recent.map((r, i) => ({
        ...r,
        id: `${r.platform}-${r.date}-${i}`,
        category: classes[i].category,
        category_main: classes[i].category_main,
        needs_review: classes[i].needs_review,
        confirmed: false,
      }))

      const reviewCount = built.filter((d) => d.needs_review).length
      setDrafts(built)
      setStats({
        total,
        skipped,
        dedupRemoved: removed,
        sixMoFiltered,
        prepared: built.length,
        reviewCount,
      })
      setStep(3)
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError(`解析失败：${(err as Error).message || '请稍后重试'}`)
    }
  }

  function pickCategory(id: string, category: ItemCategory) {
    setDrafts((prev) =>
      prev.map((d) =>
        d.id === id
          ? { ...d, category, category_main: CATEGORY_META[category].main, needs_review: false, confirmed: true }
          : d,
      ),
    )
  }

  async function importAll() {
    if (importing || drafts.length === 0) return
    setImporting(true)
    setError(null)
    try {
      // user_id is required (NOT NULL + RLS WITH CHECK auth.uid() = user_id) and is
      // also part of the dedup conflict key, so every imported row must carry it.
      const userId = await getCurrentUserId()
      const rows = drafts.map((d) => ({
        amount: d.amount,
        description: d.description,
        category: d.category,
        category_main: d.category_main,
        date: d.date,
        source: 'import',
        expiry_date: null,
        user_id: userId,
      }))
      const { error: dbErr } = await db
        .from('transactions')
        .upsert(rows, { onConflict: 'user_id,date,amount,description', ignoreDuplicates: true })
      if (dbErr) throw dbErr
      setImportedCount(rows.length)
      setTimeout(() => navigate('/billing'), 1800)
    } catch (err) {
      setError(`写入失败：${(err as Error).message || '请稍后重试'}`)
      setImporting(false)
    }
  }

  /* ── 导入成功 ─────────────────────────────────────────────────────────────── */
  if (importedCount != null) {
    return (
      <Shell onBack={() => navigate('/billing')} hideBack>
        <Card className="mt-10 flex flex-col items-center gap-3 text-center">
          <div className="text-5xl">🎉</div>
          <h2 className="text-lg font-medium text-ink">已导入 {importedCount} 条历史记录</h2>
          <p className="text-[13px] text-ink-3">账单数据已更新，正在返回账单页…</p>
          <Button onClick={() => navigate('/billing')} className="mt-2">立即查看</Button>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell onBack={() => (step === 1 ? navigate('/billing') : setStep(1))}>
      <StepBar step={step} />

      {step === 1 && <StepSelect onFiles={handleFiles} />}

      {step === 2 && <StepParsing progress={progress} error={error} onRetry={() => setStep(1)} />}

      {step === 3 && stats && (
        <StepConfirm
          drafts={drafts}
          stats={stats}
          filter={filter}
          onFilter={setFilter}
          onPick={pickCategory}
          onImport={importAll}
          importing={importing}
          error={error}
        />
      )}

      <div className="h-20" />
    </Shell>
  )
}

/* ── 外壳 ───────────────────────────────────────────────────────────────────── */

function Shell({ children, onBack, hideBack }: { children: React.ReactNode; onBack: () => void; hideBack?: boolean }) {
  return (
    <div className="flex flex-col gap-5 pt-6 w-full max-w-[640px] mx-auto px-6">
      <div className="flex items-center gap-2">
        {!hideBack && (
          <button onClick={onBack} className="rounded-md p-1 text-ink-4 transition-colors hover:text-ink-2">
            <ArrowLeft size={18} />
          </button>
        )}
        <h1 className="text-base font-medium text-ink">导入历史账单</h1>
      </div>
      {children}
    </div>
  )
}

function StepBar({ step }: { step: 1 | 2 | 3 }) {
  const items = [
    { n: 1, label: '上传' },
    { n: 2, label: '解析' },
    { n: 3, label: '确认' },
  ]
  return (
    <div className="flex items-center justify-center gap-2">
      {items.map((it, i) => (
        <div key={it.n} className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-medium transition-colors',
                step >= it.n ? 'bg-[#3D2B1F] text-white' : 'bg-card-alt text-ink-4 border-theme',
              )}
            >
              {step > it.n ? <Check size={13} /> : it.n}
            </span>
            <span className={cn('text-[12px]', step >= it.n ? 'text-ink-2' : 'text-ink-4')}>{it.label}</span>
          </div>
          {i < items.length - 1 && <span className="h-px w-6 bg-[var(--border)]" />}
        </div>
      ))}
    </div>
  )
}

/* ── 步骤1：选平台 + 上传 ────────────────────────────────────────────────────── */

const WECHAT_GUIDE = ['微信 →「我」→「支付」→ 右上角「…」', '「账单」→ 右上角「…」→「下载账单」', '选时间范围 → 发送到手机邮箱，拿到 .xlsx']
const ALIPAY_GUIDE = ['支付宝 → 首页搜索「账单」', '右上角「…」→「下载账单」', '选时间范围 → 发邮箱或直接下载 .csv']

function StepSelect({ onFiles }: { onFiles: (files: FileList | null, platform: Platform) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <UploadTile
        emoji="💚"
        title="微信账单 .xlsx"
        hint="微信支付导出的 Excel 账单文件"
        accept=".xlsx"
        guide={{ title: '微信导出教程', steps: WECHAT_GUIDE }}
        onPick={(files) => onFiles(files, 'wechat')}
      />
      <UploadTile
        emoji="💙"
        title="支付宝账单 .csv"
        hint="支付宝导出的 CSV 账单文件"
        accept=".csv"
        guide={{ title: '支付宝导出教程', steps: ALIPAY_GUIDE }}
        onPick={(files) => onFiles(files, 'alipay')}
      />
    </div>
  )
}

function UploadTile({
  emoji,
  title,
  hint,
  accept,
  guide,
  onPick,
}: {
  emoji: string
  title: string
  hint: string
  accept: string
  guide: { title: string; steps: string[] }
  onPick: (files: FileList | null) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  return (
    <Card className="flex flex-col gap-3">
      <div
        className={cn(
          'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-dashed border-theme py-7 text-center transition-colors',
          drag && 'bg-card-alt',
        )}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); onPick(e.dataTransfer.files) }}
        onClick={() => fileRef.current?.click()}
        role="button"
      >
        <span className="text-3xl">{emoji}</span>
        <p className="text-[15px] font-medium text-ink-2">{title}</p>
        <p className="max-w-[280px] text-[12px] leading-relaxed text-ink-4">{hint}</p>
        <span className="mt-1 flex items-center gap-1.5 rounded-lg bg-card-alt px-3 py-1.5 text-[12px] text-ink-3">
          <Upload size={13} /> 点击或拖拽上传
        </span>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          multiple
          className="hidden"
          onChange={(e) => { onPick(e.target.files); e.target.value = '' }}
        />
      </div>
      <Guide title={guide.title} steps={guide.steps} />
    </Card>
  )
}

function Guide({ title, steps }: { title: string; steps: string[] }) {
  return (
    <div className="rounded-xl bg-card-alt p-3">
      <p className="mb-1.5 text-[12px] font-medium text-ink-2">{title}</p>
      <ol className="flex flex-col gap-1">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-ink-3">
            <span className="text-ink-4">{i + 1}.</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/* ── 步骤2：AI 解析 ─────────────────────────────────────────────────────────── */

function StepParsing({
  progress,
  error,
  onRetry,
}: {
  progress: { done: number; total: number; label: string }
  error: string | null
  onRetry: () => void
}) {
  if (error) {
    return (
      <Card className="flex flex-col items-center gap-3 py-8 text-center">
        <AlertTriangle size={28} className="text-amber-500" />
        <p className="max-w-[300px] text-[14px] leading-relaxed text-ink-2">{error}</p>
        <Button variant="ghost" onClick={onRetry}>重新上传</Button>
      </Card>
    )
  }

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0
  return (
    <Card className="flex flex-col items-center gap-4 py-10 text-center">
      <div className="relative">
        <div className="animate-bounce text-5xl">🌰</div>
        <span className="absolute -right-3 -top-1 animate-ping text-[14px]">✨</span>
        <span className="absolute -left-3 top-2 animate-pulse text-[12px]">⭐</span>
      </div>
      <p className="text-[14px] font-medium text-ink-2">{progress.label}</p>
      <p className="text-[13px] text-ink-4 tabular-nums">
        已处理 {progress.done} / {progress.total || '…'} 条记录…
      </p>
      <div className="h-1.5 w-48 overflow-hidden rounded-full bg-card-alt">
        <div className="h-full rounded-full bg-[#8B6A4A] transition-all" style={{ width: `${pct}%` }} />
      </div>
    </Card>
  )
}

/* ── 步骤3：预览 + 确认 ─────────────────────────────────────────────────────── */

function StepConfirm({
  drafts,
  stats,
  filter,
  onFilter,
  onPick,
  onImport,
  importing,
  error,
}: {
  drafts: Draft[]
  stats: Stats
  filter: Filter
  onFilter: (f: Filter) => void
  onPick: (id: string, c: ItemCategory) => void
  onImport: () => void
  importing: boolean
  error: string | null
}) {
  // reviewCount 随用户手动确认实时变化，故由 drafts 现算，而非用初始 stats。
  const reviewCount = drafts.filter((d) => d.needs_review).length
  // 待确认优先，其余保持原序。
  const sorted = [...drafts].sort((a, b) => Number(b.needs_review) - Number(a.needs_review))
  const visible = sorted.filter((d) => {
    if (filter === 'review') return d.needs_review
    if (filter === 'basic') return d.category_main === 'basic_life'
    if (filter === 'discretionary') return d.category_main === 'discretionary'
    return true
  })

  return (
    <div className="flex flex-col gap-4">
      {/* 汇总卡 */}
      <Card style={{ background: '#3D2B1F' }} className="flex flex-col gap-2 text-white">
        <SummaryRow label="解析记录" value={`${stats.total} 条`} />
        <SummaryRow label="过滤退款/转账" value={`${stats.skipped} 条`} />
        <SummaryRow label="准备导入（近6个月）" value={`${stats.prepared} 条`} strong />
        <SummaryRow label="需确认分类" value={`${reviewCount} 条 ⚠`} warn />
      </Card>

      {/* 筛选 */}
      <FilterSelect value={filter} onChange={onFilter} />

      {/* 预览列表 */}
      <div className="flex flex-col gap-2">
        {visible.length === 0 && (
          <Card><p className="text-center text-[13px] text-ink-4">没有符合筛选条件的记录</p></Card>
        )}
        {visible.map((d) => (
          <DraftRow key={d.id} draft={d} onPick={(c) => onPick(d.id, c)} />
        ))}
      </div>

      {error && <p className="text-[13px] text-red-500">{error}</p>}

      {/* 底部按钮 */}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={onImport} disabled={importing} className="flex-1">
          跳过，全部导入
        </Button>
        <Button onClick={onImport} disabled={importing} className="flex-1">
          {importing ? '导入中…' : `✓ 确认导入 ${stats.prepared} 条`}
        </Button>
      </div>
    </div>
  )
}

function SummaryRow({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[13px] text-white/70">{label}</span>
      <span
        className={cn(
          'font-serif tabular-nums',
          strong ? 'text-[18px]' : 'text-[15px]',
          warn ? 'text-amber-300' : 'text-white',
        )}
      >
        {value}
      </span>
    </div>
  )
}

function FilterSelect({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const opts: { key: Filter; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'review', label: '仅待确认' },
    { key: 'basic', label: '基础支出' },
    { key: 'discretionary', label: '可支配消费' },
  ]
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Filter)}
        className="w-full appearance-none rounded-xl border-theme bg-card px-3.5 py-2.5 text-[13px] text-ink-2"
      >
        {opts.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-4" />
    </div>
  )
}

function DraftRow({ draft, onPick }: { draft: Draft; onPick: (c: ItemCategory) => void }) {
  const [open, setOpen] = useState(false)
  const meta = CATEGORY_META[draft.category]
  const needsReview = draft.needs_review

  return (
    <Card className="py-3">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-[16px]">{meta.emoji}</span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] text-ink-2">{draft.description}</span>
            <span className="text-[11px] text-ink-4 tabular-nums">
              {PLATFORM_LABEL[draft.platform]} · {draft.date.slice(5)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {needsReview ? (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">⚠ {meta.label}</span>
          ) : draft.confirmed ? (
            <span className="flex items-center gap-0.5 rounded-full bg-green-100 px-1.5 py-0.5 text-[11px] text-green-700">
              <Check size={10} /> {meta.label}
            </span>
          ) : (
            <span className="rounded border-theme px-1.5 py-0.5 text-[11px] text-ink-4">{meta.label}</span>
          )}
          <span className="font-serif text-[15px] text-ink tabular-nums">{formatAmount(draft.amount)}</span>
        </span>
      </button>

      {open && (
        <div className="mt-3 border-t-theme pt-3">
          <p className="mb-2 text-[12px] text-ink-4">选择分类：</p>
          <CategoryPicker value={draft.category} onChange={(c) => { onPick(c); setOpen(false) }} />
        </div>
      )}
    </Card>
  )
}
