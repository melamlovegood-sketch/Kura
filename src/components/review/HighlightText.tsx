/**
 * 把【】包裹的关键数字渲染成琥珀色强调。AI 评价里所有关键数字都用【】标注，
 * 这里统一上色，正文其余部分保持常规颜色。
 */
export function HighlightText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/【([^】]*)】/g)
  return (
    <span className={className}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-semibold text-[#B5832E]">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  )
}
