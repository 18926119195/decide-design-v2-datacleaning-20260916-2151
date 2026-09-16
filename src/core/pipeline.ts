/**
 * 主流程编排：从纯文表 → 终词表 → 拓扑链 → 召回
 * 整合所有模块：s0规则 → s1补缺 → 合并 → 去重 → 相关性 → 拓扑链
 */

import type { PureTextTable } from './pureTextTable.ts'
import {
  buildNounS0Table,
  buildTruncations,
  type NounS0Table,
  type Truncation,
} from './nounS0New.ts'
import {
  buildNounS1Table,
  type NounS1Table,
  type LLMExtractor,
} from './nounS1Fill.ts'
import {
  buildFinalNounTable,
  type FinalNounTable,
  type MergeReviewer,
} from './nounMerge.ts'
import {
  buildTopologyChainTable,
  getTopologyChainsForNouns,
  type TopologyChainTable,
  type TopologyChain,
} from './topologyChain.ts'

/**
 * 完整流程配置
 */
export type PipelineConfig = {
  /** s1 补缺LLM */
  llmExtractor: LLMExtractor
  /** 合并审查LLM */
  mergeReviewer: MergeReviewer
  /** 并发数 */
  concurrency?: number
  /** 中止信号 */
  signal?: AbortSignal
  /** 是否跳过s1补缺（调试用） */
  skipS1?: boolean
  /** 是否跳过合并审查（调试用） */
  skipMerge?: boolean
}

/**
 * 流程结果
 */
export type PipelineResult = {
  /** s0 规则名词表 */
  s0Table: NounS0Table
  /** s0 截断列表 */
  truncations: Truncation[]
  /** s1 补缺名词表 */
  s1Table: NounS1Table
  /** 最终名词表（合并后） */
  finalTable: FinalNounTable
  /** 拓扑链表 */
  topologyTable: TopologyChainTable
  /** 流程摘要 */
  summary: string
}

/**
 * 执行完整流程
 */
export async function runFullPipeline(
  pureTextTable: PureTextTable,
  config: PipelineConfig,
): Promise<PipelineResult> {
  const {
    llmExtractor,
    mergeReviewer,
    concurrency = 3,
    signal,
    skipS1 = false,
    skipMerge = false,
  } = config

  const steps: string[] = []

  // Step 1: 构建 s0 规则名词表
  const s0Table = buildNounS0Table(pureTextTable)
  steps.push(s0Table.note)

  // Step 2: 构建截断
  const truncations = buildTruncations(pureTextTable, s0Table)
  steps.push(`截断 · ${truncations.length}个间隙`)

  // Step 3: 构建 s1 补缺名词表
  let s1Table: NounS1Table
  if (skipS1) {
    s1Table = {
      entries: [],
      byId: new Map(),
      note: 's1 补缺表 · 跳过',
    }
    steps.push(s1Table.note)
  } else {
    s1Table = await buildNounS1Table(pureTextTable, s0Table, truncations, llmExtractor, {
      concurrency,
      signal,
    })
    steps.push(s1Table.note)
  }

  // Step 4: 构建最终名词表（带合并审查）
  const finalTable = await buildFinalNounTable(
    pureTextTable,
    s0Table,
    s1Table,
    mergeReviewer,
    {
      concurrency,
      signal,
      skipMerge,
    },
  )
  steps.push(finalTable.note)

  // Step 5: 构建拓扑链表
  const topologyTable = buildTopologyChainTable(pureTextTable, finalTable)
  steps.push(topologyTable.note)

  const summary = steps.join(' → ')

  return {
    s0Table,
    truncations,
    s1Table,
    finalTable,
    topologyTable,
    summary,
  }
}

/**
 * 召回接口：给定查询名词列表，返回相关拓扑链和片段
 */
export type RecallResult = {
  /** 匹配的拓扑链 */
  chains: TopologyChain[]
  /** 召回的文本片段（去重） */
  snippets: string[]
  /** 召回摘要 */
  note: string
}

/**
 * 执行召回
 */
export function recallByNouns(
  topologyTable: TopologyChainTable,
  finalTable: FinalNounTable,
  queryNounIds: string[],
): RecallResult {
  // 1. 过滤：只保留终词表中存在的名词
  const validIds = queryNounIds.filter((id) => finalTable.byId.has(id))

  if (validIds.length === 0) {
    return {
      chains: [],
      snippets: [],
      note: '召回 · 无匹配名词',
    }
  }

  // 2. 获取所有相关拓扑链
  const chains = getTopologyChainsForNouns(topologyTable, validIds)

  // 3. 提取snippet并去重
  const snippetSet = new Set<string>()
  for (const chain of chains) {
    snippetSet.add(chain.snippet)
  }
  const snippets = [...snippetSet]

  return {
    chains,
    snippets,
    note: `召回 · 链×${chains.length} · 片段×${snippets.length} · 查询词×${validIds.length}/${queryNounIds.length}`,
  }
}

/**
 * 调试接口：导出流程中间状态
 */
export function exportPipelineDebugInfo(result: PipelineResult): {
  s0Nouns: Array<{ id: string; surface: string; df: number }>
  s1Nouns: Array<{ id: string; surface: string; df: number }>
  finalNouns: Array<{
    id: string
    surface: string
    df: number
    source: string
    mergedFrom?: string[]
  }>
  truncations: Array<{
    truncId: string
    leftMask: string
    rightMask: string
    textPreview: string
  }>
  topologyChainSample: Array<{
    centerId: string
    centerSurface: string
    chainLength: number
    chainIds: string[]
  }>
} {
  return {
    s0Nouns: result.s0Table.entries.map((e) => ({
      id: e.id,
      surface: e.surface,
      df: e.df,
    })),
    s1Nouns: result.s1Table.entries.map((e) => ({
      id: e.id,
      surface: e.surface,
      df: e.offsets.length,
    })),
    finalNouns: result.finalTable.entries.map((e) => ({
      id: e.id,
      surface: e.surface,
      df: e.offsets.length,
      source: e.source,
      mergedFrom: e.mergedFrom,
    })),
    truncations: result.truncations.slice(0, 10).map((t) => ({
      truncId: t.truncId,
      leftMask: t.leftMask,
      rightMask: t.rightMask,
      textPreview: t.text.slice(0, 80) + (t.text.length > 80 ? '...' : ''),
    })),
    topologyChainSample: result.topologyTable.chains.slice(0, 20).map((c) => ({
      centerId: c.centerId,
      centerSurface: c.centerSurface,
      chainLength: c.chain.length,
      chainIds: c.chain.map((n) => n.id),
    })),
  }
}
