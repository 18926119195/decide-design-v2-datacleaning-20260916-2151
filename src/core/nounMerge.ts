/**
 * 名词表合并审查：检查相邻且偏移连续的名词是否应合并为复合名词
 * 职责：
 * 1. 合并 s0 + s1 → 初步终词表
 * 2. 检测相邻名词（偏移量前后紧邻，容差±3字符）
 * 3. 调用LLM判断是否应合并为复合名词
 * 4. 生成最终终词表
 */

import type { PureTextTable } from './pureTextTable.ts'
import type { NounS0Entry, NounS0Table } from './nounS0New.ts'
import type { NounS1Entry, NounS1Table } from './nounS1Fill.ts'
import { normalizeNounSurface } from './bookNounIndex.ts'
import { runBatchesParallel } from './parallelLlmBatch.ts'

export type FinalNounEntry = {
  /** 标准化ID */
  id: string
  /** 展示形式 */
  surface: string
  /** 来源：'s0' | 's1' | 'merged' */
  source: 's0' | 's1' | 'merged'
  /** 全局偏移量 */
  offsets: Array<{ start: number; end: number }>
  /** 如果是合并词，记录原子词ID */
  mergedFrom?: string[]
}

export type FinalNounTable = {
  entries: FinalNounEntry[]
  byId: Map<string, FinalNounEntry>
  note: string
}

/**
 * LLM合并判断接口：判断两个相邻名词是否应合并
 * 返回：合并后的表面形式，或 null（不合并）
 */
export type MergeReviewer = (
  leftSurface: string,
  rightSurface: string,
  context: string,
) => Promise<string | null>

/**
 * 候选合并对：相邻且偏移连续的名词对
 */
type MergeCandidate = {
  leftId: string
  rightId: string
  leftSurface: string
  rightSurface: string
  /** 共现位置：左词结束 + 右词开始的偏移对 */
  cooccurrences: Array<{
    leftEnd: number
    rightStart: number
    gap: number
  }>
  /** 用于LLM判断的上下文（取第一个共现） */
  context: string
}

const ADJACENCY_TOLERANCE = 3 // 相邻容差（字符数）
const CONTEXT_WINDOW = 50 // 上下文窗口（左右各50字符）

/**
 * 检测候选合并对
 */
function detectMergeCandidates(
  pureTextTable: PureTextTable,
  mergedEntries: Map<string, FinalNounEntry>,
): MergeCandidate[] {
  const candidates: MergeCandidate[] = []
  const fullText = pureTextTable.fullText

  // 1. 构建偏移量索引：每个偏移点的名词ID
  const offsetIndex = new Map<number, string[]>()
  for (const entry of mergedEntries.values()) {
    for (const offset of entry.offsets) {
      // 记录词的开始位置
      if (!offsetIndex.has(offset.start)) {
        offsetIndex.set(offset.start, [])
      }
      offsetIndex.get(offset.start)!.push(entry.id)
    }
  }

  // 2. 枚举所有名词对，检测相邻共现
  const checked = new Set<string>()
  for (const leftEntry of mergedEntries.values()) {
    for (const leftOffset of leftEntry.offsets) {
      // 在左词结束位置附近寻找右词开始
      for (let gap = -ADJACENCY_TOLERANCE; gap <= ADJACENCY_TOLERANCE; gap++) {
        const rightStart = leftOffset.end + gap
        const rightIds = offsetIndex.get(rightStart) || []

        for (const rightId of rightIds) {
          if (rightId === leftEntry.id) continue

          const pairKey = `${leftEntry.id}|${rightId}`
          if (checked.has(pairKey)) continue
          checked.add(pairKey)

          const rightEntry = mergedEntries.get(rightId)!
          const cooccurrences: Array<{
            leftEnd: number
            rightStart: number
            gap: number
          }> = []

          // 收集所有共现位置
          for (const lo of leftEntry.offsets) {
            for (const ro of rightEntry.offsets) {
              const g = ro.start - lo.end
              if (Math.abs(g) <= ADJACENCY_TOLERANCE) {
                cooccurrences.push({
                  leftEnd: lo.end,
                  rightStart: ro.start,
                  gap: g,
                })
              }
            }
          }

          if (cooccurrences.length === 0) continue

          // 取第一个共现作为上下文
          const first = cooccurrences[0]!
          const contextStart = Math.max(0, first.leftEnd - CONTEXT_WINDOW)
          const contextEnd = Math.min(
            fullText.length,
            first.rightStart + rightEntry.surface.length + CONTEXT_WINDOW,
          )
          const context = fullText.slice(contextStart, contextEnd)

          candidates.push({
            leftId: leftEntry.id,
            rightId,
            leftSurface: leftEntry.surface,
            rightSurface: rightEntry.surface,
            cooccurrences,
            context,
          })
        }
      }
    }
  }

  // 按共现频率排序（高频优先）
  candidates.sort((a, b) => b.cooccurrences.length - a.cooccurrences.length)

  return candidates
}

/**
 * 构建最终名词表（带合并审查）
 */
export async function buildFinalNounTable(
  pureTextTable: PureTextTable,
  s0Table: NounS0Table,
  s1Table: NounS1Table,
  mergeReviewer: MergeReviewer,
  options: {
    concurrency?: number
    signal?: AbortSignal
    /** 是否跳过合并审查（调试用） */
    skipMerge?: boolean
  } = {},
): Promise<FinalNounTable> {
  const { concurrency = 3, signal, skipMerge = false } = options

  // 1. 合并 s0 + s1 → 初步终词表
  const merged = new Map<string, FinalNounEntry>()

  for (const s0Entry of s0Table.entries) {
    merged.set(s0Entry.id, {
      id: s0Entry.id,
      surface: s0Entry.surface,
      source: 's0',
      offsets: [...s0Entry.offsets],
    })
  }

  for (const s1Entry of s1Table.entries) {
    if (!merged.has(s1Entry.id)) {
      merged.set(s1Entry.id, {
        id: s1Entry.id,
        surface: s1Entry.surface,
        source: 's1',
        offsets: [...s1Entry.offsets],
      })
    } else {
      // s0 已有，合并 offsets
      const existing = merged.get(s1Entry.id)!
      existing.offsets.push(...s1Entry.offsets)
      // 去重
      const unique = new Map<string, { start: number; end: number }>()
      for (const offset of existing.offsets) {
        const key = `${offset.start}-${offset.end}`
        unique.set(key, offset)
      }
      existing.offsets = [...unique.values()].sort((a, b) => a.start - b.start)
    }
  }

  if (skipMerge) {
    const entries = [...merged.values()].sort(
      (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
    )
    return {
      entries,
      byId: merged,
      note: `终词表 · 词×${entries.length} · 跳过合并审查`,
    }
  }

  // 2. 检测候选合并对
  const candidates = detectMergeCandidates(pureTextTable, merged)

  if (candidates.length === 0) {
    const entries = [...merged.values()].sort(
      (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
    )
    return {
      entries,
      byId: merged,
      note: `终词表 · 词×${entries.length} · 无合并候选`,
    }
  }

  // 3. 并行调用LLM判断合并
  const result = await runBatchesParallel({
    batches: candidates,
    concurrency,
    signal,
    run: async (candidate, _, sig) => {
      if (sig.aborted) return null
      const mergedSurface = await mergeReviewer(
        candidate.leftSurface,
        candidate.rightSurface,
        candidate.context,
      )
      return mergedSurface ? { candidate, mergedSurface } : null
    },
  })

  // 4. 应用合并决策
  let mergeCount = 0
  for (const r of result.results) {
    if (!r.ok || !r.value) continue
    const { candidate, mergedSurface } = r.value

    const leftEntry = merged.get(candidate.leftId)
    const rightEntry = merged.get(candidate.rightId)
    if (!leftEntry || !rightEntry) continue

    // 构建合并词条
    const mergedId = normalizeNounSurface(mergedSurface)
    const mergedOffsets: Array<{ start: number; end: number }> = []

    // 定位合并词的偏移（基于共现位置）
    for (const cooc of candidate.cooccurrences) {
      const leftOffset = leftEntry.offsets.find((o) => o.end === cooc.leftEnd)
      if (!leftOffset) continue

      const rightOffset = rightEntry.offsets.find((o) => o.start === cooc.rightStart)
      if (!rightOffset) continue

      mergedOffsets.push({
        start: leftOffset.start,
        end: rightOffset.end,
      })
    }

    if (mergedOffsets.length === 0) continue

    merged.set(mergedId, {
      id: mergedId,
      surface: mergedSurface,
      source: 'merged',
      offsets: mergedOffsets,
      mergedFrom: [candidate.leftId, candidate.rightId],
    })

    // 从原子词中移除已合并的偏移
    for (const offset of mergedOffsets) {
      leftEntry.offsets = leftEntry.offsets.filter(
        (o) => !(o.start >= offset.start && o.end <= offset.end),
      )
      rightEntry.offsets = rightEntry.offsets.filter(
        (o) => !(o.start >= offset.start && o.end <= offset.end),
      )
    }

    mergeCount++
  }

  // 5. 清理空词条（所有偏移都被合并的词）
  for (const [id, entry] of merged) {
    if (entry.offsets.length === 0) {
      merged.delete(id)
    }
  }

  const entries = [...merged.values()].sort(
    (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
  )

  return {
    entries,
    byId: merged,
    note: `终词表 · 词×${entries.length} · 合并×${mergeCount} · ${result.note}`,
  }
}
