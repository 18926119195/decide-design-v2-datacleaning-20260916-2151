/**
 * s0 质量验证脚本
 *
 * 目的：把 spaCy 抽取的名词（作为 s0 候选）与"纯文表"逐位对比，
 * 计算覆盖率（命中率）与"剩余文"（未命中的截断），
 * 用于判断是否可以进入 LLM 兜底（s1 补缺）阶段。
 *
 * 用法：
 *   node validate-s0-quality.js <docuverse.json路径>
 */

import fs from 'fs';
import path from 'path';

const SPACY_URL = 'http://localhost:5001/extract_nouns';

const filePath = process.argv[2] ||
  'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';

// ---------- 1. 从 docuverse.json 构建"纯文表"（复刻 pureTextTable.ts 的核心逻辑，简化版） ----------

// 清理 HTML/Markdown 排版标记残留（<div>、<sup>、<table> 等），
// 与 src/core/text.ts 的 stripHtmlTags 保持一致，避免 spaCy 把标签文字
// 和真实词粘连成假名词（如 "/div"、"sup>1</sup"）。
function stripHtmlTags(text) {
  return text
    .replace(/<\/?(?:div|table|tr|td|th|thead|tbody|sup|sub|span|p|br)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');
}

// 清理 PDF→Markdown 转换残留的 LaTeX 数学公式片段（如 "\varphi_1"、"d^{+}$"），
// 避免被 s0 规则误判为名词（\Phi、\circ 等），污染名词表和拓扑邻域关系。
function stripLatexResidue(text) {
  return text
    .replace(/\$\$[^$]*\$\$/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+(?:\{[^{}]*\})*/g, ' ')
    .replace(/\\+/g, ' ')
    .replace(/[\^_]\{[^{}]*\}/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

function atomSearchText(chunk) {
  const text = chunk.faces?.text?.content?.trim();
  if (text && text.length >= 8) return stripLatexResidue(stripHtmlTags(text));
  const raw = (chunk.content || '').trim();
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8) return stripLatexResidue(stripHtmlTags(raw));
  if (text) return stripLatexResidue(stripHtmlTags(text));
  const note = (chunk.faces?.fig?.note || '').trim();
  return stripLatexResidue(stripHtmlTags(
    note
      .replace(/请依据可见版面回答[^。]*。?/g, '')
      .replace(/勿编造未提供的文字[^。]*。?/g, '')
      .replace(/无文字层\/未OCR[^。]*。?/g, '')
      .trim(),
  ));
}

function isRetrievableAtom(chunk) {
  const t = atomSearchText(chunk);
  if (t.length < 4) return false;
  if (chunk.kind === 'fig' && t.length < 24 && !chunk.faces?.text) return false;
  // 无OCR文字层的图脸占位说明（书名+Z-Library+页码+"无文字层/未OCR..."）
  // 超过24字符阈值会被误判为正文，导致 "Z-Library"/"p.39" 等书源元数据
  // 被当成名词抽取。这类占位没有真实版面内容，直接排除。
  if (chunk.kind === 'fig' && !chunk.faces?.text) {
    const rawNote = chunk.faces?.fig?.note || '';
    if (/无文字层|未OCR/.test(rawNote)) return false;
  }
  return true;
}

function buildPureTextTable(bookIndex) {
  const entries = [];
  let offset = 0;
  for (const chunk of bookIndex.chunks) {
    if (!isRetrievableAtom(chunk)) continue;
    const text = atomSearchText(chunk).trim();
    if (!text) continue;
    const startOffset = offset;
    const endOffset = offset + text.length;
    entries.push({ chunkKey: chunk.key, page: chunk.page, text, startOffset, endOffset });
    offset = endOffset + 1;
  }
  const fullText = entries.map((e) => e.text).join('\n');
  return { fullText, entries };
}

// ---------- 2. 逐位标注：把 s0 (spaCy) 名词在 fullText 中定位，标记命中区间 ----------

function locateSurfacesInText(fullText, surfaces) {
  const fullTextLower = fullText.toLowerCase();
  const hitMask = new Array(fullText.length).fill(false);
  const hits = []; // { surface, start, end }

  // 按长度降序，优先长词占位，避免短词吞掉长词命中范围的统计
  const uniqueSurfaces = [...new Set(surfaces)].sort((a, b) => b.length - a.length);

  for (const surface of uniqueSurfaces) {
    const needle = surface.toLowerCase().trim();
    if (needle.length < 2) continue;
    let from = 0;
    while (from < fullTextLower.length) {
      const at = fullTextLower.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      // 只在尚未被标记的区域记录命中（避免重复统计覆盖）
      let alreadyHit = false;
      for (let i = at; i < end; i++) {
        if (hitMask[i]) { alreadyHit = true; break; }
      }
      if (!alreadyHit) {
        for (let i = at; i < end; i++) hitMask[i] = true;
        hits.push({ surface, start: at, end });
      }
      from = at + 1;
    }
  }

  return { hitMask, hits };
}

// ---------- 3. 从命中掩码提取"剩余文"（未命中的有序截断） ----------

function extractResidualTruncations(fullText, hitMask, minLen = 10) {
  const truncations = [];
  let i = 0;
  while (i < fullText.length) {
    if (!hitMask[i]) {
      let j = i;
      while (j < fullText.length && !hitMask[j]) j++;
      const text = fullText.slice(i, j).trim();
      if (text.length >= minLen) {
        truncations.push({ start: i, end: j, text });
      }
      i = j;
    } else {
      i++;
    }
  }
  return truncations;
}

// ---------- 主流程 ----------

async function main() {
  console.log('读取语料文件:', filePath);
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  if (data.kind !== 'docuverse-corpus' || !data.bookIndex?.chunks) {
    console.error('不是有效的 docuverse-corpus 文件，或缺少 bookIndex.chunks');
    process.exit(1);
  }

  const pureTextTable = buildPureTextTable(data.bookIndex);
  const fullText = pureTextTable.fullText;
  console.log(`纯文表构建完成：全文 ${fullText.length} 字，chunks ${pureTextTable.entries.length} 个`);

  // 调用 spaCy 获取 s0 候选名词
  console.log('调用 spaCy 抽取名词...');
  const spacyRes = await fetch(SPACY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: fullText,
      include_proper_nouns: true,
      include_nouns: true,
      min_length: 2,
    }),
  });
  const spacyResult = await spacyRes.json();
  const nounSurfaces = spacyResult.nouns.map((n) => n.surface);
  const phraseSurfaces = spacyResult.noun_phrases.map((p) => p.surface);
  const allSurfaces = [...nounSurfaces, ...phraseSurfaces];
  console.log(`spaCy 抽取: 名词 ${nounSurfaces.length} 个（去重前），短语 ${phraseSurfaces.length} 个`);

  // 逐位对比
  const { hitMask, hits } = locateSurfacesInText(fullText, allSurfaces);
  const hitChars = hitMask.filter(Boolean).length;
  const coverage = (hitChars / fullText.length * 100).toFixed(2);

  // 剩余文（未命中截断）
  const residuals = extractResidualTruncations(fullText, hitMask, 10);
  const residualChars = residuals.reduce((s, r) => s + r.text.length, 0);

  console.log('\n========== 质量报告 ==========');
  console.log(`全文长度: ${fullText.length} 字符`);
  console.log(`命中字符数: ${hitChars} (${coverage}%)`);
  console.log(`命中词条数(去重后): ${hits.length}`);
  console.log(`剩余文(截断)数量: ${residuals.length}`);
  console.log(`剩余文总字符数: ${residualChars} (${(residualChars / fullText.length * 100).toFixed(2)}%)`);
  console.log(`平均截断长度: ${(residualChars / Math.max(residuals.length, 1)).toFixed(1)} 字符`);

  // 输出报告文件（含剩余文样例，供人工审查）
  const report = {
    sourceFile: path.basename(filePath),
    fullTextLength: fullText.length,
    hitChars,
    coveragePercent: Number(coverage),
    hitCount: hits.length,
    residualCount: residuals.length,
    residualChars,
    residualPercent: Number((residualChars / fullText.length * 100).toFixed(2)),
    avgResidualLen: Number((residualChars / Math.max(residuals.length, 1)).toFixed(1)),
    residualSamples: residuals.slice(0, 50).map((r) => ({
      start: r.start,
      end: r.end,
      length: r.text.length,
      text: r.text.slice(0, 200),
    })),
    residualLongest: [...residuals].sort((a, b) => b.text.length - a.text.length).slice(0, 20).map((r) => ({
      start: r.start,
      end: r.end,
      length: r.text.length,
      text: r.text.slice(0, 300),
    })),
  };

  const outPath = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-quality-report.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\n完整报告已写入: ${outPath}`);

  // ---------- 3.5 输出 s0 命中位置表（供 s1 补缺去重/防污染使用） ----------
  // 只存位置区间，不存整个 hitMask 位图（598142字符的布尔数组太大不适合JSON）
  const s0HitsPath = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-hits.json';
  const s0HitsOutput = {
    fullTextLength: fullText.length,
    hitCount: hits.length,
    // 按起始位置排序，供二分查找/区间重叠检测使用
    hits: hits
      .map((h) => ({ surface: h.surface, id: h.surface.toLowerCase().trim(), start: h.start, end: h.end }))
      .sort((a, b) => a.start - b.start),
  };
  fs.writeFileSync(s0HitsPath, JSON.stringify(s0HitsOutput), 'utf-8');
  console.log(`s0 命中位置表已写入: ${s0HitsPath}（${hits.length} 条，供 s1 去重防污染）`);

  // ---------- 4. 剩余文分类：HTML噪声 / 纯功能词(虚词) / 疑似漏词 ----------
  function classifyResidual(text) {
    if (/<\/?(td|tr|tbody|table|th)>/i.test(text)) return 'html_noise';
    // 纯功能词/连接词/标点组合（无法构成实词候选）：几乎全是虚词+标点，没有连续4+字母的"内容词"残段在边界之外
    const contentWordMatch = text.match(/[a-zA-ZÀ-ÿ]{4,}/g) || [];
    // 如果所有连续字母段都是常见虚词/动词变位，视为功能词间隙
    const FUNC_WORDS = new Set(['plutot','plutôt','renoncent','impliquant','qualifies','qualifiés','robotique','aborigenes','aborigènes','cherche','cherché','apprehender','appréhender']);
    const hasLongContentWord = contentWordMatch.some((w) => w.length >= 6);
    if (contentWordMatch.length === 0) return 'pure_function_word';
    if (hasLongContentWord) return 'possible_missed_noun';
    return 'short_function_word';
  }

  const classified = { html_noise: 0, pure_function_word: 0, short_function_word: 0, possible_missed_noun: 0 };
  const classifiedChars = { html_noise: 0, pure_function_word: 0, short_function_word: 0, possible_missed_noun: 0 };
  const missedNounSamples = [];
  for (const r of residuals) {
    const cls = classifyResidual(r.text);
    classified[cls]++;
    classifiedChars[cls] += r.text.length;
    if (cls === 'possible_missed_noun' && missedNounSamples.length < 40) {
      missedNounSamples.push({ start: r.start, length: r.text.length, text: r.text });
    }
  }

  console.log('\n========== 剩余文分类 ==========');
  console.log(`HTML表格噪声: ${classified.html_noise} 个截断, ${classifiedChars.html_noise} 字符`);
  console.log(`纯虚词/标点间隙: ${classified.pure_function_word} 个截断, ${classifiedChars.pure_function_word} 字符`);
  console.log(`短虚词间隙: ${classified.short_function_word} 个截断, ${classifiedChars.short_function_word} 字符`);
  console.log(`疑似漏词(含≥6字母实词残段): ${classified.possible_missed_noun} 个截断, ${classifiedChars.possible_missed_noun} 字符`);

  report.classified = classified;
  report.classifiedChars = classifiedChars;
  report.missedNounSamples = missedNounSamples;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n========== 结论建议 ==========');
  if (Number(coverage) >= 70) {
    console.log('✅ 覆盖率较高，s0 质量基本可控，可以考虑进入 s1 (LLM兜底) 阶段处理剩余文。');
  } else if (Number(coverage) >= 40) {
    console.log('⚠️ 覆盖率中等，s0 存在明显遗漏，建议先检查残留文样例，判断是规则问题还是本来就是非名词内容。');
  } else {
    console.log('❌ 覆盖率偏低，不建议直接进入 s1，应先修正 s0 规则/模型。');
  }
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
