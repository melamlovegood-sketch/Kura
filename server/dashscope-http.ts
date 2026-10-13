export const DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

export async function fetchDashscope(init: RequestInit): Promise<Response> {
  try {
    return await fetch(DASHSCOPE_URL, init)
  } catch (error) {
    if (init.signal?.aborted) throw error
    // Do not include request headers/body (which contain the user's key).
    return json({ error: '无法连接通义千问，请稍后重试' }, 502)
  }
}
