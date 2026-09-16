/**
 * 合并审查 LLM 脚本
 *
 * 职责：检查 final-noun-index.json 中「位置相邻/偏移连续」的名词对，
 * 调用 LLM 判断是否应合并为复合名词（如 "cartographie" + "schizoanalytique"
 * → "cartographie schizoanalytique"）。
 *
 * 输入：
 *   final-noun-index.json  (s0 + s1 合并后的初步终词表)
 *
 * 输出：
 *   merge-review-result.json  (合并决策 + 最终终词表)
 *
 * 用法：
 *   node merge-review-llm.js
 */

import fs from 'fs';

const FINAL_INDEX_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\final-noun-index.json';
const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\merge-review-result.json';

// ---------- LLM 配置（复用 .env 约定） ----------
const API_KEY = process.env.LLM_API_KEY || '';
const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

// ---------- 并行控制 ----------
const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '5', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '10', 10); // 每次请求打包N对候选
const ADJACENCY_TOLERANCE = 3; // 左词end到右词start的最大间隙（字符数）
const CONTEXT_WINDOW = 40; // 上下文左右各扩展的字符数
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;

// ---------- 复刻 pureTextTable 构建逻辑（与 merge-s0-s1.js 保持一致） ----------
// 清理 HTML/Markdown 排版标记残留（<div>、<sup>、<table> 等），
// 与 src/core/text.ts 的 stripHtmlTags 保持一致，避免污染上下文。
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

// ---------- LLM 调用封装（带429限流重试） ----------
async function callLLM(prompt, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000;

  try {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        max_tokens: 4096,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[429限流] 等待 ${delay}ms 后重试...`);
      await new Promise((r) => setTimeout(r, delay));
      return callLLM(prompt, retryCount + 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM API 错误 ${response.status}: ${text.slice(0, 300)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[网络错误] ${err.message}，等待 ${delay}ms 后重试...`);
      await new Promise((r) => setTimeout(r, delay));
      return callLLM(prompt, retryCount + 1);
    }
    throw err;
  }
}

// ---------- 检测候选合并对（位置相邻且偏移连续） ----------
function detectMergeCandidates(nouns, fullText) {
  // 构建：按 start 偏移索引到名词条目
  const startIndex = new Map(); // start -> [entry, ...]
  for (const entry of nouns) {
    for (const off of entry.offsets) {
      if (!startIndex.has(off.start)) startIndex.set(off.start, []);
      startIndex.get(off.start).push(entry);
    }
  }

  const candidates = [];
  const seenPairs = new Set();

  for (const leftEntry of nouns) {
    for (const leftOff of leftEntry.offsets) {
      for (let gap = 0; gap <= ADJACENCY_TOLERANCE; gap++) {
        const rightStart = leftOff.end + gap;
        const rightEntries = startIndex.get(rightStart) || [];

        for (const rightEntry of rightEntries) {
          if (rightEntry.id === leftEntry.id) continue;

          const pairKey = `${leftEntry.id}|${rightEntry.id}|${leftOff.start}`;
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          // 找到对应的右词 offset（start == rightStart）
          const rightOff = rightEntry.offsets.find((o) => o.start === rightStart);
          if (!rightOff) continue;

          const contextStart = Math.max(0, leftOff.start - CONTEXT_WINDOW);
          const contextEnd = Math.min(fullText.length, rightOff.end + CONTEXT_WINDOW);
          const context = fullText.slice(contextStart, contextEnd);

          candidates.push({
            leftId: leftEntry.id,
            rightId: rightEntry.id,
            leftSurface: leftEntry.surface,
            rightSurface: rightEntry.surface,
            leftEnd: leftOff.end,
            rightStart: rightOff.start,
            leftStart: leftOff.start,
            rightEnd: rightOff.end,
            gap,
            context,
          });
        }
      }
    }
  }

  return candidates;
}

// ---------- 批量提示词构建 ----------
function buildBatchPrompt(pairs) {
  const sections = pairs
    .map((p, idx) => {
      return `[候选${idx + 1}]\n左词："${p.leftSurface}"\n右词："${p.rightSurface}"\n上下文："${p.context}"`;
    })
    .join('\n\n');

  return `你是语言学专家，任务是判断相邻的两个名词是否应该合并为一个复合名词/名词短语。

判断规则：
1. 如果两词在上下文中紧密相连、共同表达一个完整概念，应合并（如 "cartographie" + "schizoanalytique" → "cartographie schizoanalytique"）
2. 如果两词只是偶然相邻但语义独立（如分属不同句子、不同短语），不应合并
3. 中间可能夹杂重音符号缺失、空格差异等OCR问题，请依据上下文语义判断，不要仅凭字面

**候选对**：

${sections}

请按顺序对每个候选给出判断，严格返回JSON数组（不要其他文字）：
\`\`\`json
[
  {"idx": 1, "should_merge": true, "merged_surface": "合并后的完整表面形式"},
  {"idx": 2, "should_merge": false, "merged_surface": null}
]
\`\`\``;
}

// ---------- 解析批量LLM输出 ----------
function parseBatchOutput(rawOutput, batchIdForDebug) {
  let jsonText = '';
  const codeBlockMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1];
  } else {
    const arrayMatch = rawOutput.match(/\[[\s\S]*\]/);
    if (arrayMatch) jsonText = arrayMatch[0];
  }

  if (!jsonText) {
    console.warn(`LLM输出无法解析JSON (批次 ${batchIdForDebug})`);
    return [];
  }

  try {
    let fixed = jsonText.trim();
    const openBrackets = (fixed.match(/\[/g) || []).length;
    const closeBrackets = (fixed.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) fixed += ']';
    const parsed = JSON.parse(fixed);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.warn(`JSON解析失败 (批次 ${batchIdForDebug}):`, err.message);
    console.warn('原始输出:', rawOutput.slice(0, 400));
    return [];
  }
}

// ---------- 并行批处理 ----------
async function processBatchesParallel(batches, concurrency) {
  const results = [];
  const queue = [...batches];
  let completed = 0;

  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    while (queue.length > 0) {
      const batch = queue.shift();
      if (!batch) break;

      try {
        const prompt = buildBatchPrompt(batch.pairs);
        const rawOutput = await callLLM(prompt);
        const parsed = parseBatchOutput(rawOutput, batch.batchId);
        completed++;
        console.log(`[Worker ${workerId}] 批次 ${batch.batchId} 完成 (${completed}/${batches.length})`);
        results.push({ batchId: batch.batchId, parsed, ok: true });
      } catch (err) {
        console.error(`[Worker ${workerId}] 批次 ${batch.batchId} 失败:`, err.message);
        results.push({ batchId: batch.batchId, ok: false, error: err.message });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------- 主流程 ----------
async function main() {
  if (!API_KEY) {
    console.error('缺少 LLM_API_KEY，请检查 .env');
    process.exit(1);
  }

  console.log('========== 合并审查 LLM ==========');
  console.log(`LLM: ${BASE_URL} / ${MODEL}`);
  console.log(`并发数: ${CONCURRENCY}, 批量大小: ${BATCH_SIZE}\n`);

  // 1. 读取终词表（s0+s1）
  const finalIndex = JSON.parse(fs.readFileSync(FINAL_INDEX_PATH, 'utf-8'));
  const nouns = finalIndex.nouns;
  console.log(`读取终词表: ${nouns.length} 个名词\n`);

  // 2. 构建纯文表（用于取上下文）
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText;
  console.log(`纯文表: ${fullText.length} 字符\n`);

  // 3. 检测候选合并对
  console.log('检测相邻候选合并对...');
  let candidates = detectMergeCandidates(nouns, fullText);
  console.log(`候选合并对: ${candidates.length} 组\n`);

  if (Number.isFinite(LIMIT)) {
    candidates = candidates.slice(0, LIMIT);
    console.log(`（受 LIMIT 限制，本次仅处理前 ${candidates.length} 组）\n`);
  }

  if (candidates.length === 0) {
    console.log('无候选合并对，流程结束。');
    fs.writeFileSync(
      OUTPUT_PATH,
      JSON.stringify({ meta: { candidateCount: 0 }, decisions: [] }, null, 2),
      'utf-8',
    );
    return;
  }

  // 4. 分批
  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batches.push({
      batchId: Math.floor(i / BATCH_SIZE) + 1,
      pairs: candidates.slice(i, i + BATCH_SIZE),
    });
  }
  console.log(`分批完成: ${batches.length} 批（每批最多${BATCH_SIZE}对）\n`);
  console.log('开始并行调用LLM...\n');

  // 5. 并行处理
  const startTime = Date.now();
  const batchResults = await processBatchesParallel(batches, CONCURRENCY);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nLLM调用完成，耗时 ${elapsed}s\n`);

  // 6. 汇总决策
  const decisions = [];
  let mergeCount = 0;

  for (const batchResult of batchResults) {
    if (!batchResult.ok) continue;
    const batch = batches.find((b) => b.batchId === batchResult.batchId);
    if (!batch) continue;

    for (const item of batchResult.parsed) {
      const pairIndex = (item.idx || 0) - 1;
      if (pairIndex < 0 || pairIndex >= batch.pairs.length) continue;
      const pair = batch.pairs[pairIndex];

      const decision = {
        leftId: pair.leftId,
        rightId: pair.rightId,
        leftSurface: pair.leftSurface,
        rightSurface: pair.rightSurface,
        offsets: { start: pair.leftStart, end: pair.rightEnd },
        context: pair.context,
        should_merge: !!item.should_merge,
        merged_surface: item.should_merge ? item.merged_surface : null,
      };
      decisions.push(decision);
      if (decision.should_merge) mergeCount++;
    }
  }

  console.log('========== 合并审查完成 ==========');
  console.log(`候选对: ${candidates.length} 组`);
  console.log(`判定为合并: ${mergeCount} 组`);
  console.log(`判定为不合并: ${decisions.length - mergeCount} 组\n`);

  const output = {
    meta: {
      source: '合并审查 LLM',
      model: MODEL,
      candidateCount: candidates.length,
      decisionCount: decisions.length,
      mergeCount,
      elapsedSeconds: parseFloat(elapsed),
      timestamp: new Date().toISOString(),
    },
    decisions,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`输出文件: ${OUTPUT_PATH}`);

  console.log(`\n前20个合并判定示例:`);
  decisions
    .filter((d) => d.should_merge)
    .slice(0, 20)
    .forEach((d, i) => {
      console.log(`  ${i + 1}. "${d.leftSurface}" + "${d.rightSurface}" → "${d.merged_surface}"`);
    });
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
