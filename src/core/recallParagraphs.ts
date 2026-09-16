/**
 * 段落召回模块（新版）：基于终词表 + 拓扑链召回原文
 * 流程：
 * 1. 从查询提取名词 → 在终词表中匹配
 * 2. 拿到匹配名词的拓扑链
 * 3. LLM 筛选保留链（decide）
 * 4. 用链首尾偏移量召回纯文表原文
 */

import type { PureTextTable } from './pureTextTable.ts'
import type { FinalNounTable } from './nounMerge.ts'
import type { TopologyChainTable } from './topologyChain.ts'
import { extractNounSurfacesFromText, normalizeNounSurface } from './bookNounIndex.ts'

export type RecalledSnippet = {
  /** 链中心词 ID */
  centerId: string
  centerSurface: string
  /** 5 词链表面形式 */
  chainSurfaces: string[]
  /** 在纯文表中的召回原文 */
  text: string
  /** 起始偏移量 */
  startOffset: number
  /** 结束偏移量 */
  endOffset: number
  /** 相关性评分（LLM 给出，或用命中词数估算） */
  score: number
}

export type RecallResult = {
  query: string
  queryNounIds: string[]
  matchedNounIds: string[]
  snippets: RecalledSnippet[]
  note: string
}

/** LLM 决定链是否相关的接口 */
export type ChainDecider = (chains: TopologyChainTable, query: string) => Promise<Set<string>>

/**
 * 从纯文表按偏移量范围召回原文
 */
export function recallByOffsets(
  pureTextTable: PureTextTable,
  startOffset: number,
  endOffset: number,
  paddingChars: number = 20,
): string {
  const start = Math.max(0, startOffset - paddingChars)
  const end = Math.min(pureTextTable.fullText.length, endOffset + paddingChars)
  let text = pureTextTable.fullText.slice(start, end)
  if (start > 0) text = '…' + text
  if (end < pureTextTable.fullText.length) text = text + '…'
  return text
}

/**
 * 基础召回（无 LLM）：查询名词直接匹配拓扑链
 */
export async function recallByChains(
  query: string,
  pureTextTable: PureTextTable,
  finalNounTable: FinalNounTable,
  chainTable: TopologyChainTable,
  options: {
    topK?: number
    chainDecider?: ChainDecider
    signal?: AbortSignal
  } = {},
): RecallResult {
  const topK = options.topK ?? 10

  // 1. 从查询提取名词 ID
  const querySurfaces = extractNounSurfacesFromText(query)
  const queryNounIds = new Set(
    querySurfaces.map((s) => normalizeNounSurface(s)),
  )

  if (queryNounIds.size === 0) {
    return {
      query,
      queryNounIds: [],
      matchedNounIds: [],
      snippets: [],
      note: '查询中未提取到名词',
    }
  }

  // 2. 在终词表中找到匹配的名词
  const matchedNounIds: string[] = []
  for (const id of queryNounIds) {
    if (finalNounTable.byId.has(id)) {
      matchedNounIds.push(id)
    }
  }

  if (matchedNounIds.length === 0) {
    return {
      query,
      queryNounIds: [...queryNounIds],
      matchedNounIds: [],
      snippets: [],
      note: `查询提取 ${queryNounIds.size} 个名词，但无任何一词命中终词表（|S0|=${finalNounTable.entries.length}）`,
    }
  }

  // 3. 收集所有相关拓扑链（以匹配名词为中心）
  const chainMap = chainTable.byCenterId
  const relevantChainIds = new Set<string>()
  const chainSnippetMap = new Map<string, RecalledSnippet>()

  for (const centerId of matchedNounIds) {
    const chains = chainMap.get(centerId)
    if (!chains) continue
    for (const chain of chains) {
      relevantChainIds.add(chain.id)
      if (!chainSnippetMap.has(chain.id)) {
        const text = recallByOffsets(pureTextTable, chain.startOffset, chain.endOffset)
        chainSnippetMap.set(chain.id, {
          centerId: chain.centerId,
          centerSurface: chain.centerSurface,
          chainSurfaces: chain.chain.map((n) => n.surface),
          text,
          startOffset: chain.startOffset,
          endOffset: chain.endOffset,
          score: 0,
        })
      }
    }
  }

  // 4. 可选：LLM 筛选链
  let filteredChainIds = relevantChainIds
  if (options.chainDecider) {
    const kept = await options.chainDecider(chainTable, query)
    filteredChainIds = new Set([...relevantChainIds].filter((id) => kept.has(id)))
  }

  // 5. 组装结果
  const snippets: RecalledSnippet[] = []
  let score = matchedNounIds.length
  for (const id of filteredChainIds) {
    const snippet = chainSnippetMap.get(id)
    if (snippet) {
      snippets.push({ ...snippet, score })
    }
  }

  // 按 score 降序，取 topK
  snippets.sort((a, b) => b.score - a.score)
  const top = snippets.slice(0, topK)

  return {
    query,
    queryNounIds: [...queryNounIds],
    matchedNounIds,
    snippets: top,
    note: `查询含 ${queryNounIds.size} 个名词，命中 ${matchedNounIds.length} 个，召回到 ${top.length} 条链`,
  }
}

/**
 * 格式化召回结果为可读文本
 */
export function formatRecallResult(result: RecallResult): string {
  const lines: string[] = []
  lines.push(`【查询】${result.query}`)
  lines.push(`查询名词：${[...result.queryNounIds].join(' · ')}`)
  lines.push(`命中名词：${result.matchedNounIds.join(' · ')}`)
  lines.push(result.note)
  lines.push('')

  if (result.snippets.length === 0) {
    lines.push('无召回结果')
    return lines.join('\n')
  }

  for (let i = 0; i < result.snippets.length; i++) {
    const s = result.snippets[i]
    lines.push(`## [${i + 1}] ${s.centerSurface} · offset ${s.startOffset}–${s.endOffset}`)
    lines.push(`链：${s.chainSurfaces.join(' · ')}`)
    lines.push(`原文：${s.text}`)
    lines.push('')
  }

  return lines.join('\n')
}
