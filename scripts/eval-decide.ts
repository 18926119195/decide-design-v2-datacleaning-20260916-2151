#!/usr/bin/env node
/**
 * CLI: noun-table material accuracy (default).
 *   node --experimental-strip-types scripts/eval-decide.ts --corpus ... --eval ...
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCorpusPack, loadEvalFile } from '../src/harness/loadCorpus.ts'
import { loadLlmConfigFromEnv } from '../src/harness/llm.ts'
import { runNounTableMaterial } from '../src/harness/runNounTableMaterial.ts'
import { aggregateScores, scoreCase } from '../src/harness/score.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadDotEnv() {
  const p = resolve(ROOT, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    if (!(k in process.env)) process.env[k] = v
  }
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

async function main() {
  loadDotEnv()
  const corpusPath = arg('--corpus')
  const evalPath = arg('--eval', 'fixtures/eval.example.json')
  const outPath = arg('--out', 'results/noun-table-eval.json')
  if (!corpusPath) {
    console.error(
      '用法: node --experimental-strip-types scripts/eval-decide.ts --corpus <pack.docuverse.json> --eval <eval.json>',
    )
    process.exit(1)
  }

  const pack = loadCorpusPack(resolve(corpusPath))
  const evalFile = loadEvalFile(resolve(evalPath!))
  const llm = loadLlmConfigFromEnv()
  const residualLlm = hasFlag('--residual-llm')

  console.log(
    `strategy=noun-table · corpus=${pack.label} · chunks=${pack.bookIndex.chunks.length}`,
  )

  const caseRows = []
  for (const c of evalFile.cases) {
    console.log(`\n--- ${c.id}: ${c.question}`)
    const result = await runNounTableMaterial({
      question: c.question,
      bookIndex: pack.bookIndex,
      llm,
      options: { residualLlm },
      onProgress: (m) => console.log('  ', m),
    })
    const scored = scoreCase({
      bookIndex: pack.bookIndex,
      evalCase: c,
      predictedBookKeys: result.predictedBookKeys,
    })
    console.log(
      `  hit=${scored.hit} P=${scored.precision.toFixed(2)} R=${scored.recall.toFixed(2)}` +
        ` predPages=[${scored.predictedPages.join(',')}]` +
        ` · ${result.note}`,
    )
    caseRows.push({ case: c, result, score: scored })
  }

  const agg = aggregateScores(caseRows.map((r) => r.score))
  const payload = {
    at: new Date().toISOString(),
    strategy: 'noun-table',
    corpus: { label: pack.label, docId: pack.docId },
    aggregate: agg,
    cases: caseRows,
  }
  const out = resolve(ROOT, outPath!)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
  console.log('\n=== aggregate ===')
  console.log(
    `n=${agg.n} hitRate=${(agg.hitRate * 100).toFixed(1)}% meanP=${agg.meanPrecision.toFixed(3)} meanR=${agg.meanRecall.toFixed(3)}`,
  )
  console.log(`wrote ${out}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
