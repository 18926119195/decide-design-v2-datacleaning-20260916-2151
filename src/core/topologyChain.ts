/**
 * 拓扑链构建：基于终词表中相邻名词构建5词链
 * 职责：
 * 1. 从终词表中找到相邻名词（±2窗口）
 * 2. 构建5词链：[n-2, n-1, n0, n+1, n+2]
 * 3. 去重并提供查询接口
 */

import type { PureTextTable } from './pureTextTable.ts'
import type { FinalNounEntry, FinalNounTable } from './nounMerge.ts'

export type TopologyChain = {
  /** 中心词ID */
  centerId: string
  /** 中心词表面形式 */
  centerSurface: string
  /** 5词链：[n-2, n-1, n0, n+1, n+2] */
  chain: Array<{
    id: string
    surface: string
    /** 相对中心词的偏移（-2, -1, 0, +1, +2） */
    relativePos: number
  }>
  /** 该链的原文片段（用于召回上下文） */
  snippet: string
  /** 该链在纯文表中的起始偏移 */
  startOffset: number
  /** 该链在纯文表中的结束偏移 */
  endOffset: number
}

export type TopologyChainTable = {
  /** 所有拓扑链 */
  chains: TopologyChain[]
  /** 按中心词ID索引 */
  byCenterId: Map<string, TopologyChain[]>
  note: string
}

const NEIGHBOR_WINDOW = 2 // ±2窗口
const SNIPPET_CONTEXT = 30 // 片段上下文（左右各30字符）

/**
 * 构建拓扑链表
 */
export function buildTopologyChainTable(
  pureTextTable: PureTextTable,
  finalNounTable: FinalNounTable,
): TopologyChainTable {
  const fullText = pureTextTable.fullText
  const chains: TopologyChain[] = []

  // 1. 构建全局偏移量索引：每个偏移点的名词列表
  type OffsetPoint = {
    offset: number
    type: 'start' | 'end'
    entry: FinalNounEntry
  }

  const allPoints: OffsetPoint[] = []
  for (const entry of finalNounTable.entries) {
    for (const offset of entry.offsets) {
      allPoints.push({ offset: offset.start, type: 'start', entry })
      allPoints.push({ offset: offset.end, type: 'end', entry })
    }
  }

  // 按偏移量排序
  allPoints.sort((a, b) => a.offset - b.offset || (a.type === 'start' ? -1 : 1))

  // 2. 构建线性名词序列：按出现顺序排列的名词
  type LinearNoun = {
    entry: FinalNounEntry
    start: number
    end: number
    /** 在序列中的索引 */
    seqIndex: number
  }

  const linearSequence: LinearNoun[] = []
  const activeNouns = new Set<FinalNounEntry>()

  let seqIndex = 0
  for (const point of allPoints) {
    if (point.type === 'start') {
      activeNouns.add(point.entry)
      linearSequence.push({
        entry: point.entry,
        start: point.offset,
        end: point.entry.offsets.find((o) => o.start === point.offset)!.end,
        seqIndex: seqIndex++,
      })
    } else {
      activeNouns.delete(point.entry)
    }
  }

  // 3. 为每个名词构建5词链
  for (let i = 0; i < linearSequence.length; i++) {
    const center = linearSequence[i]!
    const chain: TopologyChain['chain'] = []

    // 收集 ±2 窗口内的名词
    for (let offset = -NEIGHBOR_WINDOW; offset <= NEIGHBOR_WINDOW; offset++) {
      const neighborIndex = i + offset
      if (neighborIndex < 0 || neighborIndex >= linearSequence.length) {
        continue
      }

      const neighbor = linearSequence[neighborIndex]!
      chain.push({
        id: neighbor.entry.id,
        surface: neighbor.entry.surface,
        relativePos: offset,
      })
    }

    // 如果链少于3个词，跳过（太短没意义）
    if (chain.length < 3) continue

    // 构建snippet：从链的最左到最右的原文片段
    const leftmost = chain[0]!
    const rightmost = chain[chain.length - 1]!

    const leftmostNoun = linearSequence.find((n) => n.entry.id === leftmost.id)!
    const rightmostNoun = linearSequence.find((n) => n.entry.id === rightmost.id)!

    const snippetStart = Math.max(0, leftmostNoun.start - SNIPPET_CONTEXT)
    const snippetEnd = Math.min(fullText.length, rightmostNoun.end + SNIPPET_CONTEXT)
    const snippet = fullText.slice(snippetStart, snippetEnd)

    chains.push({
      centerId: center.entry.id,
      centerSurface: center.entry.surface,
      chain,
      snippet,
      startOffset: leftmostNoun.start,
      endOffset: rightmostNoun.end,
    })
  }

  // 4. 去重：相同中心词 + 相同链ID组合 → 只保留一个
  const uniqueChains = new Map<string, TopologyChain>()
  for (const chain of chains) {
    const chainKey = chain.chain.map((n) => n.id).join('|')
    const key = `${chain.centerId}::${chainKey}`
    if (!uniqueChains.has(key)) {
      uniqueChains.set(key, chain)
    }
  }

  const finalChains = [...uniqueChains.values()]

  // 5. 按中心词ID索引
  const byCenterId = new Map<string, TopologyChain[]>()
  for (const chain of finalChains) {
    if (!byCenterId.has(chain.centerId)) {
      byCenterId.set(chain.centerId, [])
    }
    byCenterId.get(chain.centerId)!.push(chain)
  }

  return {
    chains: finalChains,
    byCenterId,
    note: `拓扑链 · 链×${finalChains.length} · 覆盖词×${byCenterId.size}`,
  }
}

/**
 * 查询接口：给定名词ID，返回其所有拓扑链
 */
export function getTopologyChainsForNoun(
  table: TopologyChainTable,
  nounId: string,
): TopologyChain[] {
  return table.byCenterId.get(nounId) || []
}

/**
 * 查询接口：给定名词ID列表，返回所有相关拓扑链（去重）
 */
export function getTopologyChainsForNouns(
  table: TopologyChainTable,
  nounIds: string[],
): TopologyChain[] {
  const seen = new Set<string>()
  const result: TopologyChain[] = []

  for (const nounId of nounIds) {
    const chains = getTopologyChainsForNoun(table, nounId)
    for (const chain of chains) {
      const chainKey = chain.chain.map((n) => n.id).join('|')
      const key = `${chain.centerId}::${chainKey}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push(chain)
      }
    }
  }

  return result
}
