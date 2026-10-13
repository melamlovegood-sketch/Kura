import { chromium } from 'playwright'
import { createServer } from 'vite'
import assert from 'node:assert/strict'

const originalFetch = globalThis.fetch
let upstreamCalls = 0
const reply = JSON.stringify({ module: 'wishlist', confidence: 1, data: { item_name: '一杯水', estimated_price: 2 }, display_text: '一杯水' })
globalThis.fetch = async () => {
  upstreamCalls++
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
}
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://example.supabase.co'),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('test-anon-key'),
} })
await server.listen()
const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    localStorage.setItem('kura_guest_mode', 'true')
    localStorage.setItem('kura-onboarding-done', 'true')
    localStorage.setItem('kura_guest_user_settings', JSON.stringify([{ id: 'settings-test', ai_provider: 'qwen', ai_model: 'qwen-vl-plus', ai_api_key: 'test-key' }]))
  })
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '我现在想买……', exact: true }).click()
  await page.locator('textarea').fill('一杯水')
  await page.getByRole('button', { name: '加进清单再想想', exact: true }).click()
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('kura_guest_wishlist_items') || '[]').some(x => x.item_name === '一杯水' && x.estimated_price === 2))
  assert.equal(upstreamCalls, 1)
  console.log('PASS: guest purchase drawer sends 一杯水 through the actual local proxy and saves the parsed item')
} finally {
  await browser.close()
  await server.close()
  globalThis.fetch = originalFetch
}
