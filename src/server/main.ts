/**
 * Local noun-table eval server — import corpus + run accuracy tests.
 * Run: node --experimental-strip-types src/server/main.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCorpusPack } from '../harness/loadCorpus.ts'
import type { CorpusPack } from '../core/types.ts'
import type { EvalCase, EvalFile } from '../harness/loadCorpus.ts'
import { loadLlmConfigFromEnv } from '../harness/llm.ts'
import {
  clearNounTableCache,
  ensureNounTable,
  runNounTableMaterial,
} from '../harness/runNounTableMaterial.ts'
import {
  buildMonitorPack,
  monitorPackToMarkdown,
  type MonitorPack,
} from '../harness/buildMonitorExport.ts'
import {
  superviseS0S1,
  superviseReportToMarkdown,
  type SSuperviseReport,
} from '../harness/superviseS0S1.ts'
import { aggregateScores, scoreCase } from '../harness/score.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const PORT = Number(process.env.PORT || 5188)
const HOST = process.env.HOST || '127.0.0.1'

type Session = {
  pack: CorpusPack | null
  evalFile: EvalFile
  lastResult: unknown
  lastMonitor: MonitorPack | null
  lastSupervise: SSuperviseReport | null
}

const session: Session = {
  pack: null,
  evalFile: {
    cases: [
      {
        id: 'q1',
        question: '是否提到拉康？',
        goldPages: [],
        goldMode: 'any',
      },
    ],
  },
  lastResult: null,
  lastMonitor: null,
  lastSupervise: null,
}

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

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(data)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    const llm = loadLlmConfigFromEnv()
    sendJson(res, 200, {
      ok: true,
      strategy: 'noun-table',
      hasCorpus: !!session.pack,
      corpus: session.pack
        ? {
            label: session.pack.label,
            docId: session.pack.docId,
            chunks: session.pack.bookIndex.chunks.length,
          }
        : null,
      cases: session.evalFile.cases.length,
      llmConfigured: !!llm.apiKey,
      model: llm.model,
    })
    return
  }

  if (url.pathname === '/api/corpus' && req.method === 'POST') {
    const buf = await readBody(req)
    let raw: unknown
    try {
      raw = JSON.parse(buf.toString('utf8'))
    } catch {
      sendJson(res, 400, { ok: false, error: 'JSON 解析失败' })
      return
    }
    const parsed = parseCorpusPack(raw)
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: parsed.error })
      return
    }
    session.pack = parsed.pack
    clearNounTableCache()
    const dir = resolve(ROOT, 'fixtures')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'last-corpus.docuverse.json'),
      JSON.stringify(parsed.pack),
    )
    sendJson(res, 200, {
      ok: true,
      label: parsed.pack.label,
      docId: parsed.pack.docId,
      chunks: parsed.pack.bookIndex.chunks.length,
      sections: parsed.pack.semanticIndex?.sections?.length ?? 0,
    })
    return
  }

  if (url.pathname === '/api/eval-cases' && req.method === 'POST') {
    const buf = await readBody(req)
    let raw: unknown
    try {
      raw = JSON.parse(buf.toString('utf8'))
    } catch {
      sendJson(res, 400, { ok: false, error: 'JSON 解析失败' })
      return
    }
    const obj = raw as EvalFile
    if (!Array.isArray(obj.cases)) {
      sendJson(res, 400, { ok: false, error: '需要 { cases: [...] }' })
      return
    }
    session.evalFile = obj
    sendJson(res, 200, { ok: true, n: obj.cases.length })
    return
  }

  if (url.pathname === '/api/eval-cases' && req.method === 'GET') {
    sendJson(res, 200, session.evalFile)
    return
  }

  if (url.pathname === '/api/build-s' && req.method === 'POST') {
    if (!session.pack) {
      sendJson(res, 400, { ok: false, error: '先导入语料包' })
      return
    }
    const llm = loadLlmConfigFromEnv()
    let body: { residualLlm?: boolean } = {}
    try {
      const buf = await readBody(req)
      if (buf.length) body = JSON.parse(buf.toString('utf8'))
    } catch {
      /* empty ok */
    }
    const table = await ensureNounTable({
      bookIndex: session.pack.bookIndex,
      llm,
      residualLlm: !!body.residualLlm,
      forceRebuild: true,
    })
    sendJson(res, 200, {
      ok: true,
      note: table.note,
      size: table.entries.length,
      sample: table.entries.slice(0, 30).map((e) => ({
        surface: e.surface,
        df: e.df,
      })),
      promptTokens: table.promptTokens,
      completionTokens: table.completionTokens,
    })
    return
  }

  if (url.pathname === '/api/supervise-s' && req.method === 'POST') {
    if (!session.pack) {
      sendJson(res, 400, { ok: false, error: '先导入语料包' })
      return
    }
    const llm = loadLlmConfigFromEnv()
    let body: { residualLlm?: boolean } = {}
    try {
      const buf = await readBody(req)
      if (buf.length) body = JSON.parse(buf.toString('utf8'))
    } catch {
      /* */
    }
    if (body.residualLlm && !llm.apiKey) {
      sendJson(res, 400, { ok: false, error: '开 S₁ 需要 LLM_API_KEY' })
      return
    }
    const report = await superviseS0S1({
      bookIndex: session.pack.bookIndex,
      corpus: {
        label: session.pack.label,
        docId: session.pack.docId,
        chunks: session.pack.bookIndex.chunks.length,
      },
      llm,
      residualLlm: !!body.residualLlm,
    })
    session.lastSupervise = report
    const outDir = resolve(ROOT, 'results')
    mkdirSync(outDir, { recursive: true })
    const stamp = Date.now()
    writeFileSync(
      join(outDir, `supervise-s-${stamp}.json`),
      JSON.stringify(report, null, 2),
    )
    writeFileSync(
      join(outDir, `supervise-s-${stamp}.md`),
      superviseReportToMarkdown(report),
      'utf8',
    )
    sendJson(res, 200, { ok: true, report })
    return
  }

  if (url.pathname === '/api/supervise-s' && req.method === 'GET') {
    if (!session.lastSupervise) {
      sendJson(res, 400, { ok: false, error: '尚无监督报告：请先点「监督 S₀+S₁」' })
      return
    }
    const format = url.searchParams.get('format') || 'json'
    if (format === 'md') {
      const md = superviseReportToMarkdown(session.lastSupervise)
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition':
          'attachment; filename="complete-nouns-supervise.md"',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(md)
      return
    }
    if (format === 'u') {
      const body = {
        kind: 'docuverse-noun-universe-U',
        at: session.lastSupervise.at,
        corpus: session.lastSupervise.corpus,
        closed: session.lastSupervise.closure.closed,
        llmHitVerify: session.lastSupervise.llmHitVerify,
        closedByRule: session.lastSupervise.closure.closedByRule,
        size: session.lastSupervise.U.size,
        nouns: session.lastSupervise.U.nouns,
        missedInResidual: session.lastSupervise.S1.missedInResidual,
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="noun-universe-U.json"',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify(body, null, 2))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition':
        'attachment; filename="complete-nouns-supervise.json"',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify(session.lastSupervise, null, 2))
    return
  }

  if (url.pathname === '/api/run' && req.method === 'POST') {
    if (!session.pack) {
      sendJson(res, 400, { ok: false, error: '先导入语料包' })
      return
    }
    const llm = loadLlmConfigFromEnv()
    if (!llm.apiKey) {
      sendJson(res, 400, { ok: false, error: '缺少 LLM_API_KEY（写在 .env）' })
      return
    }
    let opts: {
      residualLlm?: boolean
      cases?: EvalCase[]
      neighborN?: number
    } = {}
    try {
      const buf = await readBody(req)
      if (buf.length) opts = JSON.parse(buf.toString('utf8'))
    } catch {
      /* */
    }
    const cases = opts.cases?.length ? opts.cases : session.evalFile.cases
    const rows = []
    for (const c of cases) {
      const result = await runNounTableMaterial({
        question: c.question,
        bookIndex: session.pack.bookIndex,
        llm,
        options: {
          residualLlm: !!opts.residualLlm,
          neighborN: opts.neighborN ?? 5,
        },
      })
      const score = scoreCase({
        bookIndex: session.pack.bookIndex,
        evalCase: c,
        predictedBookKeys: result.predictedBookKeys,
      })
      rows.push({ case: c, result, score })
    }
    const agg = aggregateScores(rows.map((r) => r.score))
    const monitor = buildMonitorPack({
      corpus: {
        label: session.pack.label,
        docId: session.pack.docId,
        chunks: session.pack.bookIndex.chunks.length,
      },
      bookIndex: session.pack.bookIndex,
      rows,
    })
    const payload = {
      at: new Date().toISOString(),
      strategy: 'noun-table',
      corpus: {
        label: session.pack.label,
        docId: session.pack.docId,
      },
      aggregate: agg,
      cases: rows,
      monitor,
      diagnosis: monitor.globalDiagnosis,
    }
    session.lastResult = payload
    session.lastMonitor = monitor
    const outDir = resolve(ROOT, 'results')
    mkdirSync(outDir, { recursive: true })
    const stamp = Date.now()
    writeFileSync(
      join(outDir, `noun-table-${stamp}.json`),
      JSON.stringify(payload, null, 2),
    )
    writeFileSync(
      join(outDir, `monitor-${stamp}.json`),
      JSON.stringify(monitor, null, 2),
    )
    writeFileSync(
      join(outDir, `monitor-${stamp}.md`),
      monitorPackToMarkdown(monitor),
      'utf8',
    )
    sendJson(res, 200, payload)
    return
  }

  if (url.pathname === '/api/monitor' && req.method === 'GET') {
    if (!session.lastMonitor) {
      sendJson(res, 400, { ok: false, error: '尚无监控包：请先跑评测' })
      return
    }
    const format = url.searchParams.get('format') || 'json'
    if (format === 'md') {
      const md = monitorPackToMarkdown(session.lastMonitor)
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="noun-table-monitor.md"',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(md)
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="noun-table-monitor.json"',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify(session.lastMonitor, null, 2))
    return
  }

  if (url.pathname === '/api/last-result' && req.method === 'GET') {
    sendJson(res, 200, session.lastResult ?? { ok: false, error: '尚无结果' })
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.css')) return 'text/css; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

async function main() {
  loadDotEnv()
  const publicDir = resolve(ROOT, 'public')

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url)
        return
      }
      let path = url.pathname === '/' ? '/index.html' : url.pathname
      const file = resolve(publicDir, '.' + path)
      if (!file.startsWith(publicDir) || !existsSync(file)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': contentType(file) })
      res.end(readFileSync(file))
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  })

  server.listen(PORT, HOST, () => {
    console.log(`noun-table eval · http://${HOST}:${PORT}`)
    console.log(`strategy=noun-table · LLM_KEY=${loadLlmConfigFromEnv().apiKey ? 'yes' : 'NO'}`)
  })
}

main()
