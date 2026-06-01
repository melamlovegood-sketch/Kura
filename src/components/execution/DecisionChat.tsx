import { useRef, useState } from 'react'
import { ImagePlus, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/store/settings'
import { fileToCompressedBase64 } from '@/lib/utils'
import { buildDecisionChatSystemPrompt, type ExecutionContext } from '@/lib/generateDecisionBrief'
import type { AIMessage, ContentPart } from '@/lib/ai/types'

interface ChatTurn { role: 'user' | 'assistant'; text: string; image?: string }

/**
 * 决策对话（SPEC_PHASE3 §4.3）. A persistent chat box that lives under the
 * timer / checklist in both modes. The assistant gets the full execution context
 * (category, price, SOP, brands, wish-pool, budget, history) so its advice is
 * about "this user, right now" — not generic. Supports text + image, multi-turn.
 */
export function DecisionChat({ context }: { context: ExecutionContext }) {
  const adapter = useSettingsStore((s) => s.adapter)
  const [turns, setTurns]   = useState<ChatTurn[]>([])
  const [text, setText]     = useState('')
  const [image, setImage]   = useState<{ file: File; base64: string } | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [reply, setReply]   = useState('') // live-streaming assistant text
  const abortRef = useRef<AbortController | null>(null)
  const fileRef  = useRef<HTMLInputElement>(null)

  async function handleSend() {
    if (streaming) return
    if (!text.trim() && !image) return
    if (!adapter) return

    const userTurn: ChatTurn = { role: 'user', text: text.trim() || '（图片）', image: image?.base64 }
    const history = [...turns, userTurn]
    setTurns(history); setText(''); setImage(null); setReply(''); setStreaming(true)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Rebuild the message list each send: system prompt (with live context) + the
    // running conversation. Images ride along as multimodal content parts.
    const messages: AIMessage[] = [{ role: 'system', content: buildDecisionChatSystemPrompt(context) }]
    for (const t of history) {
      if (t.image) {
        const parts: ContentPart[] = [{ type: 'text', text: t.text }, { type: 'image_url', image_url: { url: t.image } }]
        messages.push({ role: t.role, content: parts })
      } else {
        messages.push({ role: t.role, content: t.text })
      }
    }

    try {
      const full = await adapter.streamChat(messages, (delta) => setReply((r) => r + delta), ctrl.signal)
      setTurns((ts) => [...ts, { role: 'assistant', text: full }])
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setTurns((ts) => [...ts, { role: 'assistant', text: `出错了：${(err as Error).message || '请稍后重试'}` }])
      }
    } finally {
      setReply(''); setStreaming(false)
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    // 压缩后再编码：base64 会随对话直接发给视觉模型，手机原图过大会让请求卡死/失败。
    setImage({ file, base64: await fileToCompressedBase64(file) }); e.target.value = ''
  }

  return (
    <div className="flex flex-col gap-2.5">
      {(turns.length > 0 || streaming) && (
        <div className="flex flex-col gap-2.5">
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'user' ? 'self-end max-w-[85%]' : 'self-start max-w-[92%]'}>
              <div className={
                t.role === 'user'
                  ? 'rounded-2xl rounded-br-md bg-card-alt px-3.5 py-2 text-[15px] text-ink-2'
                  : 'rounded-2xl rounded-bl-md border-theme bg-card px-3.5 py-2 text-[15px] leading-relaxed text-ink-2 whitespace-pre-wrap'
              }>
                {t.text}
              </div>
            </div>
          ))}
          {streaming && (
            <div className="self-start max-w-[92%]">
              <div className="rounded-2xl rounded-bl-md border-theme bg-card px-3.5 py-2 text-[15px] leading-relaxed text-ink-2 whitespace-pre-wrap">
                {reply || <span className="inline-block h-3 w-0.5 animate-pulse bg-ink-4 align-middle" />}
              </div>
            </div>
          )}
        </div>
      )}

      {image && (
        <div className="flex items-center gap-2">
          <span className="max-w-[200px] truncate text-[13px] text-ink-4">{image.file.name}</span>
          <button onClick={() => setImage(null)} className="text-ink-4 hover:text-ink-3 transition-colors"><X size={14} /></button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <button onClick={() => fileRef.current?.click()} disabled={!adapter}
          className="shrink-0 pb-2 text-ink-4 hover:text-ink-3 transition-colors disabled:opacity-40">
          <ImagePlus size={20} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} />

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() } }}
          placeholder={adapter ? '把你的纠结丢给我…' : '配置 API Key 后可用'}
          disabled={!adapter}
          rows={1}
          className="flex-1 resize-none rounded-xl border-theme bg-card-alt px-3.5 py-2 text-[15px] text-ink placeholder:text-ink-4 focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)] transition-colors disabled:opacity-60"
          style={{ maxHeight: 120 }}
        />

        <Button size="icon" onClick={() => void handleSend()} disabled={streaming || !adapter || (!text.trim() && !image)} className="shrink-0">
          <Send size={15} />
        </Button>
      </div>
    </div>
  )
}
