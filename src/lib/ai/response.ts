/** Distinguish a missing deployment route from a provider/key error. */
export async function assertAIResponse(res: Response, provider: string): Promise<void> {
  const type = res.headers.get('Content-Type') ?? ''
  if (type.includes('text/html') || (res.status === 404 && !type.includes('application/json'))) {
    throw new Error('AI 接口未部署（/api 路由不存在），请更新网站部署后重试')
  }
  if (!res.ok) {
    const raw = await res.text()
    let detail = raw
    try {
      const data = JSON.parse(raw)
      detail = typeof data.error === 'string' ? data.error : data.error?.message ?? data.message ?? raw
    } catch { /* upstream can return a plain-text error */ }
    throw new Error(`${provider} API error ${res.status}: ${detail}`)
  }
}
