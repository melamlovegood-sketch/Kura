import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { createServer, preview } from 'vite'
import dashscope from '../api/dashscope'
import analyzeImage from '../api/analyze-image'
import { QwenAdapter, readOpenAIStream } from '../src/lib/ai/adapters/qwen'
import { assertAIResponse } from '../src/lib/ai/response'
import { aiApiPlugin } from '../server/vite-api'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })
const chatBody = { model: 'qwen-vl-plus', messages: [{ role: 'user', content: '一杯水' }], stream: true }
const req = (path: string, body: unknown, key?: string) => new Request(`http://localhost/api/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
})
const sse = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
const delta = (content: unknown) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

test('both Vercel routes return JSON 401 for missing keys, not a page 404', async () => {
  globalThis.fetch = async () => { throw new Error('must not contact upstream') }
  for (const [route, body, handler] of [
    ['dashscope', chatBody, dashscope],
    ['analyze-image', { base64: 'aW1hZ2U=' }, analyzeImage],
  ] as const) {
    const response = await handler.fetch(req(route, body))
    assert.equal(response.status, 401)
    assert.match(response.headers.get('Content-Type')!, /application\/json/)
    assert.match((await response.json()).error, /缺少 API Key/)
  }
})

test('Vercel proxy forwards the model, messages and trimmed key and streams without buffering', async () => {
  let finish!: () => void
  const stream = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(delta('一杯水')))
    finish = () => { c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close() }
  } })
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
    assert.deepEqual(JSON.parse(init!.body as string), chatBody)
    assert.ok(init?.signal)
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const response = await dashscope.fetch(req('dashscope', chatBody, '  test-key  '))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const reader = response.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /一杯水/)
  finish()
  assert.match(new TextDecoder().decode((await reader.read()).value), /DONE/)
  reader.releaseLock()
})

test('provider errors retain their original status; network failure becomes JSON 502', async () => {
  for (const status of [401, 403, 404, 429]) {
    globalThis.fetch = async () => Response.json({ error: { message: 'provider error' } }, { status })
    const response = await dashscope.fetch(req('dashscope', chatBody, 'test-key'))
    assert.equal(response.status, status)
    assert.match(await response.text(), /provider error/)
  }
  globalThis.fetch = async () => { throw new TypeError('connection closed') }
  const response = await dashscope.fetch(req('dashscope', chatBody, 'test-key'))
  assert.equal(response.status, 502)
  assert.match((await response.json()).error, /无法连接/)
})

test('image route forwards screenshot and parses vision content parts', async () => {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string)
    assert.equal(body.model, 'qwen-vl-plus')
    assert.equal(body.messages[0].content[0].image_url.url, 'data:image/png;base64,aW1hZ2U=')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
    return Response.json({ choices: [{ message: { content: [
      { text: '```json\n{"name":"一杯水",' }, { text: '"price":2}\n```' },
    ] } }] })
  }
  const response = await analyzeImage.fetch(req('analyze-image', { apiKey: ' test-key ', base64: 'aW1hZ2U=', mimeType: 'image/png' }))
  assert.deepEqual(await response.json(), { ok: true, fields: { name: '一杯水', price: 2 } })
})

test('image validation, unparseable output and rejected keys remain diagnosable', async () => {
  const invalid = new Request('http://localhost/api/analyze-image', { method: 'POST', body: '{' })
  assert.equal((await analyzeImage.fetch(invalid)).status, 400)
  assert.equal((await analyzeImage.fetch(req('analyze-image', { apiKey: 'test-key' }))).status, 400)
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] })
  assert.deepEqual(await (await analyzeImage.fetch(req('analyze-image', { apiKey: 'test-key', base64: 'aW1hZ2U=' }))).json(), { ok: false, raw: 'not JSON' })
  globalThis.fetch = async () => Response.json({ error: { message: 'InvalidApiKey' } }, { status: 401 })
  assert.equal((await analyzeImage.fetch(req('analyze-image', { apiKey: 'test-key', base64: 'aW1hZ2U=' }))).status, 401)
})

test('Qwen adapter decodes UTF-8 SSE split across network chunks and flushes the final line', async () => {
  const bytes = new TextEncoder().encode(delta('一') + delta([{ text: '杯' }, '水']) + 'data:[DONE]')
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/dashscope')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-key')
    assert.equal(JSON.parse(init!.body as string).model, 'qwen-vl-plus')
    return new Response(new ReadableStream({ start(c) {
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7))
      c.close()
    } }), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const chunks: string[] = []
  const text = await new QwenAdapter(' test-key ', ' qwen-vl-plus ').streamChat(chatBody.messages as [{ role: 'user'; content: string }], (c) => chunks.push(c))
  assert.equal(text, '一杯水')
  assert.equal(chunks.join(''), text)
  assert.equal(await readOpenAIStream(sse(delta('尾行').trim()), () => {}), '尾行')
})

test('stream errors and empty output fail instead of accepting a key without a reply', async () => {
  await assert.rejects(readOpenAIStream(sse('data: {"error":{"message":"InvalidApiKey"}}\n\n'), () => {}), /InvalidApiKey/)
  await assert.rejects(readOpenAIStream(sse('data: [DONE]\n\n'), () => {}), /未返回文字/)
  await assert.rejects(readOpenAIStream(new Response(null), () => {}), /空响应/)
})

test('missing Vercel routes and SPA HTML differ from a provider model/key error', async () => {
  await assert.rejects(assertAIResponse(new Response('NOT_FOUND', { status: 404 }), 'Qwen'), /接口未部署/)
  await assert.rejects(assertAIResponse(new Response('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }), 'Qwen'), /接口未部署/)
  await assert.rejects(assertAIResponse(Response.json({ error: { message: 'model not found' } }, { status: 404 }), 'Qwen'), /model not found/)
})

test('Vite dev and preview both serve the real API handlers before SPA fallback', async () => {
  globalThis.fetch = async () => sse(delta('一杯水') + 'data: [DONE]\n\n')
  for (const mode of ['dev', 'preview'] as const) {
    const config = { configFile: false as const, plugins: [aiApiPlugin()], server: { host: '127.0.0.1', port: 0 }, preview: { host: '127.0.0.1', port: 0 } }
    const server = mode === 'dev' ? await createServer(config) : await preview(config)
    if (mode === 'dev' && 'listen' in server) await server.listen()
    const address = server.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    try {
      for (const path of ['/api/dashscope', '/api/analyze-image']) {
        const response = await realFetch(base + path, { method: 'POST', body: '{}' })
        assert.equal(response.status, 401)
        assert.match((await response.json()).error, /缺少 API Key/)
      }
      assert.equal((await realFetch(base + '/api/dashscope')).status, 405)
      const response = await realFetch(base + '/api/dashscope', { method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: JSON.stringify(chatBody) })
      assert.equal(await readOpenAIStream(response, () => {}), '一杯水')
    } finally {
      if ('close' in server) await server.close()
      else await new Promise<void>((resolve) => server.httpServer.close(() => resolve()))
    }
  }
})
