import type { AChunk } from './types.ts'

/**
 * 清理文本中残留的 HTML/Markdown 排版标记（如 <div align="center">、
 * <sup>1</sup>、<table><td>... 等）。这些标记来自 PDF→Markdown 转换，
 * 若不剥离，会让 spaCy 把标签文字和真实词粘连成假名词（如 "/div"、
 * "sup>1</sup"、"Φ.</td><td"）。
 *
 * 策略：
 * 1. 去除所有 <tag> / </tag> / <tag attr="..."> 形式的标记
 * 2. 保留标记内部的文字内容（如 <sup>1</sup> → 1，不是整体删除）
 */
function stripHtmlTags(text: string): string {
  return text
    .replace(/<\/?(?:div|table|tr|td|th|thead|tbody|sup|sub|span|p|br)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '') // 兜底：其他未列出的标签
}

/**
 * 清理 PDF→Markdown 转换残留的 LaTeX 数学公式片段（如 "$\overline{\Phi}T_{CE}$"、
 * "\varphi_1"、"d^{+}$"）。这些残留会被 s0 规则误判为大写开头的"名词"
 * （如 \Phi、\varphi_1、\circ），污染名词表和拓扑邻域关系。
 *
 * 策略：
 * 1. 先去掉 $...$ / $$...$$ 包裹的完整数学环境
 * 2. 再兜底清理裸露在文本中的反斜杠命令序列（\command、\command{...}）
 *    和残留的上下标符号（^{...}、_{...}）
 */
function stripLatexResidue(text: string): string {
  return text
    // 完整的 $...$ / $$...$$ 数学环境（非贪婪，跨越单行）
    .replace(/\$\$[^$]*\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    // 裸露的 LaTeX 命令：\command 或 \command{...}（允许嵌套一层花括号）
    .replace(/\\[a-zA-Z]+(?:\{[^{}]*\})*/g, ' ')
    // 残留的孤立反斜杠
    .replace(/\\+/g, ' ')
    // 残留的上下标花括号片段，如 ^{+}、_{CE}
    .replace(/[\^_]\{[^{}]*\}/g, ' ')
    .replace(/\s{2,}/g, ' ')
}

/** Port of hybridRetrieve.atomSearchText / isRetrievableAtom / tokenizeQuery */
export function atomSearchText(input: {
  kind: string
  content: string
  faces: {
    text?: { content: string }
    fig?: { note: string; figId?: string }
  }
}): string {
  const text = input.faces.text?.content?.trim()
  if (text && text.length >= 8) return stripLatexResidue(stripHtmlTags(text))
  const raw = input.content.trim()
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8)
    return stripLatexResidue(stripHtmlTags(raw))
  if (text) return stripLatexResidue(stripHtmlTags(text))
  const note = input.faces.fig?.note?.trim() ?? ''
  return stripLatexResidue(
    stripHtmlTags(
      note
        .replace(/请依据可见版面回答[^。]*。?/g, '')
        .replace(/勿编造未提供的文字[^。]*。?/g, '')
        .replace(/无文字层\/未OCR[^。]*。?/g, '')
        .trim(),
    ),
  )
}

export function tokenizeQuery(text: string): string[] {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!norm) return []
  const out: string[] = []
  const latin = norm.match(/[a-z0-9]{2,}/g)
  if (latin) out.push(...latin)
  const cjk = norm.replace(/[a-z0-9\s.,;:!?'"()[\]{}<>/\\|_+=\-@#$%^&*`~]+/g, '')
  for (let i = 0; i < cjk.length; i++) {
    out.push(cjk[i]!)
    if (i + 1 < cjk.length) out.push(cjk.slice(i, i + 2))
  }
  return out
}

export function isRetrievableAtom(input: {
  kind: string
  content: string
  faces: {
    text?: { content: string }
    fig?: { note: string }
  }
}): boolean {
  const t = atomSearchText(input)
  if (t.length < 4) return false
  if (input.kind === 'fig' && t.length < 24 && !input.faces.text) return false
  // 无 OCR 文字层的 fig 占位说明（图脸模板：书名 + (Z-Library) + 页码 +
  // "无文字层/未OCR..."）本身超过24字符阈值，会被误判为正文，导致
  // "Z-Library"、"p.39"、"Library" 等书源元数据被当成名词抽取出来。
  // 这类占位说明没有真实版面内容，直接排除。
  if (input.kind === 'fig' && !input.faces.text) {
    const rawNote = input.faces.fig?.note ?? ''
    if (/无文字层|未OCR/.test(rawNote)) return false
  }
  return true
}

export function chunkT(chunk: AChunk): string {
  return atomSearchText(chunk)
}

export function orderedRetrievableBookKeys(
  bookIndex: { chunks: AChunk[] },
): string[] {
  return [...bookIndex.chunks]
    .filter((c) => isRetrievableAtom(c))
    .sort((a, b) => a.page - b.page || a.ord - b.ord)
    .map((c) => c.key)
}
