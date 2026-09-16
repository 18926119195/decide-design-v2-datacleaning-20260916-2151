/**
 * s0-s1 合并脚本：将 spaCy (s0) 和 LLM (s1) 提取的名词合并去重
 *
 * 输入：
 *   1. spaCy 抽取结果（从 validate-s0-quality.js 的中间状态）
 *   2. s1-nouns-with-offsets.json（LLM 补缺结果）
 *
 * 输出：
 *   final-noun-index.json - 最终名词索引（含位置偏移量）
 *
 * 策略：
 *   - s0 优先（spaCy 结果为主干）
 *   - s1 补缺（LLM 提取的新名词）
 *   - 去重：按标准化 ID（小写+空格转下划线）
 *   - 保留所有位置偏移量（支持检索定位）
 */

import fs from 'fs';

const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const S1_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s1-nouns-with-offsets.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index.json';
const SPACY_URL = 'http://localhost:5001/extract_nouns';

// ---------- pureTextTable 构建（复用） ----------
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

// ---------- 标准化名词 ID ----------
function normalizeId(surface) {
  return surface.toLowerCase().trim().replace(/\s+/g, '_');
}

// ---------- 主流程 ----------
async function main() {
  console.log('========== s0 + s1 合并流程 ==========\n');

  // 1. 构建纯文表
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText;
  console.log(`纯文表: ${fullText.length} 字符\n`);

  // 2. 获取 s0 (spaCy) 名词
  console.log('调用 spaCy 获取 s0 名词...');
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
  // 关键修复：直接使用 spaCy 返回的 {surface, start, end}，不再对 surface
  // 做全文子串重新搜索（旧逻辑会把 "les/des/essence" 里的 "es" 子串也算命中，
  // 导致 "es" 这种碎片被错误统计为 13000+ 次）。
  const s0RawTokens = [
    ...spacyResult.nouns.map((n) => ({ surface: n.surface, start: n.start, end: n.end })),
    ...spacyResult.noun_phrases.map((p) => ({ surface: p.surface, start: p.start, end: p.end })),
  ];
  console.log(`s0 名词: ${s0RawTokens.length} 个（去重前，含偏移量）\n`);

  // 3. 读取 s1 (LLM) 补缺结果
  let s1Data = { nouns: [] };
  if (fs.existsSync(S1_PATH)) {
    s1Data = JSON.parse(fs.readFileSync(S1_PATH, 'utf-8'));
    console.log(`s1 补缺名词: ${s1Data.nouns.length} 个\n`);
  } else {
    console.log('s1 文件不存在，跳过补缺合并\n');
  }

  // 4. 合并去重
  const mergedNouns = new Map(); // id -> { id, surface, offsets, source }

  // 先加载 s0：直接使用 spaCy 原生返回的偏移量分组，不重新全文搜索
  for (const token of s0RawTokens) {
    const id = normalizeId(token.surface);
    if (id.length < 2) continue;

    if (!mergedNouns.has(id)) {
      mergedNouns.set(id, {
        id,
        surface: token.surface,
        offsets: [],
        source: 's0-spacy',
      });
    }
    mergedNouns.get(id).offsets.push({ start: token.start, end: token.end });
  }

  // 每个词条内部按 offset 去重（noun 和 noun_phrase 可能重复标记同一处）
  for (const entry of mergedNouns.values()) {
    const unique = new Map();
    for (const off of entry.offsets) {
      unique.set(`${off.start}-${off.end}`, off);
    }
    entry.offsets = [...unique.values()].sort((a, b) => a.start - b.start);
  }

  // 再加载 s1（跳过 s0 已有的）
  for (const s1Entry of s1Data.nouns) {
    if (mergedNouns.has(s1Entry.id)) continue;

    mergedNouns.set(s1Entry.id, {
      id: s1Entry.id,
      surface: s1Entry.surface,
      offsets: s1Entry.offsets,
      source: 's1-llm',
    });
  }

  // 5. 排序（按出现频次降序）
  const finalEntries = [...mergedNouns.values()].sort(
    (a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id),
  );

  // 6. 统计
  const s0Count = finalEntries.filter((e) => e.source === 's0-spacy').length;
  const s1Count = finalEntries.filter((e) => e.source === 's1-llm').length;
  const totalOffsets = finalEntries.reduce((sum, e) => sum + e.offsets.length, 0);

  console.log('========== 合并完成 ==========');
  console.log(`最终名词数: ${finalEntries.length} 个`);
  console.log(`  - s0 (spaCy): ${s0Count} 个`);
  console.log(`  - s1 (LLM补缺): ${s1Count} 个`);
  console.log(`总位置数: ${totalOffsets} 处`);
  console.log(`平均每词: ${(totalOffsets / Math.max(finalEntries.length, 1)).toFixed(1)} 处\n`);

  // 7. 输出
  const output = {
    meta: {
      source: 's0 + s1 合并',
      fullTextLength: fullText.length,
      totalNouns: finalEntries.length,
      s0Count,
      s1Count,
      totalOffsets,
      timestamp: new Date().toISOString(),
    },
    nouns: finalEntries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`输出文件: ${OUTPUT_PATH}`);

  console.log(`\n前20个高频名词:`);
  finalEntries.slice(0, 20).forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.surface} (${e.offsets.length}次) [${e.source}]`);
  });
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
