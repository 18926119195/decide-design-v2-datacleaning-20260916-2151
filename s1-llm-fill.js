/**
 * s1 LLM 兜底补缺脚本（高速并行版）
 *
 * 策略：
 * 1. 从 s0-quality-report.json 读取"疑似漏词"截断
 * 2. **批量合并**：将多个短截断合并到一个LLM请求中（减少网络往返）
 * 3. **并行批处理**：多个批次同时调用LLM（提速）
 * 4. **保留位置索引**：每个提取的名词记录其在纯文表中的精确偏移量
 * 5. **输出带位置的名词表**：供后续检索直接定位
 *
 * 用法：
 *   node s1-llm-fill.js
 */

import fs from 'fs';

const REPORT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-quality-report.json';
const S0_HITS_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s0-hits.json';
const DOCUVERSE_PATH = 'C:\\Users\\Administrator\\Desktop\\docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari_1789114122714.docuverse.json';
const OUTPUT_PATH = 'C:\\Users\\Administrator\\Desktop\\decide-design-v2-main\\s1-nouns-with-offsets.json';

// ---------- LLM 配置 ----------
// 支持项目约定的 .env 变量（LLM_API_KEY / LLM_BASE_URL / LLM_MODEL，DeepSeek等OpenAI兼容服务）
// 同时兼容 OPENAI_API_KEY / ANTHROPIC_API_KEY 写法
const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (LLM_PROVIDER === 'anthropic' ? 'claude-3-5-haiku-20241022' : 'gpt-4o-mini');
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

// ---------- 并行控制 ----------
const CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '5', 10); // 同时调用5个LLM请求
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '8', 10); // 每个请求合并8个截断
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity; // 测试用：限制处理的截断总数

// ---------- 复刻 pureTextTable 构建逻辑 ----------
// 清理 HTML/Markdown 排版标记残留（<div>、<sup>、<table> 等），
// 与 src/core/text.ts 的 stripHtmlTags 保持一致，避免污染截断文本。
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

// ---------- LLM 调用封装（带429限流重试+指数退避） ----------
async function callLLM(prompt, signal, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000; // 初始延迟2秒
  
  try {
    if (LLM_PROVIDER === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });

      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        console.warn(`[429限流] 等待 ${delay}ms 后重试 (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callLLM(prompt, signal, retryCount + 1);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Anthropic API 错误 ${response.status}: ${text}`);
      }

      const data = await response.json();
      return data.content[0]?.text || '';
    } else {
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
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });

      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, retryCount);
        console.warn(`[429限流] 等待 ${delay}ms 后重试 (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return callLLM(prompt, signal, retryCount + 1);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API 错误 ${response.status}: ${text}`);
      }

      const data = await response.json();
      return data.choices[0]?.message?.content || '';
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[网络错误] ${err.message}，等待 ${delay}ms 后重试...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callLLM(prompt, signal, retryCount + 1);
    }
    throw err;
  }
}

// ---------- 批量提示词构建（多个截断合并） ----------
function buildBatchPrompt(truncations) {
  const sections = truncations.map((trunc, idx) => {
    return `[截断${idx + 1}] (位置 ${trunc.start}-${trunc.end})\n${trunc.text}`;
  }).join('\n\n');

  return `你是一个精确的语言学名词提取器。请从以下多个文本截断中提取**所有名词性成分**（名词、专有名词、名词短语）。

**核心要求**：
1. 只提取名词及名词短语（包括复合名词、专有名词、术语）
2. **不要**提取纯动词、形容词、副词、连接词
3. 保持原文形式（含重音符号、大小写）
4. 每个截断独立处理，返回时标注截断编号

**输出格式**（严格JSON数组）：
\`\`\`json
[
  {"trunc_id": 1, "nouns": ["名词1", "名词2"]},
  {"trunc_id": 2, "nouns": ["名词3"]}
]
\`\`\`

**待处理截断**：

${sections}

请返回JSON数组（只返回JSON，不要其他文字）：`;
}

// ---------- 解析批量LLM输出 ----------
function parseBatchLLMOutput(rawOutput, batchIdForDebug) {
  // 提取JSON块（优先匹配```json```包裹，然后匹配纯数组）
  let jsonText = '';
  const codeBlockMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    jsonText = codeBlockMatch[1];
  } else {
    const arrayMatch = rawOutput.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      jsonText = arrayMatch[0];
    }
  }

  if (!jsonText) {
    console.warn(`LLM输出无法解析JSON，返回空结果 (批次 ${batchIdForDebug})`);
    console.warn('原始输出:', rawOutput.slice(0, 500));
    return [];
  }

  try {
    // 尝试修复常见JSON格式错误（缺失闭合括号、尾部逗号等）
    let fixed = jsonText.trim();
    
    // 如果JSON不完整（缺少闭合括号），尝试补全
    const openBrackets = (fixed.match(/\[/g) || []).length;
    const closeBrackets = (fixed.match(/\]/g) || []).length;
    const openBraces = (fixed.match(/\{/g) || []).length;
    const closeBraces = (fixed.match(/\}/g) || []).length;
    
    if (openBrackets > closeBrackets) {
      // 补充缺失的 }]
      if (openBraces > closeBraces) fixed += '}';
      fixed += ']';
      console.warn(`[批次 ${batchIdForDebug}] 检测到JSON不完整，尝试自动修复: 补充闭合括号`);
    }

    const parsed = JSON.parse(fixed);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      trunc_id: item.trunc_id || 0,
      nouns: (item.nouns || []).filter((n) => typeof n === 'string' && n.trim().length >= 2),
    }));
  } catch (err) {
    console.warn(`JSON解析失败 (批次 ${batchIdForDebug}):`, err.message);
    console.warn('原始输出:', rawOutput.slice(0, 500));
    return [];
  }
}

// ---------- 名词质量过滤规则 ----------
function isValidNoun(noun) {
  const trimmed = noun.trim();
  
  // 规则1: 长度过短（<3字符），除非是全大写缩写
  if (trimmed.length < 3 && !/^[A-Z]{2,}$/.test(trimmed)) {
    return false;
  }
  
  // 规则2: 纯标点或数字
  if (/^[\d\s\p{P}]+$/u.test(trimmed)) {
    return false;
  }
  
  // 规则3: 常见前缀（法语/英语）
  const prefixes = ['pré-', 'anti-', 'ex-', 'post-', 'néo-', 'proto-', 'pseudo-', 're-', 'sub-', 'super-'];
  if (prefixes.some(prefix => trimmed.toLowerCase() === prefix.slice(0, -1))) {
    return false;
  }
  
  // 规则4: 停用词扩展（法语/英语常见虚词）
  const stopwords = [
    'ou', 'et', 'de', 'des', 'le', 'la', 'les', 'un', 'une',
    'of', 'the', 'a', 'an', 'and', 'or', 'to', 'in', 'on',
    'pl', 'pré', 'ex', 'et', 'ou', 'de'
  ];
  if (stopwords.includes(trimmed.toLowerCase())) {
    return false;
  }
  
  // 规则5: 单字母（除非大写）
  if (trimmed.length === 1 && !/[A-Z]/.test(trimmed)) {
    return false;
  }
  
  return true;
}

// ---------- 在纯文表中定位名词偏移量（支持上下文窗口，防污染检查） ----------
function locateNounInFullText(noun, fullText, truncStart, truncEnd, contextWindow = 50, s0HitIntervals = []) {
  // 质量过滤：直接拒绝低质量名词
  if (!isValidNoun(noun)) {
    return [];
  }
  
  const fullTextLower = fullText.toLowerCase();
  const needle = noun.toLowerCase().trim();
  const offsets = [];

  // 优先在截断范围±contextWindow内搜索
  const searchStart = Math.max(0, truncStart - contextWindow);
  const searchEnd = Math.min(fullText.length, truncEnd + contextWindow);
  const searchRegion = fullText.slice(searchStart, searchEnd);
  const searchRegionLower = searchRegion.toLowerCase();

  let from = 0;
  while (from < searchRegionLower.length) {
    const at = searchRegionLower.indexOf(needle, from);
    if (at < 0) break;

    const globalStart = searchStart + at;
    const globalEnd = globalStart + needle.length;

    // 防污染检查：如果这个位置与 s0 已命中区间重叠，跳过（避免重复提取s0已覆盖的词）
    const overlapsS0 = s0HitIntervals.some((interval) => {
      return !(globalEnd <= interval.start || globalStart >= interval.end);
    });

    if (!overlapsS0) {
      // 位置置信度检查：如果位置落在截断±contextWindow之外，标记为低置信度
      const inOriginalTrunc = globalStart >= truncStart && globalEnd <= truncEnd;
      const inContextWindow = globalStart >= searchStart && globalEnd <= searchEnd;
      offsets.push({
        start: globalStart,
        end: globalEnd,
        confidence: inOriginalTrunc ? 'high' : (inContextWindow ? 'medium' : 'low'),
      });
    }

    from = at + needle.length;
  }

  // 如果在截断附近未找到，尝试全文搜索（但限制数量，避免过度匹配）
  if (offsets.length === 0) {
    let from = 0;
    while (from < fullTextLower.length && offsets.length < 5) {
      const at = fullTextLower.indexOf(needle, from);
      if (at < 0) break;
      
      const globalStart = at;
      const globalEnd = at + needle.length;
      
      const overlapsS0 = s0HitIntervals.some((interval) => {
        return !(globalEnd <= interval.start || globalStart >= interval.end);
      });
      
      if (!overlapsS0) {
        offsets.push({ start: globalStart, end: globalEnd, confidence: 'low' });
      }
      
      from = at + needle.length;
    }
  }

  return offsets;
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
        const prompt = buildBatchPrompt(batch.truncations);
        const rawOutput = await callLLM(prompt);
        const parsed = parseBatchLLMOutput(rawOutput, batch.batchId);

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
    console.error('缺少API密钥，请设置环境变量 OPENAI_API_KEY 或 ANTHROPIC_API_KEY');
    process.exit(1);
  }

  console.log('========== s1 LLM 兜底补缺 ==========');
  console.log(`LLM: ${LLM_PROVIDER} / ${MODEL}`);
  console.log(`并发数: ${CONCURRENCY}, 批量大小: ${BATCH_SIZE}\n`);

  // 1. 读取 s0 质量报告
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
  const missedNounSamples = report.missedNounSamples || [];

  if (missedNounSamples.length === 0) {
    console.log('无疑似漏词，无需补缺');
    process.exit(0);
  }

  // 1.1. 读取 s0 命中位置表（用于去重防污染）
  let s0HitIntervals = [];
  try {
    const s0Hits = JSON.parse(fs.readFileSync(S0_HITS_PATH, 'utf-8'));
    s0HitIntervals = s0Hits.hits || [];
    console.log(`加载 s0 命中位置表: ${s0HitIntervals.length} 条区间，用于防污染去重\n`);
  } catch (err) {
    console.warn(`⚠️  无法加载 s0-hits.json (${err.message})，跳过防污染检查\n`);
  }

  const truncationsToProcess = Number.isFinite(LIMIT) ? missedNounSamples.slice(0, LIMIT) : missedNounSamples;
  console.log(`读取疑似漏词: ${missedNounSamples.length} 个截断（本次处理 ${truncationsToProcess.length} 个）\n`);

  // 2. 构建纯文表
  const docuverse = JSON.parse(fs.readFileSync(DOCUVERSE_PATH, 'utf-8'));
  const pureTextTable = buildPureTextTable(docuverse.bookIndex);
  const fullText = pureTextTable.fullText;
  console.log(`纯文表构建完成: ${fullText.length} 字符\n`);

  // 3. 分批（每批BATCH_SIZE个截断）
  const batches = [];
  for (let i = 0; i < truncationsToProcess.length; i += BATCH_SIZE) {
    const batchTruncations = truncationsToProcess.slice(i, i + BATCH_SIZE);
    batches.push({
      batchId: Math.floor(i / BATCH_SIZE) + 1,
      truncations: batchTruncations,
    });
  }

  console.log(`分批完成: ${batches.length} 批 (每批最多${BATCH_SIZE}个截断)\n`);
  console.log('开始并行调用LLM...\n');

  // 4. 并行处理
  const startTime = Date.now();
  const batchResults = await processBatchesParallel(batches, CONCURRENCY);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\nLLM调用完成，耗时 ${elapsed}s\n`);

  // 5. 聚合结果：解析名词并定位偏移量
  const s1Nouns = new Map(); // id -> { surface, offsets: [{start, end}], sourceTruncIds: [] }

  for (const batchResult of batchResults) {
    if (!batchResult.ok) continue;

    const batch = batches.find((b) => b.batchId === batchResult.batchId);
    if (!batch) continue;

    for (const item of batchResult.parsed) {
      const truncIndex = item.trunc_id - 1;
      if (truncIndex < 0 || truncIndex >= batch.truncations.length) continue;

      const trunc = batch.truncations[truncIndex];
      for (const noun of item.nouns) {
        const id = noun.toLowerCase().trim().replace(/\s+/g, '_');
        if (id.length < 2) continue;

        const offsets = locateNounInFullText(noun, fullText, trunc.start, trunc.start + trunc.length, 50, s0HitIntervals);

        if (offsets.length === 0) {
          console.warn(`名词"${noun}"在纯文表中未找到位置或与s0重叠（截断 ${trunc.start}）`);
          continue;
        }

        if (!s1Nouns.has(id)) {
          s1Nouns.set(id, {
            id,
            surface: noun,
            offsets: [],
            sourceTruncIds: [],
          });
        }

        const entry = s1Nouns.get(id);
        entry.offsets.push(...offsets);
        entry.sourceTruncIds.push(trunc.start);
      }
    }
  }

  // 6. 去重 offsets + 统计置信度
  const confidenceStats = { high: 0, medium: 0, low: 0 };
  
  for (const entry of s1Nouns.values()) {
    const uniqueOffsets = new Map();
    for (const offset of entry.offsets) {
      const key = `${offset.start}-${offset.end}`;
      uniqueOffsets.set(key, offset);
      confidenceStats[offset.confidence] = (confidenceStats[offset.confidence] || 0) + 1;
    }
    entry.offsets = [...uniqueOffsets.values()].sort((a, b) => a.start - b.start);
    entry.sourceTruncIds = [...new Set(entry.sourceTruncIds)].sort((a, b) => a - b);
  }

  const s1Entries = [...s1Nouns.values()].sort((a, b) => b.offsets.length - a.offsets.length || a.id.localeCompare(b.id));

  // 7. 输出报告
  const output = {
    meta: {
      source: 's1 LLM兜底补缺',
      llmProvider: LLM_PROVIDER,
      model: MODEL,
      concurrency: CONCURRENCY,
      batchSize: BATCH_SIZE,
      inputTruncations: truncationsToProcess.length,
      totalMissedNounSamples: missedNounSamples.length,
      outputNouns: s1Entries.length,
      totalOffsets: s1Entries.reduce((sum, e) => sum + e.offsets.length, 0),
      elapsedSeconds: parseFloat(elapsed),
      s0IntervalCount: s0HitIntervals.length,
      confidenceStats,
      deduplicationInfo: s0HitIntervals.length > 0 
        ? `已过滤与 s0 重叠的位置（基于 ${s0HitIntervals.length} 个s0命中区间）`
        : '未加载 s0-hits.json，未执行防污染过滤',
    },
    nouns: s1Entries,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf-8');

  console.log('========== 补缺完成 ==========');
  console.log(`补缺名词数: ${s1Entries.length} 个`);
  console.log(`总命中位置: ${output.meta.totalOffsets} 处`);
  console.log(`平均每词命中: ${(output.meta.totalOffsets / Math.max(s1Entries.length, 1)).toFixed(1)} 处`);
  console.log(`位置置信度: 高=${confidenceStats.high}, 中=${confidenceStats.medium}, 低=${confidenceStats.low}`);
  console.log(`防污染: ${output.meta.deduplicationInfo}`);
  console.log(`输出文件: ${OUTPUT_PATH}`);
  console.log(`\n前10个补缺名词（按命中位置数排序）:`);
  s1Entries.slice(0, 10).forEach((e, i) => {
    console.log(`  ${i + 1}. ${e.surface} (命中${e.offsets.length}处)`);
  });
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
