# 决策地图 v2 架构说明

## 核心流程概览

```
纯文表 → s0规则抽取 → 截断构建 → s1补缺LLM → 合并审查LLM → 终词表 → 去重 → 相关性 → 拓扑链 → 召回
```

## 1. 纯文表 (PureTextTable)

**职责**：从原始材料提取纯文本，去除格式、标记、元数据。

**输出**：
- `fullText`: 完整纯文本
- `sourceNote`: 来源标注

## 2. s0 规则名词表 (NounS0Table)

**职责**：规则抽取 + 全局偏移量定位

**核心特性**：
- 规则识别：大写开头词、CJK 2-4字、词频>=2
- **全局偏移量**：记录每个名词在纯文表中的精确位置 `{start, end}`
- 去重：标准化ID（小写+去空格）
- 子串剪枝：CJK短词包含在长词中时剪除

**输出**：
```typescript
type NounS0Entry = {
  id: string                              // 标准化ID
  surface: string                         // 展示形式
  df: number                              // 文档频率
  offsets: Array<{start, end}>            // 全局偏移量列表
}
```

## 3. 截断构建 (Truncations)

**职责**：识别 s0 名词之间的间隙文本

**截断定义**：
- **左边界**：左侧 s0 名词ID（或 'START'）
- **右边界**：右侧 s0 名词ID（或 'END'）
- **偏移量**：`{startOffset, endOffset}` 在纯文表中的位置
- **文本**：截断的实际内容（用于 LLM）

**用途**：提供给 s1 补缺 LLM，递归提取遗漏的名词。

## 4. s1 补缺 LLM (NounS1FillTable)

**职责**：递归提取截断中的遗漏名词

**流程**：
1. 对每个截断调用 LLM：`extract_nouns_from_truncation(truncation.text)`
2. LLM 返回：`[{noun, relativeStart, relativeEnd}, ...]`
3. **偏移量计算**：`globalStart = truncation.startOffset + relativeStart`
4. 递归：如果提取出新名词，重新构建该区域的截断并继续提取

**输出**：
```typescript
type NounS1Entry = {
  id: string
  surface: string
  sourceType: 'llm_fill'
  df: number
  offsets: Array<{start, end}>            // 全局偏移量
}
```

**关键设计**：
- **递归终止条件**：最大深度=3 或 单次提取为空
- **批处理**：按截断批量并行调用 LLM
- **容错**：LLM 失败时标记但不阻塞流程

## 5. 合并审查 LLM (NounMergeTable)

**职责**：检查终词表中相邻名词是否应该合并为复合名词

**终词表定义**：`s0 + s1` 合并后的所有名词

**合并条件**：
- **位置相邻**：在终词表排序后相邻（按 `firstOffset.start` 排序）
- **偏移连续**：存在至少一对偏移满足 `left.end == right.start` 或间隙 <= 1
- **LLM 判断**：`should_merge(left, right) → {should_merge: boolean, merged_surface?: string}`

**流程**：
1. 构建相邻对候选列表
2. 批量调用 LLM 审查
3. 合并操作：创建新条目，继承偏移量，标记 `merged_from`

**输出**：
```typescript
type MergedNoun = {
  id: string
  surface: string
  sourceType: 'merged'
  merged_from: [string, string]           // 原始两个名词ID
  df: number
  offsets: Array<{start, end}>
}
```

## 6. 终词表 (FinalNounTable)

**构成**：`s0 + s1 + merged` 合并去重

**去重规则**：
- 如果两个名词完全重叠（偏移量相同），保留 `merged > s1 > s0` 优先级高的
- 标准化ID相同时合并 `offsets`

**输出**：
```typescript
type FinalNounEntry = {
  id: string
  surface: string
  sourceType: 'rule' | 'llm_fill' | 'merged'
  df: number
  offsets: Array<{start, end}>
}
```

## 7. 相关性评分 (RelevanceScoring)

**职责**：用户问题 vs 终词表名词相关性

**方法**：
1. 用户输入：`query`
2. 批量调用 LLM：`rate_relevance(query, noun) → score ∈ [0, 10]`
3. 过滤：`score >= threshold` (默认 5)

**输出**：
```typescript
type RelevantNoun = {
  id: string
  surface: string
  relevance_score: number
}
```

## 8. 拓扑链构建 (TopologyChain)

**职责**：基于终词表中名词的**相邻关系**构建拓扑链

**相邻定义**：
- 在终词表中按 `firstOffset.start` 排序
- 名词A和名词B相邻 = 排序后索引差 <= 2（±2 窗口）

**拓扑链定义**：
- 从一个高相关性名词出发
- 沿着相邻关系递归扩展
- **最多5个名词**
- 按偏移量顺序排列

**流程**：
1. 种子：相关性分数 Top-K 的名词
2. 对每个种子 BFS 扩展：收集相邻名词（±2 窗口）
3. 截断到5个名词
4. 构建链：`[n1, n2, n3, n4, n5]`

**输出**：
```typescript
type TopologyChain = {
  chain_id: string
  nouns: string[]                         // 名词ID列表（5个）
  seed_noun: string                       // 种子名词ID
  note: string
}
```

## 9. 召回 (Recall)

**职责**：基于拓扑链定位原文区间

**方法**：
- 链首名词：`firstNoun.offsets[0].start`
- 链尾名词：`lastNoun.offsets[0].end`
- 召回文本：`fullText.slice(start, end)`

**输出**：
```typescript
type RecallChunk = {
  chain_id: string
  text: string
  start_offset: number
  end_offset: number
  nouns: string[]
}
```

---

## 关键设计决策

### 1. 为什么需要全局偏移量？

**问题**：s0 规则抽取会遗漏大量名词，需要补缺 LLM。但补缺的名词必须知道在原文中的位置，才能：
- 与 s0 名词合并去重
- 构建相邻关系（拓扑链）
- 精确召回原文区间

**解决方案**：
1. s0 记录每个名词的全局偏移量 `{start, end}`
2. 截断记录自己的全局偏移量 `{startOffset, endOffset}`
3. s1 LLM 返回相对偏移 → 转换为全局偏移

### 2. 为什么需要截断（Truncations）？

**问题**：s0 规则抽取后，名词之间有大量间隙文本，这些文本中可能包含重要名词（如动词转名词、小写专有名词）。

**解决方案**：
- s0 名词视为"已知锚点"（mask）
- 截断 = 锚点之间的间隙
- 补缺 LLM 专注于提取截断中的遗漏名词
- 递归：提取新名词后再次构建截断

### 3. 为什么需要合并审查 LLM？

**问题**：
- s0 规则："machine", "learning" → 两个独立名词
- 实际："machine learning" 应该是一个复合名词

**解决方案**：
- 合并审查 LLM 检查终词表中相邻且偏移连续的名词对
- 判断是否应该合并为复合名词
- 创建新的 merged 条目

### 4. 为什么拓扑链基于相邻关系？

**假设**：原文中相邻的名词（在终词表排序中相邻）通常有语义关联。

**方法**：
- ±2 窗口：每个名词可以连接到前后各2个名词
- BFS 扩展：从高相关性种子出发，沿相邻关系扩展
- 5个名词：既能覆盖足够上下文，又不至于过长

**优势**：
- 无需 LLM 判断名词对关系（成本高）
- 基于位置的启发式，简单高效
- 5词链自然包含上下文

---

## 实现注意事项

### 并行化

- **s1 补缺 LLM**：按截断批量并行（concurrency=10）
- **合并审查 LLM**：按相邻对批量并行（concurrency=10）
- **相关性评分**：按名词批量并行（concurrency=20）

### 容错

- LLM 调用失败时：记录错误，继续后续流程
- 偏移量计算错误时：跳过该名词，记录警告
- 递归深度限制：防止无限循环

### 调试

- 每个阶段输出 `note` 字段，记录统计信息
- 终词表保留 `sourceType`，追溯来源
- 合并名词保留 `merged_from`，可逆向查询

---

## 示例流程

**输入**：

```
纯文表: "Machine learning is a subset of artificial intelligence. ML algorithms learn from data."
```

**s0 规则抽取**：

```
Machine (0-7), learning (8-16), artificial intelligence (34-58), ML (60-62), algorithms (63-73), data (89-93)
```

**截断构建**：

```
trunc_1: " is a subset of " (16-34) [learning → artificial intelligence]
trunc_2: ". " (58-60) [artificial intelligence → ML]
trunc_3: " learn from " (73-89) [algorithms → data]
```

**s1 补缺 LLM**：

```
trunc_1 → "subset" (21-27)
```

**终词表（合并前）**：

```
s0: Machine, learning, artificial intelligence, ML, algorithms, data
s1: subset
```

**合并审查 LLM**：

```
判断: (Machine, learning) → 应合并 → "Machine learning"
判断: (artificial, intelligence) → 应合并 → "artificial intelligence"
```

**终词表（最终）**：

```
Machine learning (0-16) [merged]
subset (21-27) [llm_fill]
artificial intelligence (34-58) [merged]
ML (60-62) [rule]
algorithms (63-73) [rule]
data (89-93) [rule]
```

**相关性（假设 query="如何训练模型"）**：

```
Machine learning: 9
algorithms: 8
data: 7
subset: 3
```

**拓扑链（种子=Machine learning）**：

```
chain_1: [Machine learning, subset, artificial intelligence, ML, algorithms]
```

**召回**：

```
text: "Machine learning is a subset of artificial intelligence. ML algorithms"
start: 0, end: 73
```

---

## 与旧版差异

| 维度 | 旧版 | 新版 v2 |
|------|------|---------|
| s0 抽取 | 规则 | 规则 + 全局偏移量 |
| 补缺机制 | 无 | s1 LLM 递归提取截断 |
| 合并审查 | 无 | LLM 判断相邻名词合并 |
| 拓扑链 | 基于共现 | 基于终词表相邻关系（±2） |
| 链长度 | 3词 | 5词 |
| 召回精度 | 段落级 | 精确偏移量级 |

---

## 文件结构

```
src/core/
├── pureTextTable.ts         # 纯文表
├── nounS0New.ts             # s0规则抽取 + 截断构建
├── nounS1Fill.ts            # s1补缺LLM（递归）
├── nounMerge.ts             # 合并审查LLM
├── topologyChain.ts         # 拓扑链构建（±2相邻）
├── pipeline.ts              # 完整流程编排
├── llmAdapter.ts            # LLM调用适配器
└── examples.ts              # 使用示例
```
