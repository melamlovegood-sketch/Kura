import type { AIAdapter, AIMessage } from '../types'
import { assertAIResponse } from '../response'

// Qwen uses an OpenAI-compatible endpoint via dashscope. We never call dashscope
// directly from the browser — that fails with ERR_CONNECTION_CLOSED in mainland
// China — so every request goes through our same-origin /api/dashscope handler
// (Vercel, Cloudflare Pages or Vite), which forwards it and streams the SSE
// response back unchanged. The user's own API key (from Settings) rides along in
// the Authorization header; the function just relays it — no server-side secret.
const PROXY_URL = '/api/dashscope'

export class QwenAdapter implements AIAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = 'qwen-vl-plus',
  ) {}

  async streamChat(
    messages: AIMessage[],
    onChunk: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey.trim()}`,
      },
      body: JSON.stringify({ model: this.model.trim(), messages, stream: true }),
      signal,
    })

    await assertAIResponse(res, 'Qwen')

    return readOpenAIStream(res, onChunk)
  }
}

// Shared SSE reader for OpenAI-compatible streams (used by Qwen + GPT adapters)
export async function readOpenAIStream(
  res: Response,
  onChunk: (delta: string) => void,
): Promise<string> {
  if (!res.body) throw new Error('AI 返回了空响应，请重试')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buf = ''

  function consume(line: string): boolean {
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') return true
    if (!payload) return false
    let json
    try { json = JSON.parse(payload) } catch { return false }
    if (json.error) {
      throw new Error(`AI stream error: ${json.error.message ?? JSON.stringify(json.error)}`)
    }
    const rawDelta = json.choices?.[0]?.delta?.content
    const delta =
      typeof rawDelta === 'string'
        ? rawDelta
        : Array.isArray(rawDelta)
          ? rawDelta.map((p: { text?: string } | string) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
          : ''
    if (delta) { full += delta; onChunk(delta) }
    return false
  }

  try {
    let finished = false
    while (!finished) {
      const { done, value } = await reader.read()
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (consume(line)) { finished = true; break }
      }
      if (done) { if (!finished) consume(buf); break }
    }
    if (!full.trim()) throw new Error('AI 未返回文字，请检查模型是否支持对话后重试')
    return full
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}
