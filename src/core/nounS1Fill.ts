/**
 * 名词表 s1（补缺）：LLM递归提取截断中的遗漏名词
 * 职责：
 * 1. 对每个截断调用LLM提取名词
 * 2. 递归处理：如果LLM返回的名词在截断中有遗漏，继续拆分
 * 3. 记录全局偏移量（相对于原纯文表）
 */

import type { PureTextTable } from './pureTextTable.ts'
import type { NounS0Table, Truncation } from './nounS0New.ts'
import { normalizeNounSurface } from './bookNounIndex.ts'
import { runBatchesParallel } from './parallelLlmBatch.ts'

export type NounS1Entry = {
  /** 标准化ID */
  id: string
  /** 展示形式（LLM提取的原文） */
  surface: string
  /** 来源截断ID */
  sourceTruncId: string
  /** 在纯文表中的全局偏移 */
  offsets: Array<{ start: number; end: number }>
}

export type NounS1Table = {
  entries: NounS1Entry[]
  byId: Map<string, NounS1Entry>
  note: string
}

/**
 * LLM调用接口：提取截断中的名词
 */
export type LLMExtractor = (truncText: string) => Promise<string[]>

/**
 * 递归提取：处理单个截断
 */
async function extractFromTruncationRecursive(
  truncation: Truncation,
  pureTextTable: PureTextTable,
  s0Table: NounS0Table,
  llm: LLMExtractor,
  signal: AbortSignal,
  maxDepth = 3,
  currentDepth = 0,
): Promise<NounS1Entry[]> {
  if (signal.aborted || currentDepth >= maxDepth) return []

  // 1. 调用LLM提取名词
  const extractedSurfaces = await llm(truncation.text)
  if (extractedSurfaces.length === 0) return []

  const entries: NounS1Entry[] = []
  const fullText = pureTextTable.fullText
  const fullTextLower = fullText.toLowerCase()

  // 2. 定位每个名词的全局偏移量
  for (const surface of extractedSurfaces) {
    const id = normalizeNounSurface(surface)
    if (id.length < 2) continue

    // 跳过 s0 已有的名词
    if (s0Table.byId.has(id)) continue

    const needle = surface.toLowerCase()
    const offsets: Array<{ start: number; end: number }> = []

    // 在截断范围内搜索偏移
    const truncStart = truncation.startOffset
    const truncEnd = truncation.endOffset
    const truncText = fullText.slice(truncStart, truncEnd)
    const truncTextLower = truncText.toLowerCase()

    let from = 0
    while (from < truncTextLower.length) {
      const at = truncTextLower.indexOf(needle, from)
      if (at < 0) break

      const globalStart = truncStart + at
      const globalEnd = globalStart + needle.length

      offsets.push({ start: globalStart, end: globalEnd })
      from = at + needle.length
    }

    if (offsets.length === 0) continue

    entries.push({
      id,
      surface,
      sourceTruncId: truncation.truncId,
      offsets,
    })
  }

  // 3. 递归处理：构建子截断
  if (currentDepth < maxDepth - 1 && entries.length > 0) {
    // 按偏移排序
    const sortedEntries = [...entries].sort((a, b) => a.offsets[0]!.start - b.offsets[0]!.start)

    const subTruncations: Truncation[] = []
    const MIN_SUB_TRUNC_LEN = 10

    // 子截断：相邻s1名词之间的间隙
    for (let i = 0; i < sortedEntries.length - 1; i++) {
      const left = sortedEntries[i]!
      const right = sortedEntries[i + 1]!

      const leftEnd = left.offsets[left.offsets.length - 1]!.end
      const rightStart = right.offsets[0]!.start

      if (rightStart > leftEnd + MIN_SUB_TRUNC_LEN) {
        const text = fullText.slice(leftEnd, rightStart).trim()
        if (text.length >= MIN_SUB_TRUNC_LEN) {
          subTruncations.push({
            truncId: `${truncation.truncId}_sub_${i}`,
            leftMask: left.id,
            rightMask: right.id,
            startOffset: leftEnd,
            endOffset: rightStart,
            text,
          })
        }
      }
    }

    // 递归处理子截断
    for (const subTrunc of subTruncations) {
      if (signal.aborted) break
      const subEntries = await extractFromTruncationRecursive(
        subTrunc,
        pureTextTable,
        s0Table,
        llm,
        signal,
        maxDepth,
        currentDepth + 1,
      )
      entries.push(...subEntries)
    }
  }

  return entries
}

/**
 * 从所有截断构建 s1 补缺名词表（并行批处理）
 */
export async function buildNounS1Table(
  pureTextTable: PureTextTable,
  s0Table: NounS0Table,
  truncations: Truncation[],
  llm: LLMExtractor,
  options: {
    concurrency?: number
    signal?: AbortSignal
  } = {},
): Promise<NounS1Table> {
  const { concurrency = 3, signal } = options

  if (truncations.length === 0) {
    return {
      entries: [],
      byId: new Map(),
      note: 's1 补缺表 · 无截断',
    }
  }

  // 并行处理截断
  const result = await runBatchesParallel({
    batches: truncations,
    concurrency,
    signal,
    run: async (truncation, _, sig) => {
      return await extractFromTruncationRecursive(
        truncation,
        pureTextTable,
        s0Table,
        llm,
        sig,
      )
    },
  })

  // 合并结果
  const allEntries: NounS1Entry[] = []
  for (const r of result.results) {
    if (r.ok) {
      allEntries.push(...r.value)
    }
  }

  // 去重：同一 id 合并 offsets
  const map = new Map<string, NounS1Entry>()
  for (const entry of allEntries) {
    if (!map.has(entry.id)) {
      map.set(entry.id, entry)
    } else {
      const existing = map.get(entry.id)!
      existing.offsets.push(...entry.offsets)
    }
  }

  // 去重 offsets
  for (const entry of map.values()) {
    const unique = new Map<string, { start: number; end: number }>()
    for (const offset of entry.offsets) {
      const key = `${offset.start}-${offset.end}`
      unique.set(key, offset)
    }
    entry.offsets = [...unique.values()].sort((a, b) => a.start - b.start)
  }

  const entries = [...map.values()].sort((a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id))

  return {
    entries,
    byId: map,
    note: `s1 补缺表 · 词×${entries.length} · 总命中×${entries.reduce((s, e) => s + e.offsets.length, 0)} · ${result.note}`,
  }
}
