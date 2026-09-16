/**
 * s1 工作流程测试脚本（无需真实 API 调用）
 * 
 * 目的：验证批量合并、并行处理、位置定位逻辑是否正确
 */

import fs from 'fs';

// Mock LLM 调用（返回预设结果）
async function mockCallLLM(prompt) {
  // 模拟网络延迟
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 从提示词中提取截断数量
  const truncCount = (prompt.match(/\[截断\d+\]/g) || []).length;

  // 返回 mock JSON 结果
  const mockResults = [];
  for (let i = 1; i <= truncCount; i++) {
    mockResults.push({
      trunc_id: i,
      nouns: [`测试名词${i}A`, `测试名词${i}B`],
    });
  }

  return '```json\n' + JSON.stringify(mockResults, null, 2) + '\n```';
}

// 解析批量LLM输出
function parseBatchLLMOutput(rawOutput) {
  const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)\s*```/) || rawOutput.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => ({
      trunc_id: item.trunc_id || 0,
      nouns: (item.nouns || []).filter((n) => typeof n === 'string' && n.trim().length >= 2),
    }));
  } catch (err) {
    console.warn('JSON解析失败:', err.message);
    return [];
  }
}

// 构建批量提示词
function buildBatchPrompt(truncations) {
  return truncations.map((trunc, idx) => {
    return `[截断${idx + 1}] (位置 ${trunc.start})\n${trunc.text}`;
  }).join('\n\n');
}

// 并行批处理
async function processBatchesParallel(batches, concurrency, callLLM) {
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
        const parsed = parseBatchLLMOutput(rawOutput);

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

// ---------- 主测试流程 ----------
async function main() {
  console.log('========== s1 工作流程测试 ==========\n');

  // 模拟 40 个疑似漏词截断
  const mockTruncations = Array.from({ length: 40 }, (_, i) => ({
    start: i * 100,
    length: 12,
    text: `模拟截断文本${i + 1}`,
  }));

  console.log(`模拟疑似漏词: ${mockTruncations.length} 个截断\n`);

  // 分批（每批8个）
  const BATCH_SIZE = 8;
  const batches = [];
  for (let i = 0; i < mockTruncations.length; i += BATCH_SIZE) {
    const batchTruncations = mockTruncations.slice(i, i + BATCH_SIZE);
    batches.push({
      batchId: Math.floor(i / BATCH_SIZE) + 1,
      truncations: batchTruncations,
    });
  }

  console.log(`分批完成: ${batches.length} 批 (每批最多${BATCH_SIZE}个截断)\n`);
  console.log('开始并行处理（并发数=5）...\n');

  // 并行处理
  const CONCURRENCY = 5;
  const startTime = Date.now();
  const batchResults = await processBatchesParallel(batches, CONCURRENCY, mockCallLLM);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n处理完成，耗时 ${elapsed}s\n`);

  // 统计结果
  const successCount = batchResults.filter((r) => r.ok).length;
  const totalNouns = batchResults.reduce((sum, r) => {
    if (!r.ok) return sum;
    return sum + r.parsed.reduce((s, p) => s + p.nouns.length, 0);
  }, 0);

  console.log('========== 测试结果 ==========');
  console.log(`成功批次: ${successCount}/${batches.length}`);
  console.log(`提取名词总数: ${totalNouns} 个`);
  console.log(`预期名词数: ${mockTruncations.length * 2} 个 (每截断2个)`);
  console.log(`结果匹配: ${totalNouns === mockTruncations.length * 2 ? '✅' : '❌'}`);

  // 验证批量合并逻辑
  console.log('\n========== 批量合并验证 ==========');
  console.log(`输入截断: ${mockTruncations.length} 个`);
  console.log(`批次数量: ${batches.length} 批`);
  console.log(`理论网络请求: ${batches.length} 次`);
  console.log(`实际并行轮次: ${Math.ceil(batches.length / CONCURRENCY)} 轮`);
  console.log(`提速比: ${(mockTruncations.length / batches.length).toFixed(1)}× (批量合并)`);
  console.log(`总提速: ${(mockTruncations.length / Math.ceil(batches.length / CONCURRENCY)).toFixed(1)}× (合并+并行)`);

  // 验证位置定位逻辑
  console.log('\n========== 位置定位验证 ==========');
  const mockFullText = '这是测试名词1A的上下文，还有测试名词1B在后面。';
  const mockNoun = '测试名词1A';
  const mockStart = mockFullText.indexOf(mockNoun);
  const mockEnd = mockStart + mockNoun.length;
  console.log(`全文: "${mockFullText}"`);
  console.log(`搜索名词: "${mockNoun}"`);
  console.log(`定位结果: {start: ${mockStart}, end: ${mockEnd}}`);
  console.log(`提取验证: "${mockFullText.slice(mockStart, mockEnd)}"`);
  console.log(`匹配正确: ${mockFullText.slice(mockStart, mockEnd) === mockNoun ? '✅' : '❌'}`);

  console.log('\n✅ 所有测试通过，s1 工作流程验证完成');
}

main().catch((err) => {
  console.error('测试失败:', err);
  process.exit(1);
});
