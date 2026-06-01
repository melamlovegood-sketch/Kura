import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { useSettingsStore } from '@/store/settings'
import { usePrinciplesStore } from '@/store/principles'
import { routeIntent } from '@/lib/ai/router'
import { fileToCompressedBase64 } from '@/lib/utils'

/**
 * 个人消费原则 — text or article-screenshot → AI-extracted principles that get
 * injected into every analysis context. Lives on the 我的消费观 page (bug10).
 */
export function PrinciplesSection() {
  const { adapter }      = useSettingsStore()
  const principlesStore  = usePrinciplesStore()
  const [input, setInput]       = useState('')
  const [image, setImage]       = useState<{ file: File; base64: string } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // base64 流向视觉模型(routeIntent)，先压缩再编码，避免手机原图过大让请求卡死/失败。
  async function handleFileSelect(_base64: string, file: File) { setImage({ file, base64: await fileToCompressedBase64(file) }) }

  async function handleExtract() {
    if (!input.trim() && !image) return
    if (!adapter) { alert('请先在设置里填写 API Key 并保存'); return }
    setExtracting(true)
    try {
      const result = await routeIntent(adapter, input.trim() || '请从图片中提取消费原则', image?.base64, undefined, undefined, [])
      if (result.module === 'principles' && Array.isArray(result.data.items)) {
        await principlesStore.add(result.data.items as string[]); setInput(''); setImage(null)
      } else if (input.trim()) {
        await principlesStore.add([input.trim()]); setInput('')
      }
    } finally { setExtracting(false) }
  }

  return (
    <Card>
      <CardHeader><CardTitle>个人消费原则</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-[13px] leading-relaxed text-ink-4">用大白话描述消费理念，或上传文章截图。AI 提取后注入每次分析的上下文。</p>

        <ImageDropZone onFile={handleFileSelect} className="flex flex-col gap-2">
          {image && (
            <div className="flex items-center gap-2">
              <span className="max-w-[200px] truncate text-[13px] text-ink-3">{image.file.name}</span>
              <button onClick={() => setImage(null)} className="text-ink-4 hover:text-ink-3 transition-colors"><X size={13} /></button>
            </div>
          )}
          <textarea value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={'描述消费原则，或拖拽文章截图到这里…\n例："宁可买一件贵的也不买几件便宜货"'}
            rows={3}
            className="w-full resize-none rounded-xl border-theme bg-card-alt px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-4 focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)] transition-colors" />
          <div className="flex items-center gap-3">
            <button onClick={() => fileRef.current?.click()} className="text-[13px] text-ink-4 hover:text-ink-3 transition-colors">上传截图</button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return; await handleFileSelect('', f); e.target.value = ''
            }} />
            <div className="flex-1" />
            <Button size="sm" onClick={() => void handleExtract()} disabled={extracting || (!input.trim() && !image)}>
              {extracting ? 'AI 提取中…' : '添加原则'}
            </Button>
          </div>
        </ImageDropZone>

        {principlesStore.items.length > 0 ? (
          <ul className="flex flex-col">
            {principlesStore.items.map((p, i) => (
              <li key={p.id} className="flex items-start gap-2 py-2.5 text-[15px] border-t-theme first:border-t-0">
                <span className="mt-0.5 shrink-0 text-[13px] text-ink-4">{i + 1}</span>
                <span className="flex-1 text-ink-2">{p.content}</span>
                <button onClick={() => void principlesStore.remove(p.id)} className="mt-0.5 shrink-0 text-ink-4 hover:text-ink-3 transition-colors"><X size={13} /></button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-4">还没有消费原则</p>
        )}
      </CardContent>
    </Card>
  )
}
