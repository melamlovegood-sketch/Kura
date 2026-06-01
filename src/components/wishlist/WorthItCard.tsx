import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { useSettingsStore } from '@/store/settings'
import { useBudgetStore } from '@/store/budget'
import { fileToCompressedBase64 } from '@/lib/utils'
import {
  analyzeExperience,
  analyzeWithAI,
  classifyWorthKind,
  WORTH_KIND_LABEL,
  type WorthKind,
} from '@/lib/worthItAnalysis'
import type { WishlistItem } from '@/types/db'

/**
 * 值不值反查 (SPEC_PHASE2 §4). Inline assessment card for a wishlist item. Branch
 * by category: experience goods get a deterministic budget-impact verdict;
 * standard/premium goods get a streamed AI assessment. Premium goods may attach
 * a product photo for material analysis.
 */
export function WorthItCard({ item, onClose }: { item: WishlistItem; onClose: () => void }) {
  const adapter = useSettingsStore((s) => s.adapter)
  const discretionaryLimit = useBudgetStore((s) => s.data?.discretionary_limit ?? null)
  const refreshBudget = useBudgetStore((s) => s.refresh)
  const kind: WorthKind = classifyWorthKind(item)

  const [text, setText] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [image, setImage] = useState<{ file: File; base64: string } | null>(null)
  const [started, setStarted] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  async function runAI() {
    if (!adapter) { setError('请先在设置里填写 API Key'); return }
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setStarted(true); setAnalyzing(true); setError(null); setText('')
    try {
      await analyzeWithAI(adapter, kind as 'standard' | 'premium', item, image?.base64, (delta) => {
        setText((t) => t + delta)
      }, ctrl.signal)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message || '评估失败，请重试')
    } finally {
      setAnalyzing(false)
    }
  }

  // Experience → instant local verdict. Standard → auto-run AI. Premium waits for
  // the user (optional photo) and an explicit 开始评估.
  useEffect(() => {
    if (kind === 'experience') {
      setStarted(true)
      // Budget may not be loaded yet if Wishlist was opened directly — refresh,
      // then read the freshest limit before computing the verdict.
      void Promise.resolve(discretionaryLimit == null ? refreshBudget() : undefined).then(() => {
        const limit = useBudgetStore.getState().data?.discretionary_limit ?? null
        setText(analyzeExperience(item, { discretionaryLimit: limit }))
      })
    } else if (kind === 'standard') {
      void runAI()
    }
    return () => abortRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // base64 流向视觉模型(analyzeWithAI → worthItAnalysis)，先压缩再编码，避免手机原图过大。
  async function handleFile(_base64: string, file: File) { setImage({ file, base64: await fileToCompressedBase64(file) }) }

  return (
    <Card className="border-amber-200 bg-amber-50/40">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-4">
          值不值 · {WORTH_KIND_LABEL[kind]}
        </p>
        <button onClick={onClose} className="text-ink-4 hover:text-ink-3 transition-colors"><X size={14} /></button>
      </div>

      {kind === 'premium' && !started && (
        <ImageDropZone onFile={handleFile} className="flex flex-col gap-2.5">
          <p className="text-[13px] leading-relaxed text-ink-3">
            溢价品可上传商品图片，AI 会识别材质再评估性价比；不传也能评估。
          </p>
          {image && (
            <div className="flex items-center gap-2">
              <span className="max-w-[200px] truncate text-[13px] text-ink-3">{image.file.name}</span>
              <button onClick={() => setImage(null)} className="text-ink-4 hover:text-ink-3 transition-colors"><X size={13} /></button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <button onClick={() => fileRef.current?.click()} className="text-[13px] text-ink-4 hover:text-ink-3 transition-colors">上传图片</button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return; await handleFile('', f); e.target.value = ''
            }} />
            <div className="flex-1" />
            <Button size="sm" onClick={() => void runAI()}>开始评估</Button>
          </div>
        </ImageDropZone>
      )}

      {started && (
        <>
          {error ? (
            <p className="text-[14px] text-ink-3">{error}</p>
          ) : text ? (
            <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{text}</p>
          ) : (
            <p className="flex items-center gap-1.5 text-[14px] text-ink-3">
              正在评估<span className="inline-block h-3 w-0.5 animate-pulse bg-ink-4" />
            </p>
          )}
          {analyzing && text && <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-ink-4 align-middle" />}
        </>
      )}
    </Card>
  )
}
