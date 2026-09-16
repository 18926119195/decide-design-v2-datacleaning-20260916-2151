/**
 * 测试脚本：使用 Guattari 语料运行【新管线】
 * 流程：纯文表 → s0 规则 → 截断 → s1 补缺LLM → 合并审查LLM → 终词表 → 拓扑链 → 召回
 *
 * 用法：
 *   $env:CORPUS_PATH = "C:\path\to\guattari.docuverse.json"
 *   node --experimental-strip-types scripts/test-new-pipeline.ts
 *
 * 可选环境变量：
 *   SKIP_LLM=1   跳过所有 LLM 调用（仅 s0 规则 + Mock 合并）
 *   SKIP_S1=1    跳过 s1 补缺LLM
 *   SKIP_MERGE=1 跳过合并审查LLM
 *   TOP_K=5      每个查询返回的段落数
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadCorpusPack } from '../src/harness/loadCorpus.ts'
import { buildPureTextTable } from '../src/core/pureTextTable.ts'
import { runFullPipeline, recallByNouns } from '../src/core/pipeline.ts'
import {
  createMockLLMProvider,
  type LLMProvider,
} from '../src/core/llmAdapter.ts'
import { loadLlmConfigFromEnv, chatCompletions } from '../src/harness/llm.ts'
import { extractNounSurfacesFromText, normalizeNounSurface } from '../src/core/bookNounIndex.ts'

const CORPUS_PATH =
  process.env.CORPUS_PATH ||
  './corpus/example.json'
const OUTPUT_DIR = './output'
const TOP_K = Number(process.env.TOP_K || 5)

// ===== DeepSeek Provider（基于现有 llm.ts 的 chatCompletions）=====
function createDeepSeekProvider(): LLMProvider {
  const cfg = loadLlmConfigFromEnv()
  return {
    generate: async (prompt: string, signal?: AbortSignal): Promise<string> => {
      const result = await chatCompletions({
        config: cfg,
        system: '你是文本分析助手，精通法语哲学文本中的概念提取。',
        user: prompt,
        temperature: 0.2,
        maxTokens: 2000,
        signal,
      })
      if (!result.ok) {
        console.warn(`  ⚠️ DeepSeek 调用失败：${result.note}`)
        return ''
      }
      return result.content
    },
  }
}

// ===== s1 补缺提取器（包装为 nounS1Fill 需要的格式）=====
function createS1Extractor(provider: LLMProvider) {
  return async (truncText: string): Promise<string[]> => {
    if (!truncText.trim()) return []
    const prompt = `从以下文本片段中提取所有名词（含专有名词、术语、人名），每行一个，保持原文形式（法语或英语）。

文本片段：
"""
${truncText.slice(0, 2000)}
"""

只输出名词列表，每行一个：`
    try {
      const out = await provider.generate(prompt)
      return out
        .split('\n')
        .map((l) => l.trim().replace(/^[-*\d.)\s]+/, ''))
        .filter((l) => l.length >= 2 && !/^[\d\s\p{P}]+$/u.test(l))
        .slice(0, 30)
    } catch {
      return []
    }
  }
}

// ===== 合并审查器 =====
function createMergeReviewer(provider: LLMProvider) {
  return async (
    leftSurface: string,
    rightSurface: string,
    context: string,
  ): Promise<string | null> => {
    const prompt = `判断以下两个相邻法语/英语名词是否应该合并为复合名词。

左词：${leftSurface}
右词：${rightSurface}

上下文：
"""
${context.slice(0, 300)}
"""

规则：
- 如果是常见复合概念（如 "machine learning"、"état de droit"），合并并返回完整形式
- 如果只是偶然相邻，回复 NO

只返回合并后的名词（保持原文）或 NO：`
    try {
      const out = await provider.generate(prompt)
      const trimmed = out.trim()
      if (!trimmed || /^(NO|non|不应该)/i.test(trimmed)) return null
      if (trimmed.length < 2) return null
      return trimmed
    } catch {
      return null
    }
  }
}

// ===== 主流程 =====
async function main() {
  console.log('=== 新管线测试（s0 → 截断 → s1 补缺 → 合并 → 终词表 → 拓扑链 → 召回）===\n')

  // 1. 加载语料
  if (!existsSync(CORPUS_PATH)) {
    console.error(`❌ 语料文件不存在：${CORPUS_PATH}`)
    console.error('   请先设置环境变量 CORPUS_PATH，例如：')
    console.error('   $env:CORPUS_PATH = "C:\\path\\to\\guattari.docuverse.json"')
    process.exit(1)
  }

  console.log(`📂 加载语料：${CORPUS_PATH}`)
  const pack = loadCorpusPack(CORPUS_PATH)
  console.log(`   标签：${pack.label}`)
  console.log(`   docId：${pack.docId}`)
  console.log(`   chunks：${pack.bookIndex.chunks.length}\n`)

  mkdirSync(OUTPUT_DIR, { recursive: true })

  // 2. 构建纯文表
  console.log('📋 构建纯文表...')
  const pureTextTable = buildPureTextTable(pack.bookIndex)
  console.log(`   ${pureTextTable.note}`)
  console.log(`   段落数：${pureTextTable.paragraphs.length}`)
  console.log(`   文本长度：${pureTextTable.fullText.length} 字符\n`)

  // 3. 选择 LLM Provider
  const llmCfg = loadLlmConfigFromEnv()
  const useRealLlm = !process.env.SKIP_LLM && llmCfg.apiKey.trim().length > 0
  const provider: LLMProvider = useRealLlm
    ? createDeepSeekProvider()
    : createMockLLMProvider()

  console.log(`🤖 LLM 模式：${useRealLlm ? `DeepSeek (${llmCfg.model})` : 'Mock'}`)
  if (!useRealLlm) {
    console.log('   （提示：设置 LLM_API_KEY 启用真实 LLM）\n')
  } else {
    console.log('')
  }

  // 4. 运行完整管线
  console.log('🔄 运行完整管线...')
  const startTime = Date.now()
  const pipelineResult = await runFullPipeline(pureTextTable, {
    llmExtractor: createS1Extractor(provider),
    mergeReviewer: createMergeReviewer(provider),
    concurrency: 3,
    skipS1: process.env.SKIP_S1 === '1',
    skipMerge: process.env.SKIP_MERGE === '1',
  })
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`   ✓ 完成（耗时 ${elapsed}s）`)
  console.log(`   摘要：${pipelineResult.summary}\n`)

  // 5. 展示统计
  console.log('📊 统计信息：')
  console.log(`   s0 名词数：${pipelineResult.s0Table.entries.length}`)
  console.log(`   截断数：${pipelineResult.truncations.length}`)
  console.log(`   s1 名词数：${pipelineResult.s1Table.entries.length}`)
  console.log(`   终词表名词数：${pipelineResult.finalTable.entries.length}`)
  console.log(
    `     - 来源 s0：${pipelineResult.finalTable.entries.filter((e) => e.source === 's0').length}`,
  )
  console.log(
    `     - 来源 s1：${pipelineResult.finalTable.entries.filter((e) => e.source === 's1').length}`,
  )
  console.log(
    `     - 合并词：${pipelineResult.finalTable.entries.filter((e) => e.source === 'merged').length}`,
  )
  console.log(`   拓扑链数：${pipelineResult.topologyTable.chains.length}`)
  console.log(`   覆盖名词数：${pipelineResult.topologyTable.byCenterId.size}\n`)

  // 6. 展示前 20 个高频终词
  console.log('🔝 Top 20 终词（按出现频次）：')
  for (let i = 0; i < Math.min(20, pipelineResult.finalTable.entries.length); i++) {
    const e = pipelineResult.finalTable.entries[i]!
    console.log(
      `   ${i + 1}. ${e.surface.padEnd(35)} df=${String(e.offsets.length).padStart(4)}  [${e.source}${e.mergedFrom ? ` · ${e.mergedFrom.join('+')}` : ''}]`,
    )
  }
  console.log('')

  // 7. 导出名词表
  writeFileSync(
    `${OUTPUT_DIR}/final-nouns.json`,
    JSON.stringify(
      {
        note: pipelineResult.finalTable.note,
        size: pipelineResult.finalTable.entries.length,
        entries: pipelineResult.finalTable.entries.slice(0, 500).map((e) => ({
          id: e.id,
          surface: e.surface,
          source: e.source,
          df: e.offsets.length,
          mergedFrom: e.mergedFrom,
          sampleOffsets: e.offsets.slice(0, 3),
        })),
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`💾 已导出终词表：${OUTPUT_DIR}/final-nouns.json\n`)

  // 8. 测试召回（针对 Guattari 的常见查询）
  const queries = [
    'Lacan',
    'schizophrénie',
    'désir',
    'sujet',
    'capitalisme',
    '无意识',
  ]

  console.log('🔎 测试召回：\n')
  for (const query of queries) {
    console.log(`   查询：${query}`)

    // 从查询中提取名词ID
    const querySurfaces = extractNounSurfacesFromText(query)
    const queryNounIds = querySurfaces.map((s) => normalizeNounSurface(s))

    const recallResult = recallByNouns(
      pipelineResult.topologyTable,
      pipelineResult.finalTable,
      queryNounIds,
    )

    console.log(`   ${recallResult.note}`)
    console.log(`   召回片段数：${recallResult.snippets.length}`)

    for (let i = 0; i < Math.min(TOP_K, recallResult.snippets.length); i++) {
      const snippet = recallResult.snippets[i]!
      const preview = snippet.length > 120 ? snippet.slice(0, 120) + '...' : snippet
      console.log(`     [${i + 1}] ${preview.replace(/\n+/g, ' ')}`)
    }
    console.log('')

    // 导出每个查询的召回结果
    const safeName = query.replace(/[^\w\u4e00-\u9fff]/g, '_')
    writeFileSync(
      `${OUTPUT_DIR}/recall-${safeName}.txt`,
      `【查询】${query}\n匹配名词ID：${queryNounIds.join(', ')}\n${recallResult.note}\n\n` +
        recallResult.snippets
          .slice(0, TOP_K)
          .map((s, i) => `--- [${i + 1}] ---\n${s}`)
          .join('\n\n'),
      'utf8',
    )
  }

  console.log('=== 测试完成 ===')
  console.log(`📁 输出目录：${resolve(OUTPUT_DIR)}`)
}

main().catch((err) => {
  console.error('❌ 测试失败：', err)
  if (err instanceof Error && err.stack) console.error(err.stack)
  process.exit(1)
})
