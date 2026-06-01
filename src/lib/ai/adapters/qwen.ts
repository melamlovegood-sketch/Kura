import type { AIAdapter, AIMessage } from '../types'

// Qwen uses an OpenAI-compatible endpoint via dashscope. We never call dashscope
// directly from the browser — that fails with ERR_CONNECTION_CLOSED in mainland
// China — so every request goes through our same-origin Cloudflare Pages Function
// (functions/api/dashscope.ts), which forwards it server-side and streams the SSE
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
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
      signal,
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Qwen API error ${res.status}: ${err}`)
    }

    return readOpenAIStream(res, onChunk)
  }
}

// Shared SSE reader for OpenAI-compatible streams (used by Qwen + GPT adapters)
export async function readOpenAIStream(
  res: Response,
  onChunk: (delta: string) => void,
): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') return full

      try {
        const json = JSON.parse(payload)
        // Surface API errors that arrive inside the stream body (HTTP was 200)
        if (json.error) {
          throw new Error(`Qwen stream error: ${json.error.message ?? JSON.stringify(json.error)}`)
        }
        // qwen-vl models can return delta.content as a string OR an array of parts
        const rawDelta = json.choices?.[0]?.delta?.content
        const delta =
          typeof rawDelta === 'string'
            ? rawDelta
            : Array.isArray(rawDelta)
              ? rawDelta.map((p: { text?: string } | string) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
              : ''
        if (delta) {
          full += delta
          onChunk(delta)
        }
      } catch (e) {
        // Re-throw real API errors; only swallow JSON parse failures on partial chunks
        if (e instanceof Error && e.message.startsWith('Qwen stream error')) throw e
        // malformed chunk, skip
      }
    }
  }

  return full
}
