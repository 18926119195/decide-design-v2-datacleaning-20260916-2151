/**
 * 应用合并审查决策：把 merge-review-result.json 中 should_merge=true 的判定
 * 应用到 final-noun-index.json 上，生成真正的"终词表"。
 *
 * 逻辑（对齐 src/core/nounMerge.ts 的 buildFinalNounTable 步骤4-5）：
 * 1. 读取终词表（s0+s1）和合并审查决策
 * 2. 对每条 should_merge=true 的决策：
 *    - 用 leftId 的 offset.start + rightId 的 offset.end 构建合并区间
 *    - 创建新的 merged 词条（source='merged'，记录 mergedFrom）
 *    - 从左右原子词的 offsets 中移除已被合并覆盖的区间
 * 3. 清理 offsets 为空的词条（说明它所有出现都被合并掉了）
 * 4. 输出最终名词表
 *
 * 用法：
 *   node apply-merge-decisions.js
 */

import fs from 'fs';

const FINAL_INDEX_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index.json';
const MERGE_RESULT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\merge-review-result.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-table.json';

// 异常长合并阈值：超过此长度的 merged_surface 视为 LLM 误把大段上下文当成
// "复合名词"返回，跳过应用（保留原子词，不合并），避免污染终词表。
const MAX_MERGED_SURFACE_LEN = 60;

function normalizeId(surface) {
  return surface.toLowerCase().trim().replace(/\s+/g, '_');
}

function main() {
  console.log('========== 应用合并审查决策 ==========\n');

  const finalIndex = JSON.parse(fs.readFileSync(FINAL_INDEX_PATH, 'utf-8'));
  const mergeResult = JSON.parse(fs.readFileSync(MERGE_RESULT_PATH, 'utf-8'));

  const nounsById = new Map();
  for (const entry of finalIndex.nouns) {
    nounsById.set(entry.id, {
      id: entry.id,
      surface: entry.surface,
      source: entry.source,
      offsets: [...entry.offsets],
    });
  }
  console.log(`终词表（合并前）: ${nounsById.size} 个名词\n`);

  const decisions = mergeResult.decisions.filter((d) => d.should_merge);
  console.log(`合并决策: ${decisions.length} 条（should_merge=true）\n`);

  let applied = 0;
  let skippedTooLong = 0;
  let skippedMissingOffset = 0;

  for (const decision of decisions) {
    const mergedSurface = (decision.merged_surface || '').trim();
    if (!mergedSurface) continue;

    if (mergedSurface.length > MAX_MERGED_SURFACE_LEN) {
      skippedTooLong++;
      continue;
    }

    const leftEntry = nounsById.get(decision.leftId);
    const rightEntry = nounsById.get(decision.rightId);
    if (!leftEntry || !rightEntry) continue;

    const { start, end } = decision.offsets || {};
    if (start === undefined || end === undefined) {
      skippedMissingOffset++;
      continue;
    }

    // 确认左右词在这个区间内确实各有一个 offset（避免误删不相关的位置）
    const leftOffsetIdx = leftEntry.offsets.findIndex((o) => o.start === start);
    const rightOffsetIdx = rightEntry.offsets.findIndex((o) => o.end === end);
    if (leftOffsetIdx < 0 || rightOffsetIdx < 0) {
      skippedMissingOffset++;
      continue;
    }

    const mergedId = normalizeId(mergedSurface);

    if (!nounsById.has(mergedId)) {
      nounsById.set(mergedId, {
        id: mergedId,
        surface: mergedSurface,
        source: 'merged',
        offsets: [],
        mergedFrom: [decision.leftId, decision.rightId],
      });
    }
    const mergedEntry = nounsById.get(mergedId);
    mergedEntry.offsets.push({ start, end });

    // 从原子词中移除已合并的偏移
    leftEntry.offsets.splice(leftOffsetIdx, 1);
    rightEntry.offsets.splice(rightOffsetIdx, 1);

    applied++;
  }

  console.log(`已应用合并: ${applied} 条`);
  console.log(`跳过（合并表面过长 >${MAX_MERGED_SURFACE_LEN}字符）: ${skippedTooLong} 条`);
  console.log(`跳过（偏移量对不上）: ${skippedMissingOffset} 条\n`);

  // 去重每个词条内的 offsets，并清理空词条
  let removedEmpty = 0;
  for (const [id, entry] of [...nounsById.entries()]) {
    const unique = new Map();
    for (const off of entry.offsets) {
      unique.set(`${off.start}-${off.end}`, off);
    }
    entry.offsets = [...unique.values()].sort((a, b) => a.start - b.start);
    if (entry.offsets.length === 0) {
      nounsById.delete(id);
      removedEmpty++;
    }
  }
  console.log(`清理空词条（所有出现均被合并走): ${removedEmpty} 个\n`);

  const finalEntries = [...nounsById.values()].sort(
    (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
  );

  const s0Count = finalEntries.filter((e) => e.source === 's0-spacy').length;
  const s1Count = finalEntries.filter((e) => e.source === 's1-llm').length;
  const mergedCount = finalEntries.filter((e) => e.source === 'merged').length;
  const totalOffsets = finalEntries.reduce((sum, e) => sum + e.offsets.length, 0);

  console.log('========== 终词表统计 ==========');
  console.log(`最终名词数: ${finalEntries.length} 个`);
  console.log(`  - s0 (spaCy): ${s0Count} 个`);
  console.log(`  - s1 (LLM补缺): ${s1Count} 个`);
  console.log(`  - merged (合并审查): ${mergedCount} 个`);
  console.log(`总位置数: ${totalOffsets} 处\n`);

  const output = {
    meta: {
      source: '终词表 = s0 + s1 + 合并审查',
      totalNouns: finalEntries.length,
      s0Count,
      s1Count,
      mergedCount,
      totalOffsets,
      mergeDecisionsApplied: applied,
      timestamp: new Date().toISOString(),
    },
    nouns: finalEntries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`输出文件: ${OUTPUT_PATH}`);

  console.log(`\n前20个合并词条示例:`);
  finalEntries
    .filter((e) => e.source === 'merged')
    .slice(0, 20)
    .forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.surface} (${e.offsets.length}次) [from: ${e.mergedFrom.join(' + ')}]`);
    });
}

main();
