/**
 * 纯文表：将书籍 chunks 转为纯文本 + 段落索引
 * 职责：
 * 1. 构建全局纯文本（fullText）及全局偏移量系统
 * 2. 切分段落，记录每个段落的全局偏移量范围
 * 3. 段落与 chunk/page 的映射关系
 */

import type { BookIndex } from './types.ts'
import { atomSearchText, isRetrievableAtom } from './text.ts'

export type PureTextParagraph = {
  /** 段落索引 */
  index: number
  /** 段落文本 */
  text: string
  /** 段落在 fullText 中的起始偏移 */
  startOffset: number
  /** 段落在 fullText 中的结束偏移 */
  endOffset: number
  /** 来源 chunk keys */
  chunkKeys: string[]
  /** 页码 */
  page: number
}

export type PureTextTable = {
  /** 全文拼接（所有 chunks 的纯文本，中间用换行连接） */
  fullText: string
  /** 段落列表（按全局偏移排序） */
  paragraphs: PureTextParagraph[]
  /** chunk -> offset 映射（可选，用于反查） */
  chunkOffsets: Map<string, { start: number; end: number }>
  note: string
}

type ChunkTextEntry = {
  chunkKey: string
  page: number
  text: string
  /** 该 chunk 在 fullText 中的起始偏移 */
  startOffset: number
  /** 该 chunk 在 fullText 中的结束偏移 */
  endOffset: number
}

/**
 * 从 bookIndex 构建纯文表
 */
export function buildPureTextTable(bookIndex: BookIndex): PureTextTable {
  // 1. 提取所有可检索 chunks 的文本，记录偏移
  const entries: ChunkTextEntry[] = []
  let offset = 0

  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue
    const text = atomSearchText(chunk).trim()
    if (!text) continue

    const startOffset = offset
    const endOffset = offset + text.length

    entries.push({
      chunkKey: chunk.key,
      page: chunk.page,
      text,
      startOffset,
      endOffset,
    })

    offset = endOffset + 1 // +1 for newline separator
  }

  // 2. 拼接全文
  const fullText = entries.map((e) => e.text).join('\n')

  // 3. 构建 chunk -> offset 映射
  const chunkOffsets = new Map(
    entries.map((e) => [e.chunkKey, { start: e.startOffset, end: e.endOffset }]),
  )

  // 4. 段落切分：双换行分段 + 长度限制
  const paragraphs = splitIntoParagraphs(entries, fullText)

  return {
    fullText,
    paragraphs,
    chunkOffsets,
    note: `纯文表 · 全文${fullText.length}字 · 段×${paragraphs.length} · chunks×${entries.length}`,
  }
}

/**
 * 段落切分逻辑：
 * 1. 按双换行分段（自然段）
 * 2. 过长段落二次切分（按句号、问号、感叹号）
 * 3. 过短段落合并（避免碎片）
 */
function splitIntoParagraphs(
  entries: ChunkTextEntry[],
  fullText: string,
): PureTextParagraph[] {
  const MIN_PARA_LEN = 80 // 最小段落长度
  const MAX_PARA_LEN = 600 // 最大段落长度
  const MIN_MERGE_LEN = 40 // 合并阈值

  const paragraphs: PureTextParagraph[] = []

  // 遍历每个 chunk，在 chunk 内部分段
  for (const entry of entries) {
    const chunkText = entry.text
    
    // 按双换行分段
    const rawParas = chunkText.split(/\n\n+/)
    
    // 处理每个自然段
    const blocks: Array<{ text: string; start: number; end: number }> = []
    let localOffset = 0
    
    for (const rawPara of rawParas) {
      const trimmed = rawPara.trim()
      if (!trimmed) {
        localOffset += rawPara.length
        continue
      }
      
      // 找到原文中的起始位置
      const startInChunk = chunkText.indexOf(trimmed, localOffset)
      if (startInChunk < 0) {
        localOffset += rawPara.length
        continue
      }
      
      const endInChunk = startInChunk + trimmed.length
      
      // 如果段落过长，按句子切分
      if (trimmed.length > MAX_PARA_LEN) {
        const sentences = trimmed.split(/([。！？.!?]+)/)
        let sentOffset = 0
        let accumText = ''
        let accumStart = startInChunk
        
        for (let i = 0; i < sentences.length; i++) {
          const sent = sentences[i]!
          accumText += sent
          
          if (sent.match(/[。！？.!?]+/) || i === sentences.length - 1) {
            if (accumText.trim().length >= MIN_PARA_LEN) {
              blocks.push({
                text: accumText.trim(),
                start: accumStart,
                end: accumStart + accumText.length,
              })
              sentOffset += accumText.length
              accumStart = startInChunk + sentOffset
              accumText = ''
            }
          }
        }
        
        // 剩余部分
        if (accumText.trim().length >= MIN_PARA_LEN) {
          blocks.push({
            text: accumText.trim(),
            start: accumStart,
            end: accumStart + accumText.length,
          })
        }
      } else {
        blocks.push({
          text: trimmed,
          start: startInChunk,
          end: endInChunk,
        })
      }
      
      localOffset = endInChunk
    }

    // 合并过短的 blocks
    let pending: { text: string; start: number; end: number } | null = null
    for (const block of blocks) {
      if (!pending) {
        pending = { ...block }
        continue
      }
      if (pending.text.length < MIN_MERGE_LEN) {
        // 合并 pending 和 block（要求相邻，用原文重建间隔文本）
        const gap = chunkText.slice(pending.end, block.start)
        pending = {
          text: pending.text + gap + block.text,
          start: pending.start,
          end: block.end,
        }
      } else {
        if (pending.text.length >= MIN_PARA_LEN) {
          paragraphs.push({
            index: paragraphs.length,
            text: pending.text,
            startOffset: entry.startOffset + pending.start,
            endOffset: entry.startOffset + pending.end,
            chunkKeys: [entry.chunkKey],
            page: entry.page,
          })
        }
        pending = { ...block }
      }
    }
    if (pending && pending.text.length >= MIN_PARA_LEN) {
      paragraphs.push({
        index: paragraphs.length,
        text: pending.text,
        startOffset: entry.startOffset + pending.start,
        endOffset: entry.startOffset + pending.end,
        chunkKeys: [entry.chunkKey],
        page: entry.page,
      })
    }
  }

  // reindex（因为合并/跳过可能打乱顺序号，实际上是按序 push 的，这里只是保险重编号）
  return paragraphs.map((p, i) => ({ ...p, index: i }))
}

/**
 * 从全局偏移获取文本片段
 */
export function getTextSlice(
  pureTextTable: PureTextTable,
  start: number,
  end: number,
): string {
  return pureTextTable.fullText.slice(start, end)
}

/**
 * 根据全局偏移查找所属段落
 */
export function findParagraphByOffset(
  pureTextTable: PureTextTable,
  offset: number,
): PureTextParagraph | null {
  for (const para of pureTextTable.paragraphs) {
    if (offset >= para.startOffset && offset < para.endOffset) {
      return para
    }
  }
  return null
}
