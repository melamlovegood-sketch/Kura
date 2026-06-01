import { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Paperclip, Pencil, Plus, Sparkles, X } from 'lucide-react'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ImageDropZone } from '@/components/ui/image-drop-zone'
import { useExecutionStore, type SOPRule } from '@/store/execution'
import { useSettingsStore } from '@/store/settings'
import { parseSOPRule } from '@/lib/parseSOPRule'
import { fileToCompressedBase64, cn } from '@/lib/utils'

/**
 * 购物原则 (SOP rules) — a single shared section used both in the 执行层 setup
 * (collapsible) and on 我的消费观 (always-open card). Both read/write the same
 * `sop_rules` via the execution store, so an edit in one place shows in the other.
 *
 * Adding goes through SOPAddModal (AI 帮我写 / 手动添加); editing & deleting are
 * inline. New users start with an empty list (the old default seed was removed).
 */
export function ShoppingPrinciplesSection({ collapsible = false, defaultOpen = true }: {
  collapsible?: boolean
  defaultOpen?: boolean
}) {
  const execStore = useExecutionStore()
  const rules = execStore.sopRules
  const [open, setOpen] = useState(defaultOpen)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const body = (
    <div className={cn('flex flex-col gap-2.5', collapsible && 'mt-4')}>
      {rules.length === 0 && <p className="text-[13px] text-ink-4">还没有购物原则</p>}

      <ul className="flex flex-col gap-2.5">
        {rules.map((rule, i) =>
          editingId === rule.id ? (
            <SOPEditRow
              key={rule.id}
              rule={rule}
              onSave={async (patch) => { await execStore.updateSOPRule(rule.id, patch); setEditingId(null) }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <li key={rule.id} className="flex items-start gap-2.5 text-[15px]">
              <span className="mt-0.5 shrink-0 text-[13px] text-ink-4">{i + 1}.</span>
              <div className="min-w-0 flex-1">
                <span className="font-medium text-ink-2">{rule.title}</span>
                {rule.content !== rule.title && <span className="text-ink-3"> — {rule.content}</span>}
              </div>
              <button onClick={() => setEditingId(rule.id)} className="mt-0.5 shrink-0 text-ink-4 hover:text-ink-3 transition-colors"><Pencil size={13} /></button>
              <button onClick={() => void execStore.deleteSOPRule(rule.id)} className="mt-0.5 shrink-0 text-ink-4 hover:text-ink-3 transition-colors"><X size={13} /></button>
            </li>
          ),
        )}
      </ul>

      <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 text-[13px] text-ink-4 hover:text-ink-3 transition-colors">
        <Plus size={13} /> 添加原则
      </button>
    </div>
  )

  return (
    <Card>
      {collapsible ? (
        <>
          <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
            <CardTitle>购物原则</CardTitle>
            {open ? <ChevronDown size={14} className="text-ink-4" /> : <ChevronRight size={14} className="text-ink-4" />}
          </button>
          {open && body}
        </>
      ) : (
        <>
          <CardHeader><CardTitle>购物原则</CardTitle></CardHeader>
          {body}
        </>
      )}

      {showAdd && (
        <SOPAddModal
          onClose={() => setShowAdd(false)}
          onSave={async (title, content) => { await execStore.addSOPRule(title, content); setShowAdd(false) }}
        />
      )}
    </Card>
  )
}

/** Inline title + content editor, shared by add-confirm and edit flows. */
export function SOPEditRow({ rule, onSave, onCancel }: {
  rule: SOPRule; onSave: (patch: { title: string; content: string }) => Promise<void>; onCancel: () => void
}) {
  const [title, setTitle]     = useState(rule.title)
  const [content, setContent] = useState(rule.content === rule.title ? '' : rule.content)
  const [saving, setSaving]   = useState(false)

  async function handleSave() {
    if (!title.trim()) return
    setSaving(true)
    try { await onSave({ title: title.trim(), content: content.trim() || title.trim() }) }
    finally { setSaving(false) }
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border-theme bg-card-alt p-2.5">
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="标题，如：裤子" autoFocus
        className="w-full bg-transparent text-[15px] font-medium text-ink outline-none placeholder:text-ink-4" />
      <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="具体原则（可留空，留空则只显示标题）" rows={2}
        className="w-full resize-none bg-transparent text-[14px] text-ink-2 outline-none placeholder:text-ink-4" />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>取消</Button>
        <Button size="sm" onClick={() => void handleSave()} disabled={saving || !title.trim()}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </li>
  )
}

/**
 * Add-principle modal. Two paths from the same input:
 *   AI 帮我写 → parseSOPRule extracts {title, content}; the user confirms/edits
 *              it (SOPEditRow) before saving.
 *   手动添加 → save the typed text directly (title = content = text).
 */
function SOPAddModal({ onClose, onSave }: {
  onClose: () => void
  onSave: (title: string, content: string) => Promise<void>
}) {
  const adapter = useSettingsStore((s) => s.adapter)
  const [text, setText] = useState('')
  const [image, setImage] = useState<{ name: string; base64: string } | null>(null)
  const [busy, setBusy] = useState<null | 'ai' | 'manual'>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<SOPRule | null>(null) // AI result awaiting confirm
  const fileRef = useRef<HTMLInputElement>(null)

  const hasInput = !!text.trim() || !!image

  async function handleAI() {
    if (!hasInput || busy) return
    if (!adapter) { setError('请先在设置里填写 API Key 并保存'); return }
    setBusy('ai'); setError(null)
    try {
      const parsed = await parseSOPRule(adapter, text, image?.base64)
      // Hand off to the inline editor for confirmation before saving.
      setDraft({ id: '', title: parsed.title, content: parsed.content, order: 0 })
    } catch (err) {
      setError(`解析失败：${(err as Error).message || '请稍后重试'}`)
    } finally { setBusy(null) }
  }

  async function handleManual() {
    const t = text.trim()
    if (!t || busy) return
    setBusy('manual'); setError(null)
    try { await onSave(t, t) }
    catch (err) { setError(`保存失败：${(err as Error).message || '请稍后重试'}`); setBusy(null) }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-6"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-[420px] rounded-2xl bg-card p-5 [animation:sheet-slide-up_0.24s_cubic-bezier(0.32,0.72,0,1)]">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[16px] font-medium text-ink">添加购物原则</h3>
          <button onClick={onClose} disabled={!!busy} className="text-ink-4 transition-colors hover:text-ink-3 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        {draft ? (
          // AI 写完 → 用户确认/编辑后存入
          <ul>
            <SOPEditRow
              rule={draft}
              onSave={async (patch) => { await onSave(patch.title, patch.content) }}
              onCancel={() => setDraft(null)}
            />
          </ul>
        ) : (
          <ImageDropZone
            onFile={async (_base64, file) => { setImage({ name: file.name, base64: await fileToCompressedBase64(file) }); setError(null) }}
            className="flex flex-col gap-3"
          >
            <textarea
              value={text}
              onChange={(e) => { setText(e.target.value); setError(null) }}
              placeholder={'描述你的原则，或拖拽截图到这里…\n例："裤子只去线下试穿满意再网上买"'}
              rows={3}
              autoFocus
              className="w-full resize-none rounded-xl border-theme bg-card-alt px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-4 focus:bg-card focus:outline-none focus:ring-1 focus:ring-[var(--border)] transition-colors"
            />

            {image && (
              <div className="flex items-center gap-2">
                <span className="max-w-[220px] truncate text-[13px] text-ink-4">{image.name}</span>
                <button onClick={() => setImage(null)} className="text-ink-4 transition-colors hover:text-ink-3"><X size={13} /></button>
              </div>
            )}

            <button onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 self-start text-[13px] text-ink-3 transition-colors hover:text-ink-2">
              <Paperclip size={14} /> 上传截图
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden"
              onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setImage({ name: f.name, base64: await fileToCompressedBase64(f) }); setError(null); e.target.value = '' }} />

            {error && <p className="text-[13px] text-red-500">{error}</p>}

            <div className="mt-1 flex gap-2.5">
              <Button variant="outline" className="flex-1" onClick={() => void handleAI()} disabled={!hasInput || !!busy}>
                <Sparkles size={14} className="mr-1" /> {busy === 'ai' ? '识别中…' : 'AI 帮我写'}
              </Button>
              <Button className="flex-1" onClick={() => void handleManual()} disabled={!text.trim() || !!busy}>
                {busy === 'manual' ? '保存中…' : '手动添加'}
              </Button>
            </div>
          </ImageDropZone>
        )}
      </div>
    </div>
  )
}
