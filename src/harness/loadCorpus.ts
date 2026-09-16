import { readFileSync } from 'node:fs'
import type {
  BookIndex,
  BookSemanticIndex,
  CorpusPack,
} from '../core/types.ts'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function assertBookIndexShape(index: BookIndex): boolean {
  return (
    typeof index.docId === 'string' &&
    Array.isArray(index.chunks) &&
    index.chunks.every(
      (c) =>
        typeof c.key === 'string' &&
        typeof c.page === 'number' &&
        typeof c.content === 'string',
    )
  )
}

export function parseCorpusPack(raw: unknown):
  | { ok: true; pack: CorpusPack }
  | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: '不是 JSON 对象' }
  if (raw.kind !== 'docuverse-corpus') {
    return { ok: false, error: '不是 docuverse 语料包' }
  }
  const ver = raw.version
  if (ver !== 1 && ver !== 2) {
    return { ok: false, error: `不支持的语料包版本：${String(ver)}` }
  }
  if (typeof raw.label !== 'string' || typeof raw.docId !== 'string') {
    return { ok: false, error: '缺少 label/docId' }
  }
  if (!isRecord(raw.bookIndex) || !Array.isArray(raw.bookIndex.chunks)) {
    return { ok: false, error: '缺少有效 bookIndex' }
  }
  const pack = raw as unknown as CorpusPack
  if (!assertBookIndexShape(pack.bookIndex)) {
    return { ok: false, error: 'bookIndex 字段不完整' }
  }
  return { ok: true, pack }
}

export function loadCorpusPack(path: string): CorpusPack {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const parsed = parseCorpusPack(raw)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.pack
}

export type EvalCase = {
  id: string
  question: string
  /** Gold material addresses */
  goldBookKeys?: string[]
  goldPages?: number[]
  /** any = hit at least one gold; all = cover every gold */
  goldMode?: 'any' | 'all'
}

export type EvalFile = {
  docId?: string
  cases: EvalCase[]
}

export function loadEvalFile(path: string): EvalFile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as EvalFile
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error('eval 文件缺少 cases[]')
  }
  return raw
}

export function pageOfKey(bookIndex: BookIndex, key: string): number | null {
  const c = bookIndex.chunks.find((x) => x.key === key)
  return c ? c.page : null
}

export function listTocCorridors(semantic: BookSemanticIndex | null): Array<{
  index: number
  title: string
  startStrand: number
  endStrand: number
}> {
  const sections = semantic?.sections ?? []
  const out: Array<{
    index: number
    title: string
    startStrand: number
    endStrand: number
  }> = []
  let index = 0
  for (const sec of sections) {
    const title = (sec.title || '').trim()
    if (!title) continue
    const start = sec.pageRange?.startPage ?? sec.page
    const end = sec.pageRange?.endPage ?? start
    if (start == null || !Number.isFinite(start)) continue
    const a = Math.max(0, Math.floor(Number(start)))
    const b = Math.max(0, Math.floor(Number(end ?? start)))
    out.push({
      index,
      title: title.slice(0, 120),
      startStrand: Math.min(a, b),
      endStrand: Math.max(a, b),
    })
    index++
  }
  return out
}
