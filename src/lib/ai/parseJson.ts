/**
 * Pull a JSON object out of a model's raw text response.
 *
 * Vision models are inconsistent about formatting their JSON: some wrap it in a
 * ```json fence, some add a Chinese preamble ("根据图片，商品信息如下：") before it,
 * some add a trailing note after the closing brace. The previous `^```...$/m`
 * regex only handled the clean fenced case and silently produced unparseable
 * strings (→ empty/null fields) the moment the model added any surrounding prose.
 *
 * Strategy, most-specific first:
 *   1. Strip a leading/trailing markdown code fence if present.
 *   2. Try to parse what's left.
 *   3. Fall back to slicing from the first `{` to the last `}` — this discards any
 *      preamble/epilogue prose and keeps just the object literal.
 *
 * Throws if no parseable object can be recovered, so callers can surface a clear
 * "couldn't read the screenshot" error instead of writing empty data.
 */
export function extractJsonObject<T = Record<string, unknown>>(raw: string): T {
  const text = raw.trim()

  // 1. Strip surrounding ```json … ``` (or bare ``` … ```) fences, anywhere.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidates = [fenced?.[1]?.trim(), text].filter(Boolean) as string[]

  for (const candidate of candidates) {
    // 2. Direct parse.
    try {
      return JSON.parse(candidate) as T
    } catch {
      /* fall through to brace-slicing */
    }

    // 3. Slice from the first `{` to the last `}` to drop any surrounding prose.
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T
      } catch {
        /* try next candidate */
      }
    }
  }

  throw new Error('No parseable JSON object in model response')
}
