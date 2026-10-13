import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Plugin } from 'vite'
import { handleDashscope } from './dashscope'
import { handleAnalyzeImage } from './analyze-image'

const handlers: Record<string, (request: Request) => Promise<Response>> = {
  '/api/dashscope': handleDashscope,
  '/api/analyze-image': handleAnalyzeImage,
}

// Vite serves the SPA alone by default. Run the same API handlers in development
// and preview so /api requests never fall through to index.html.
export function aiApiPlugin(): Plugin {
  async function middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const handler = handlers[url.pathname]
    if (!handler) { next(); return }

    const controller = new AbortController()
    const onClose = () => { if (!res.writableFinished) controller.abort() }
    res.on('close', onClose)
    try {
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      const request = new Request(url, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        signal: controller.signal,
      })
      const response = await handler(request)
      res.statusCode = response.status
      response.headers.forEach((value, name) => res.setHeader(name, value))
      if (response.body) await pipeline(Readable.fromWeb(response.body), res)
      else res.end()
    } catch {
      if (controller.signal.aborted) return
      if (res.headersSent) { res.destroy(); return }
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'AI 接口处理失败，请稍后重试' }))
    } finally {
      res.off('close', onClose)
    }
  }

  return {
    name: 'kura-ai-api',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
