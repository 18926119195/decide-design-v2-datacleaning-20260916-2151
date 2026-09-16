/**
 * 名词表 s0（新版）：规则抽取 + 全局偏移量定位
 * 职责：
 * 1. 从纯文表抽取名词（规则）
 * 2. 记录每个名词在纯文表中的精确偏移位置
 * 3. 构建截断（truncations）用于后续补缺LLM
 */

import type { PureTextTable } from './pureTextTable.ts'
import { extractNounSurfacesFromText, normalizeNounSurface } from './bookNounIndex.ts'

export type NounS0Entry = {
  /** 标准化ID（去重键） */
  id: string
  /** 展示形式（最长形式） */
  surface: string
  /** 文档频率（出现次数） */
  df: number
  /** 全局偏移量列表 [{start, end}, ...] */
  offsets: Array<{ start: number; end: number }>
}

export type NounS0Table = {
  entries: NounS0Entry[]
  byId: Map<string, NounS0Entry>
  note: string
}

/**
 * 截断：s0名词之间的间隙文本
 * 用于补缺LLM递归提取
 */
export type Truncation = {
  /** 截断ID */
  truncId: string
  /** 左边界名词ID（或 'START'） */
  leftMask: string
  /** 右边界名词ID（或 'END'） */
  rightMask: string
  /** 截断在纯文表中的起始偏移 */
  startOffset: number
  /** 截断在纯文表中的结束偏移 */
  endOffset: number
  /** 截断文本（用于LLM，不含mask） */
  text: string
}

/**
 * 从纯文表构建 s0 名词表
 */
export function buildNounS0Table(pureTextTable: PureTextTable): NounS0Table {
  const map = new Map<string, NounS0Entry>()
  const fullText = pureTextTable.fullText
  const fullTextLower = fullText.toLowerCase()

  // 1. 抽取所有候选名词表面形式
  const surfaces = extractNounSurfacesFromText(fullText)

  // 2. 按 id 分组所有表面形式
  const candidates = new Map<string, Set<string>>()
  for (const surface of surfaces) {
    const id = normalizeNounSurface(surface)
    if (id.length < 2) continue
    if (!candidates.has(id)) {
      candidates.set(id, new Set())
    }
    candidates.get(id)!.add(surface)
  }

  // 3. 定位每个名词的所有出现位置（偏移量）
  for (const [id, surfaceSet] of candidates) {
    const allSurfaces = [...surfaceSet]
    // 按长度降序，优先匹配长词（避免短词覆盖长词）
    allSurfaces.sort((a, b) => b.length - a.length)

    const offsetsMap = new Map<string, { start: number; end: number }>()

    for (const surface of allSurfaces) {
      const needle = surface.toLowerCase()
      let from = 0
      while (from < fullTextLower.length) {
        const at = fullTextLower.indexOf(needle, from)
        if (at < 0) break

        const end = at + needle.length
        const key = `${at}-${end}`

        // 检查是否与已有偏移重叠
        let overlap = false
        for (const exist of offsetsMap.values()) {
          if (
            (at >= exist.start && at < exist.end) ||
            (end > exist.start && end <= exist.end) ||
            (at <= exist.start && end >= exist.end)
          ) {
            overlap = true
            break
          }
        }

        if (!overlap) {
          offsetsMap.set(key, { start: at, end })
        }

        from = at + 1
      }
    }

    if (offsetsMap.size === 0) continue

    const offsets = [...offsetsMap.values()]
    // 按偏移排序
    offsets.sort((a, b) => a.start - b.start)

    // 选择最长的表面形式
    const bestSurface = allSurfaces[0]!

    map.set(id, {
      id,
      surface: bestSurface,
      df: offsets.length,
      offsets,
    })
  }

  // 4. 过滤：df >= 2 或 首字母大写且长度>=3 或 CJK 2-4字
  const filtered = [...map.values()].filter((e) => {
    if (e.df >= 2) return true
    if (/^[A-ZÀ-Ý]/.test(e.surface) && /[a-zA-ZÀ-ÿ]{3,}/.test(e.surface)) {
      return true
    }
    if (/^[\u4e00-\u9fff]{2,4}$/.test(e.surface) && e.df >= 1) return true
    return false
  })

  // 5. CJK 子串剪枝：如果短词完全包含在更高频的长词中，剪掉短词
  const pruned = filtered.filter((e) => {
    if (!/^[\u4e00-\u9fff]+$/.test(e.surface)) return true
    for (const other of filtered) {
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

  const byId = new Map(pruned.map((e) => [e.id, e]))

  return {
    entries: pruned,
    byId,
    note: `s0 规则名词表 · 词×${pruned.length} · 总命中×${pruned.reduce((s, e) => s + e.df, 0)}`,
  }
}

/**
 * 构建截断（truncations）：s0名词之间的间隙
 * 用于补缺LLM提取遗漏名词
 */
export function buildTruncations(
  pureTextTable: PureTextTable,
  nounS0Table: NounS0Table,
): Truncation[] {
  const fullText = pureTextTable.fullText

  // 1. 收集所有 s0 名词的偏移量，并排序
  const allOffsets: Array<{ start: number; end: number; id: string }> = []
  for (const entry of nounS0Table.entries) {
    for (const offset of entry.offsets) {
      allOffsets.push({ ...offset, id: entry.id })
    }
  }
  allOffsets.sort((a, b) => a.start - b.start)

  // 2. 构建截断：相邻名词之间的间隙
  const truncations: Truncation[] = []
  const MIN_TRUNC_LEN = 10 // 最小截断长度（字符数）

  // 起始截断（从文本开头到第一个名词）
  if (allOffsets.length > 0) {
    const firstOffset = allOffsets[0]!
    if (firstOffset.start > MIN_TRUNC_LEN) {
      const text = fullText.slice(0, firstOffset.start).trim()
      if (text.length >= MIN_TRUNC_LEN) {
        truncations.push({
          truncId: `trunc_0`,
          leftMask: 'START',
          rightMask: firstOffset.id,
          startOffset: 0,
          endOffset: firstOffset.start,
          text,
        })
      }
    }
  }

  // 中间截断（相邻名词之间）
  for (let i = 0; i < allOffsets.length - 1; i++) {
    const left = allOffsets[i]!
    const right = allOffsets[i + 1]!

    if (right.start > left.end + MIN_TRUNC_LEN) {
      const text = fullText.slice(left.end, right.start).trim()
      if (text.length >= MIN_TRUNC_LEN) {
        truncations.push({
          truncId: `trunc_${i + 1}`,
          leftMask: left.id,
          rightMask: right.id,
          startOffset: left.end,
          endOffset: right.start,
          text,
        })
      }
    }
  }

  // 结束截断（最后一个名词到文本末尾）
  if (allOffsets.length > 0) {
    const lastOffset = allOffsets[allOffsets.length - 1]!
    if (fullText.length - lastOffset.end > MIN_TRUNC_LEN) {
      const text = fullText.slice(lastOffset.end).trim()
      if (text.length >= MIN_TRUNC_LEN) {
        truncations.push({
          truncId: `trunc_end`,
          leftMask: lastOffset.id,
          rightMask: 'END',
          startOffset: lastOffset.end,
          endOffset: fullText.length,
          text,
        })
      }
    }
  }

  return truncations
}
