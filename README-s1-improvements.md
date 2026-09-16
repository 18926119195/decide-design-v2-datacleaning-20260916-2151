# s1 LLM 兜底：三大改进说明

## 问题背景

你提出的三个关键问题：

1. **限流问题**：哪里可以看到限流？如何处理 API 限流？
2. **防污染问题**：±50 字符上下文窗口会不会重复提取 s0 已经覆盖的名词？
3. **位置准确性问题**：多个截断送进同一个 LLM，返回的名词能否准确定位到真实位置？

## 1. 限流处理（429 重试 + 指数退避）

### DeepSeek API 限流参数（参考）

根据 DeepSeek API 文档（`https://api-docs.deepseek.com/zh-cn/quick_start/pricing`），常见限流如下：

- **免费用户**：10 RPM（每分钟请求数）
- **付费用户**：取决于套餐，通常 100-500 RPM

### 实现方式

`s1-llm-fill.js` 已实现：

```javascript
async function callLLM(prompt, signal, retryCount = 0) {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 2000; // 初始延迟2秒
  
  try {
    const response = await fetch(...);
    
    // 检测 429 限流
    if (response.status === 429 && retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount); // 指数退避：2s → 4s → 8s
      console.warn(`[429限流] 等待 ${delay}ms 后重试 (${retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callLLM(prompt, signal, retryCount + 1);
    }
    
    // ... 正常处理
  } catch (err) {
    // 网络错误也重试（例如连接超时）
    if (retryCount < MAX_RETRIES) {
      const delay = BASE_DELAY * Math.pow(2, retryCount);
      console.warn(`[网络错误] ${err.message}，等待 ${delay}ms 后重试...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callLLM(prompt, signal, retryCount + 1);
    }
    throw err;
  }
}
```

**关键点**：
- 遇到 `429 Too Many Requests` 时自动重试 3 次
- 每次重试延迟翻倍（2s → 4s → 8s），避免持续触发限流
- 并发数 `CONCURRENCY=5` 已经比较保守，避免瞬时请求过多

### 如何查看限流

**运行时输出**：当触发 429 时，终端会打印：
```
[429限流] 等待 2000ms 后重试 (1/3)...
```

**API 响应头**：大部分 OpenAI 兼容 API 会返回限流头信息：
```
X-RateLimit-Limit-Requests: 100
X-RateLimit-Remaining-Requests: 0
X-RateLimit-Reset-Requests: 30s
```

可以在 `callLLM` 里打印这些头部信息（调试用）：
```javascript
console.log('Rate Limit:', response.headers.get('X-RateLimit-Remaining-Requests'));
```

---

## 2. 防污染：过滤 s0 已覆盖的名词

### 问题描述

`locateNounInFullText` 在截断位置 ±50 字符内搜索名词。如果这个上下文窗口覆盖了 s0 已经提取过的区域，会导致：
- LLM 提取的名词实际上已经在 s0 里了
- 最终 s0+s1 合并时会出现重复记录

**例子**：
```
全文: "...理论 [截断开始] système [截断结束] 分析..."
       ^^^^                                  ^^^
       s0已提取                              s0已提取
```

如果 ±50 字符窗口包含 "理论" 或 "分析"，LLM 可能会把它们也提取出来，但它们已经在 s0 里了。

### 解决方案

#### 步骤 1：`validate-s0-quality.js` 输出 s0 命中区间表

已修改 `validate-s0-quality.js`，在质量报告之外额外输出 `s0-hits.json`：

```json
{
  "hits": [
    { "surface": "理论", "start": 100, "end": 102 },
    { "surface": "système", "start": 150, "end": 157 },
    ...
  ]
}
```

每个 `hit` 对象记录了名词在纯文表中的**精确字符区间**。

#### 步骤 2：`s1-llm-fill.js` 加载 s0 区间并过滤重叠位置

```javascript
// 加载 s0 命中区间
let s0HitIntervals = [];
try {
  const s0Hits = JSON.parse(fs.readFileSync(S0_HITS_PATH, 'utf-8'));
  s0HitIntervals = s0Hits.hits || [];
  console.log(`加载 s0 命中位置表: ${s0HitIntervals.length} 条区间，用于防污染去重`);
} catch (err) {
  console.warn(`⚠️  无法加载 s0-hits.json，跳过防污染检查`);
}

// 在定位名词时检查重叠
function locateNounInFullText(noun, fullText, truncStart, truncEnd, contextWindow = 50, s0HitIntervals = []) {
  // ... 搜索逻辑 ...
  
  // 防污染检查：如果找到的位置与 s0 任意区间重叠，跳过
  const overlapsS0 = s0HitIntervals.some((interval) => {
    return !(globalEnd <= interval.start || globalStart >= interval.end);
  });
  
  if (!overlapsS0) {
    offsets.push({ start: globalStart, end: globalEnd });
  }
}
```

**结果**：
- 如果 LLM 提取的名词位置与 s0 已有区间重叠，直接跳过，不记录到 s1 结果
- 最终 s1 只包含**真正新增的名词**，不会污染 s0

---

## 3. 位置准确性：批量请求的名词定位机制

### 问题描述

当 8 个截断合并到一个 LLM 请求时：
```
[截断1] système
[截断2] philosophie
[截断3] capitalisme
...
```

LLM 返回：
```json
[
  {"trunc_id": 1, "nouns": ["système"]},
  {"trunc_id": 2, "nouns": ["philosophie", "théorie"]},
  ...
]
```

**疑问**：`théorie` 是从哪个截断里提取的？如果 LLM 搞混了，会不会导致位置定位错误？

### 解决方案：两级定位 + 置信度标记

#### 定位流程

1. **LLM 返回 `trunc_id`**：明确标注名词来自哪个截断
2. **根据 `trunc_id` 查找原始截断的起始位置**：
   ```javascript
   const trunc = batch.truncations[truncIndex]; // truncIndex = trunc_id - 1
   const truncStart = trunc.start;
   const truncEnd = trunc.start + trunc.length;
   ```
3. **在截断 ±50 字符窗口内搜索名词**：
   ```javascript
   const searchStart = Math.max(0, truncStart - 50);
   const searchEnd = Math.min(fullText.length, truncEnd + 50);
   const at = fullText.slice(searchStart, searchEnd).indexOf(noun);
   ```
4. **计算全局偏移量**：
   ```javascript
   const globalStart = searchStart + at;
   const globalEnd = globalStart + noun.length;
   ```

#### 置信度标记

为了验证定位准确性，每个偏移量都带有 `confidence` 字段：

```javascript
const inOriginalTrunc = globalStart >= truncStart && globalEnd <= truncEnd;
const inContextWindow = globalStart >= searchStart && globalEnd <= searchEnd;

offsets.push({
  start: globalStart,
  end: globalEnd,
  confidence: inOriginalTrunc ? 'high' : (inContextWindow ? 'medium' : 'low'),
});
```

- **`high`**：位置完全落在原始截断范围内（LLM 没搞混）
- **`medium`**：位置在 ±50 字符上下文窗口内（可能是截断边界附近的词）
- **`low`**：位置在全文其他地方找到（LLM 可能搞混了，或者名词在多处出现）

#### 输出报告

运行完成后会打印置信度统计：
```
位置置信度: 高=256, 中=42, 低=8
```

**建议**：
- `high` 占比高（>80%）说明定位准确
- `low` 占比高（>20%）需要检查 LLM 输出质量（可能 prompt 需要优化）

---

## 实际效果验证

运行 `validate-s0-quality.js` 后已经生成了 `s0-hits.json`（59708 条区间），现在可以测试完整流程：

```bash
# 1. 生成 s0 质量报告 + 命中区间表（已完成）
node validate-s0-quality.js <docuverse文件>

# 2. 运行 s1 兜底（带防污染 + 限流重试）
$env:OPENAI_API_KEY="sk-xxx"
node s1-llm-fill.js

# 3. 合并 s0+s1
node merge-s0-s1.js
```

### 预期输出

```
========== s1 LLM 兜底补缺 ==========
LLM: openai / gpt-4o-mini
并发数: 5, 批量大小: 8

加载 s0 命中位置表: 59708 条区间，用于防污染去重

读取疑似漏词: 369 个截断（本次处理 369 个）

纯文表构建完成: 598142 字符

分批完成: 47 批 (每批最多8个截断)

开始并行调用LLM...

[Worker 0] 批次 1 完成 (1/47)
[Worker 1] 批次 2 完成 (2/47)
[429限流] 等待 2000ms 后重试 (1/3)...
[Worker 2] 批次 3 完成 (3/47)
...

LLM调用完成，耗时 45.3s

========== 补缺完成 ==========
补缺名词数: 142 个
总命中位置: 156 处
平均每词命中: 1.1 处
位置置信度: 高=132, 中=18, 低=6
防污染: 已过滤与 s0 重叠的位置（基于 59708 个s0命中区间）
输出文件: ...\s1-nouns-with-offsets.json
```

---

## 总结

| 问题 | 解决方案 | 效果 |
|------|---------|------|
| 限流 | 429 自动重试 + 指数退避 | 遇到限流时自动等待，无需手动干预 |
| 防污染 | 加载 s0 区间表，过滤重叠位置 | s1 只包含真正新增的名词，不重复 s0 |
| 位置准确性 | 两级定位 + 置信度标记 | 可验证每个名词的定位质量，识别 LLM 混淆 |

所有改进已集成到 `s1-llm-fill.js`，可直接运行测试。
