import type { VercelRequest, VercelResponse } from '@vercel/node'

/**
 * Server-side proxy for the Qwen / dashscope OpenAI-compatible chat endpoint.
 *
 * Calling dashscope.aliyuncs.com directly from the browser fails with
 * ERR_CONNECTION_CLOSED for users in mainland China (CORS preflight + the
 * connection getting reset). Routing every Qwen request through this same-origin
 * function fixes that: the request goes to our Vercel domain, the function
 * forwards it server-side, and the SSE stream is piped straight back so the
 * client's existing stream reader keeps working unchanged.
 *
 * The request/response bodies are passed through verbatim — this is a thin
 * transport proxy, not an image-specific endpoint, so it serves every Qwen flow
 * (chat, product parsing, screenshot field extraction, …) with one code path.
 */

const DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  // Prefer the server-managed key (so the secret never ships to the browser);
  // fall back to the key the client forwarded so the app still works before the
  // env var is configured on Vercel.
  const forwarded = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const apiKey = process.env.DASHSCOPE_API_KEY || forwarded
  if (!apiKey) {
    res.status(500).json({ error: 'DASHSCOPE_API_KEY 未配置' })
    return
  }

  const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

  const controller = new AbortController()
  // If the browser hangs up (user navigated away / aborted), stop the upstream
  // request too instead of leaving it running.
  req.on('close', () => controller.abort())

  let upstream: Response
  try {
    upstream = await fetch(DASHSCOPE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    res.status(502).json({ error: `上游请求失败：${(err as Error).message}` })
    return
  }

  res.status(upstream.status)
  const contentType = upstream.headers.get('content-type')
  if (contentType) res.setHeader('Content-Type', contentType)

  if (!upstream.body) {
    res.end(await upstream.text())
    return
  }

  // Pipe the (streaming) body through chunk-by-chunk so token-by-token SSE
  // responses reach the client as they arrive.
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      // The stream broke mid-flight; close the connection so the client errors
      // out rather than hanging forever.
    }
  } finally {
    res.end()
  }
}
