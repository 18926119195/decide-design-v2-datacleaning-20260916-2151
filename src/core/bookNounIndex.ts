/**
 * Book noun table S — rule extract + mask + dedupe (case-insensitive surface).
 * Optional residual LLM fill is in harness/residualNounLlm.ts
 */

import { atomSearchText, isRetrievableAtom } from './text.ts'
import type { BookIndex } from './types.ts'

export type NounEntry = {
  /** Normalized surface for dedupe key (lower / trim) */
  id: string
  /** Display form (first seen) */
  surface: string
  df: number
  bookKeys: string[]
}

export type NounHit = {
  nounId: string
  surface: string
  bookKey: string
  page: number
  /** Char start in chunk T */
  start: number
  end: number
}

export type TopoBag = {
  bagId: string
  hit: NounHit
  /** Neighbor nouns (±n distinct from hit noun), unique in bag */
  neighbors: string[]
  bookKey: string
  page: number
}

const STOP_CJK = new Set([
  '我们',
  '你们',
  '他们',
  '它们',
  '这个',
  '那个',
  '这些',
  '那些',
  '什么',
  '如何',
  '怎么',
  '因为',
  '所以',
  '但是',
  '然后',
  '如果',
  '已经',
  '可以',
  '没有',
  '不是',
  '一个',
  '一种',
  '以及',
  '或者',
  '对于',
  '通过',
  '进行',
  '问题',
  '方面',
  '时候',
  '自己',
  '这样',
  '那样',
  '因此',
  '其中',
  '同时',
  '而且',
  '虽然',
  '不过',
  '只是',
  '还是',
  '就是',
  '也是',
  '可能',
  '需要',
  '应当',
  '必须',
  '本书',
  '本章',
  '本文',
  '上述',
  '下列',
  '参见',
  '例如',
  '比如',
])

const STOP_LATIN = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'have',
  'been',
  'were',
  'are',
  'was',
  'not',
  'but',
  'his',
  'her',
  'their',
  'which',
  'into',
  'also',
  'than',
  'then',
  'when',
  'what',
  'where',
  'who',
  'how',
  'why',
  'may',
  'can',
  'could',
  'would',
  'should',
  'will',
  'shall',
  'must',
  'such',
  'only',
  'more',
  'most',
  'other',
  'some',
  'any',
  'each',
  'every',
  'both',
  'few',
  'many',
  'much',
  'very',
  'just',
  'about',
  'over',
  'after',
  'before',
  'between',
  'under',
  'again',
  'further',
  'once',
  'here',
  'there',
  'all',
  'chapter',
  'section',
  'page',
  'figure',
  'table',
  'ibid',
  'etc',
  // French function / high-df glue (Guattari OCR)
  'des',
  'les',
  'une',
  'que',
  'qui',
  'dans',
  'pour',
  'avec',
  'sur',
  'par',
  'mais',
  'plus',
  'tout',
  'tous',
  'cette',
  'comme',
  'leur',
  'leurs',
  'ses',
  'aux',
  'est',
  'sont',
  'été',
  'être',
  'avoir',
  'fait',
  'faire',
  'rien',
  'entre',
  'sans',
  'sous',
  'chez',
  'donc',
  'ainsi',
  'alors',
  'aussi',
  'bien',
  'encore',
  'déjà',
  'très',
  'peu',
  'ces',
  'cet',
  'ceux',
  'celle',
  'celui',
  'dont',
  'où',
  'quand',
  'quoi',
  'car',
  'ni',
  'ou',
  'mais',
  'mis',
  'dit',
  'dire',
  'peut',
  'peuvent',
  'pouvant',
  'importe',
])

export function normalizeNounSurface(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Extract candidate noun surfaces from one chunk text (multiplicity preserved). */
export function extractNounSurfacesFromText(text: string): string[] {
  const out: string[] = []
  if (!text.trim()) return out

  // Latin tokens (incl. accented) length ≥ 3
  const latinRe = /[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ''\-]{2,}/g
  let m: RegExpExecArray | null
  while ((m = latinRe.exec(text))) {
    const s = m[0]!.replace(/^[''\-]+|[''\-]+$/g, '')
    if (s.length < 3) continue
    const low = s.toLowerCase()
    if (STOP_LATIN.has(low)) continue
    if (/^\d/.test(s)) continue
    out.push(s)
  }

  // CJK spans: short wholes; long spans split on function chars then take 2–6 pieces
  const cjkSpanRe = /[\u4e00-\u9fff]+/g
  const splitRe = /[与的在和及了着过是为对从把被让向以而并或等也又就都还很不无有]/
  while ((m = cjkSpanRe.exec(text))) {
    const span = m[0]!
    const pieces =
      span.length <= 6 ? [span] : span.split(splitRe).filter((p) => p.length >= 2)
    for (const piece of pieces) {
      if (piece.length >= 2 && piece.length <= 6 && !STOP_CJK.has(piece)) {
        out.push(piece)
      } else if (piece.length > 6) {
        // still long: emit head/tail 2–4 only
        out.push(piece.slice(0, 4))
        out.push(piece.slice(-4))
        if (piece.length >= 6) out.push(piece.slice(0, 2), piece.slice(-2))
      }
    }
  }

  return out
}

/** Aggregate raw surfaces from A1 into a noun map (deduped, no quality filter). */
export function collectRawNounMap(bookIndex: BookIndex): {
  map: Map<string, NounEntry>
  rawCount: number
} {
  const map = new Map<string, NounEntry>()
  let rawCount = 0
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue
    const t = atomSearchText(chunk)
    const surfaces = extractNounSurfacesFromText(t)
    rawCount += surfaces.length
    for (const surface of surfaces) {
      const id = normalizeNounSurface(surface)
      if (id.length < 2) continue
      let e = map.get(id)
      if (!e) {
        e = { id, surface, df: 0, bookKeys: [] }
        map.set(id, e)
      }
      e.df++
      if (!e.bookKeys.includes(chunk.key)) e.bookKeys.push(chunk.key)
      if (surface.length > e.surface.length) e.surface = surface
    }
  }
  return { map, rawCount }
}

/** Filter/prune map → S₀ (production closed set before residual). */
export function filterToS0(map: Map<string, NounEntry>): NounEntry[] {
  const entries = [...map.values()].filter((e) => {
    if (e.df >= 2) return true
    if (/^[A-ZÀ-Ý]/.test(e.surface) && /[a-zA-ZÀ-ÿ]{3,}/.test(e.surface)) {
      return true
    }
    if (/^[\u4e00-\u9fff]{2,4}$/.test(e.surface) && e.df >= 1) return true
    return false
  })
  const pruned = entries.filter((e) => {
    if (!/^[\u4e00-\u9fff]+$/.test(e.surface)) return true
    for (const other of entries) {
      if (other.id === e.id) continue
      if (!/^[\u4e00-\u9fff]+$/.test(other.surface)) continue
      if (
        other.surface.includes(e.surface) &&
        other.surface.length > e.surface.length &&
        other.df >= e.df
      ) {
        return false
      }
    }
    return true
  })
  pruned.sort((a, b) => b.df - a.df || a.id.localeCompare(b.id))
  return pruned
}

/**
 * O = 原文规则抽词去重全量（不过滤）
 * S₀ = 过滤后进入勾选前的规则表
 */
export function buildNounTableLayers(bookIndex: BookIndex): {
  /** 原来的：原文规则抽词 · 去重全量 */
  O: NounEntry[]
  /** 规则过滤后 */
  S0: NounEntry[]
  rawCount: number
  note: string
} {
  const { map, rawCount } = collectRawNounMap(bookIndex)
  const O = [...map.values()].sort(
    (a, b) => b.df - a.df || a.id.localeCompare(b.id),
  )
  const S0 = filterToS0(map)
  return {
    O,
    S0,
    rawCount,
    note: `O(原文规则去重全量)×${O.length} · S₀(过滤后)×${S0.length} · 原始抽×${rawCount}`,
  }
}

export function buildNounTable(bookIndex: BookIndex): {
  entries: NounEntry[]
  byId: Map<string, NounEntry>
  note: string
} {
  const { S0, note } = buildNounTableLayers(bookIndex)
  const byId = new Map(S0.map((e) => [e.id, e]))
  return {
    entries: S0,
    byId,
    note: `名词表 S₀ · ${note}`,
  }
}

/** Mask known S surfaces in text (same-length underscores) for residual LLM. */
export function maskNounsInText(text: string, surfaces: ReadonlyArray<string>): string {
  const sorted = [...surfaces].sort((a, b) => b.length - a.length)
  let out = text
  for (const s of sorted) {
    if (s.length < 2) continue
    const re = new RegExp(escapeRegExp(s), 'gi')
    out = out.replace(re, (hit) => '_'.repeat(hit.length))
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Locate all occurrences of selected nouns in A1. */
export function locateNounHits(input: {
  bookIndex: BookIndex
  nouns: ReadonlyArray<NounEntry>
  maxHitsPerNoun?: number
}): NounHit[] {
  const maxPer = input.maxHitsPerNoun ?? 80
  const hits: NounHit[] = []
  for (const noun of input.nouns) {
    let count = 0
    const re = new RegExp(escapeRegExp(noun.surface), 'gi')
    // Also try id if different
    const patterns = [noun.surface]
    if (noun.id !== noun.surface.toLowerCase()) patterns.push(noun.id)

    for (const chunk of input.bookIndex.chunks) {
      if (!isRetrievableAtom(chunk)) continue
      const t = atomSearchText(chunk)
      if (!t) continue
      for (const pat of patterns) {
        const r = new RegExp(escapeRegExp(pat), 'gi')
        let m: RegExpExecArray | null
        while ((m = r.exec(t))) {
          hits.push({
            nounId: noun.id,
            surface: m[0]!,
            bookKey: chunk.key,
            page: chunk.page,
            start: m.index,
            end: m.index + m[0]!.length,
          })
          count++
          if (count >= maxPer) break
        }
        if (count >= maxPer) break
      }
      if (count >= maxPer) break
    }
  }
  // Dedupe exact same span
  const seen = new Set<string>()
  const uniq: NounHit[] = []
  for (const h of hits) {
    const k = `${h.bookKey}:${h.start}:${h.end}:${h.nounId}`
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(h)
  }
  return uniq
}

type Occ = { start: number; end: number; id: string; surface: string }

/** All S-noun occurrences in one chunk, sorted by start (non-overlapping greedy). */
function nounOccurrencesInChunk(
  text: string,
  nounById: Map<string, NounEntry>,
): Occ[] {
  const entries = [...nounById.values()].sort(
    (a, b) => b.id.length - a.id.length || b.surface.length - a.surface.length,
  )
  const lower = text.toLowerCase()
  const taken = new Array<boolean>(text.length).fill(false)
  const occ: Occ[] = []
  for (const e of entries) {
    const needle = e.id
    if (needle.length < 2) continue
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      const end = at + needle.length
      let overlap = false
      for (let i = at; i < end; i++) {
        if (taken[i]) {
          overlap = true
          break
        }
      }
      if (!overlap) {
        for (let i = at; i < end; i++) taken[i] = true
        occ.push({
          start: at,
          end,
          id: e.id,
          surface: text.slice(at, end),
        })
      }
      from = at + 1
    }
  }
  occ.sort((a, b) => a.start - b.start)
  return occ
}

/**
 * Build ordered noun sequence for a chunk, then ±n neighbors ≠ hit noun.
 */
export function buildTopoBags(input: {
  bookIndex: BookIndex
  nounById: Map<string, NounEntry>
  hits: ReadonlyArray<NounHit>
  neighborN?: number
  maxBags?: number
}): TopoBag[] {
  const n = input.neighborN ?? 5
  const maxBags = input.maxBags ?? 120
  const chunkSeq = new Map<string, Occ[]>()

  function seqFor(bookKey: string): Occ[] {
    const cached = chunkSeq.get(bookKey)
    if (cached) return cached
    const chunk = input.bookIndex.chunks.find((c) => c.key === bookKey)
    if (!chunk) {
      chunkSeq.set(bookKey, [])
      return []
    }
    const seq = nounOccurrencesInChunk(atomSearchText(chunk), input.nounById)
    chunkSeq.set(bookKey, seq)
    return seq
  }

  const bags: TopoBag[] = []
  for (const hit of input.hits) {
    const seq = seqFor(hit.bookKey)
    let idx = seq.findIndex(
      (o) =>
        o.id === hit.nounId &&
        ((o.start <= hit.start && o.end >= hit.end) ||
          Math.abs(o.start - hit.start) <= 1),
    )
    if (idx < 0) idx = seq.findIndex((o) => o.id === hit.nounId)
    if (idx < 0) continue

    const neighbors: string[] = []
    const seen = new Set<string>()
    for (let j = idx - 1; j >= 0 && neighbors.length < n; j--) {
      const id = seq[j]!.id
      if (id === hit.nounId || seen.has(id)) continue
      seen.add(id)
      neighbors.push(input.nounById.get(id)?.surface ?? seq[j]!.surface)
    }
    neighbors.reverse()
    const leftN = neighbors.length
    for (let j = idx + 1; j < seq.length && neighbors.length < leftN + n; j++) {
      const id = seq[j]!.id
      if (id === hit.nounId || seen.has(id)) continue
      seen.add(id)
      neighbors.push(input.nounById.get(id)?.surface ?? seq[j]!.surface)
    }

    bags.push({
      bagId: `bag_${bags.length + 1}`,
      hit,
      neighbors,
      bookKey: hit.bookKey,
      page: hit.page,
    })
    if (bags.length >= maxBags) break
  }
  return bags
}

export function mergeNounEntries(
  base: NounEntry[],
  extraSurfaces: string[],
  bookIndex: BookIndex,
): NounEntry[] {
  const map = new Map(base.map((e) => [e.id, { ...e, bookKeys: [...e.bookKeys] }]))
  for (const surface of extraSurfaces) {
    const id = normalizeNounSurface(surface)
    if (id.length < 2) continue
    let e = map.get(id)
    if (!e) {
      e = { id, surface, df: 0, bookKeys: [] }
      map.set(id, e)
    }
    // recount lightly: mark present in any chunk containing surface
    for (const chunk of bookIndex.chunks) {
      if (!isRetrievableAtom(chunk)) continue
      const t = atomSearchText(chunk)
      if (t.toLowerCase().includes(id)) {
        e.df++
        if (!e.bookKeys.includes(chunk.key)) e.bookKeys.push(chunk.key)
      }
    }
    if (e.df === 0) e.df = 1
  }
  return [...map.values()].sort((a, b) => b.df - a.df || a.id.localeCompare(b.id))
}
