/** Minimal A1 types for decide material eval (from Docuverse BookIndex). */

export type PlaceFaces = {
  text?: { content: string }
  fig?: { note: string; figId?: string }
}

export type AChunk = {
  ord: number
  id: string
  page: number
  bbox: [number, number, number, number]
  key: string
  kind: string
  faces: PlaceFaces
  content: string
}

export type BookIndex = {
  docId: string
  stream?: string
  chunks: AChunk[]
  builtAt?: number
}

export type SemanticSection = {
  nodeId: string
  title: string
  page?: number
  pageRange?: { startPage: number; endPage: number }
}

export type BookSemanticIndex = {
  docId: string
  sections: SemanticSection[]
  builtAt?: number
}

export type CorpusPack = {
  kind: 'docuverse-corpus'
  version: 1 | 2
  label: string
  docId: string
  exportedAt: number
  bookIndex: BookIndex
  semanticIndex: BookSemanticIndex | null
  pages?: unknown[]
}
