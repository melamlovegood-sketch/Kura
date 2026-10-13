import { handleAnalyzeImage } from '../server/analyze-image.js'

// Vercel discovers functions in /api, rather than Cloudflare's /functions/api.
export default { fetch: handleAnalyzeImage }
