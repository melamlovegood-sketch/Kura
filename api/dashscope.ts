import { handleDashscope } from '../server/dashscope.js'

// Vercel discovers functions in /api, rather than Cloudflare's /functions/api.
export default { fetch: handleDashscope }
