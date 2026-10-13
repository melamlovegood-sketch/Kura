import { json, fetchDashscope } from './dashscope-http.js'

export async function handleDashscope(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: '请使用 POST 请求' }, 405)
  const auth = request.headers.get('Authorization')
  const key = auth?.match(/^Bearer\s+(.+)$/i)?.[1].trim()
  if (!key) {
    return json({ error: '缺少 API Key（请在设置里填写）' }, 401)
  }

  const upstream = await fetchDashscope({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: await request.text(),
    signal: request.signal,
  })

  // Stream the response (which may be an SSE token stream) straight back to the
  // client, preserving the upstream status and content type.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}

