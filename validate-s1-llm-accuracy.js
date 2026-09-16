// ========== s1 LLM补缺准确率验证 ==========
// 对比两种方式：
// 1. 当前s1流程：批量+上下文窗口 → LLM提取
// 2. 基准方式：单个截断 → 直接问LLM"这是什么词"
// 验证批量处理是否会降低提取准确率

import fs from 'fs';

const QUALITY_REPORT_PATH = './s0-quality-report.json';
const S1_OUTPUT_PATH = './s1-nouns-with-offsets.json';
const VALIDATION_LIMIT = parseInt(process.env.LIMIT || '20', 10); // 默认验证前20个

// 环境变量配置（与 s1-llm-fill.js 保持一致，支持 .env 里的 LLM_API_KEY/LLM_BASE_URL）
const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-flash';
const API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
const BASE_URL = process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';

if (!API_KEY) {
  console.error('错误: 缺少API密钥 (LLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY)');
  process.exit(1);
}

// ---------- 直接用 fetch 调用 LLM（不依赖第三方SDK） ----------
async function callLLM(prompt) {
  if (LLM_PROVIDER === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 256,
        temperature: 0.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API错误 ${response.status}: ${await response.text()}`);
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
        model: LLM_MODEL,
        temperature: 0.1,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API错误 ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }
}

// ---------- 单独询问LLM每个截断的名词（基准方式）----------
async function askLLMDirectly(truncText) {
  const prompt = `这是一个法语文本截断片段："${truncText}"

请判断其中是否包含**名词**（包括普通名词、专有名词、术语）。

如果包含名词，返回JSON格式：{"nouns": ["词1", "词2"]}
如果只是虚词/标点/动词，返回：{"nouns": []}

只返回JSON，不要其他文字：`;

  try {
    const rawOutput = await callLLM(prompt);

    // 解析JSON（兼容```json```包裹）
    const jsonBlock = rawOutput.match(/```json\s*([\s\S]*?)\s*```/);
    const jsonMatch = jsonBlock ? [jsonBlock[1]] : rawOutput.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    return (parsed.nouns || []).filter(n => n && n.trim().length >= 2);
  } catch (err) {
    console.warn(`  [直接询问失败] ${truncText.slice(0, 30)}... → ${err.message}`);
    return [];
  }
}

// ---------- 主验证流程 ----------
async function main() {
  console.log('========== s1 LLM补缺准确率验证 ==========');
  console.log(`LLM: ${LLM_PROVIDER} / ${LLM_MODEL}`);
  console.log(`验证样本数: 前 ${VALIDATION_LIMIT} 个疑似漏词截断\n`);

  // 1. 读取质量报告中的疑似漏词
  const qualityReport = JSON.parse(fs.readFileSync(QUALITY_REPORT_PATH, 'utf-8'));
  const missedSamples = qualityReport.missedNounSamples.slice(0, VALIDATION_LIMIT);

  // 2. 读取s1流程的输出结果
  const s1Output = JSON.parse(fs.readFileSync(S1_OUTPUT_PATH, 'utf-8'));
  const s1NounsMap = new Map();
  s1Output.nouns.forEach((item) => {
    item.sourceTruncIds.forEach((truncId) => {
      if (!s1NounsMap.has(truncId)) s1NounsMap.set(truncId, []);
      s1NounsMap.get(truncId).push(item.id);
    });
  });

  // 3. 逐个截断验证
  console.log('开始逐个询问LLM（基准方式）...\n');
  const comparisons = [];
  
  for (let i = 0; i < missedSamples.length; i++) {
    const sample = missedSamples[i];
    const truncId = sample.start;
    
    // 方式A：s1流程结果
    const s1Nouns = s1NounsMap.get(truncId) || [];
    
    // 方式B：直接询问
    const directNouns = await askLLMDirectly(sample.text);
    
    // 对比
    const s1Set = new Set(s1Nouns.map(n => n.toLowerCase()));
    const directSet = new Set(directNouns.map(n => n.toLowerCase()));
    
    const matched = [...s1Set].filter(n => directSet.has(n));
    const s1Only = [...s1Set].filter(n => !directSet.has(n));
    const directOnly = [...directSet].filter(n => !s1Set.has(n));
    
    const isConsistent = s1Only.length === 0 && directOnly.length === 0;
    
    comparisons.push({
      truncId,
      text: sample.text,
      s1Nouns,
      directNouns,
      matched,
      s1Only,
      directOnly,
      isConsistent,
    });
    
    const status = isConsistent ? '✓' : '✗';
    console.log(`[${i + 1}/${missedSamples.length}] ${status} "${sample.text.slice(0, 40)}..."`);
    console.log(`  s1流程: [${s1Nouns.join(', ')}]`);
    console.log(`  直接询问: [${directNouns.join(', ')}]`);
    if (!isConsistent) {
      if (s1Only.length > 0) console.log(`  s1多出: [${s1Only.join(', ')}]`);
      if (directOnly.length > 0) console.log(`  基准多出: [${directOnly.join(', ')}]`);
    }
    console.log('');
    
    // 节流避免触发限流
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // 4. 统计结果
  const totalComparisons = comparisons.length;
  const consistentCount = comparisons.filter(c => c.isConsistent).length;
  const accuracyRate = ((consistentCount / totalComparisons) * 100).toFixed(1);
  
  const totalS1Nouns = comparisons.reduce((sum, c) => sum + c.s1Nouns.length, 0);
  const totalDirectNouns = comparisons.reduce((sum, c) => sum + c.directNouns.length, 0);
  const totalMatched = comparisons.reduce((sum, c) => sum + c.matched.length, 0);
  
  console.log('========== 验证结果 ==========');
  console.log(`样本总数: ${totalComparisons}`);
  console.log(`完全一致: ${consistentCount} (${accuracyRate}%)`);
  console.log(`s1提取总数: ${totalS1Nouns} 个名词`);
  console.log(`基准提取总数: ${totalDirectNouns} 个名词`);
  console.log(`匹配数: ${totalMatched} 个`);
  console.log('');
  
  // 5. 保存详细对比报告
  const report = {
    meta: {
      llmProvider: LLM_PROVIDER,
      model: LLM_MODEL,
      validationSamples: totalComparisons,
      consistentCount,
      accuracyRate: parseFloat(accuracyRate),
      totalS1Nouns,
      totalDirectNouns,
      totalMatched,
    },
    comparisons,
  };
  
  fs.writeFileSync('./s1-validation-report.json', JSON.stringify(report, null, 2));
  console.log('详细对比报告已保存: s1-validation-report.json');
  
  // 6. 显示不一致案例
  const inconsistentCases = comparisons.filter(c => !c.isConsistent);
  if (inconsistentCases.length > 0) {
    console.log('\n========== 不一致案例分析 ==========');
    inconsistentCases.slice(0, 10).forEach((c, idx) => {
      console.log(`\n案例 ${idx + 1}: "${c.text}"`);
      console.log(`  s1: [${c.s1Nouns.join(', ')}]`);
      console.log(`  基准: [${c.directNouns.join(', ')}]`);
      if (c.s1Only.length > 0) console.log(`  s1误提: [${c.s1Only.join(', ')}]`);
      if (c.directOnly.length > 0) console.log(`  s1漏提: [${c.directOnly.join(', ')}]`);
    });
  }
}

main().catch(console.error);
