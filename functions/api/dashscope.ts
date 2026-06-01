/// <reference types="@cloudflare/workers-types" />

/**
 * Cloudflare Pages Function — general server-side proxy for the Qwen / dashscope
 * OpenAI-compatible chat endpoint.
 *
 * Calling dashscope.aliyuncs.com directly from the browser fails with
 * ERR_CONNECTION_CLOSED for users in mainland China (CORS preflight + the
 * connection getting reset). Routing every Qwen request through this same-origin
 * function fixes that: the browser talks to our own domain, the function forwards
 * the request server-side, and the (streaming SSE) response is piped straight
 * back so the client's stream reader keeps working unchanged.
 *
 * No server-side secret: the user's own API key (entered in Settings) is sent by
 * the client in the Authorization header and this function simply relays it.
 *
 * This is a thin transport proxy, so one code path serves every Qwen flow —
 * chat, product parsing, price/budget parsing, screenshot intent routing, etc.
 */

const DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'

export const onRequestPost: PagesFunction = async (context) => {
  const { request } = context

  const auth = request.headers.get('Authorization')
  if (!auth) {
    return json({ error: '缺少 API Key（请在设置里填写）' }, 401)
  }

  const upstream = await fetch(DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: auth,
    },
    body: await request.text(),
  })

  // Stream the response (which may be an SSE token stream) straight back to the
  // client, preserving the upstream status and content type.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
