# 新名词表 + 召回管线设计

## 设计理念

基于 **纯文表 + 全局偏移量** 的统一坐标系统，构建三层名词表：

1. **纯文表**：全书文本 + chunk 映射 + 段落切分
2. **S0 规则表**：规则抽词 + 偏移定位
3. **S1 增强表**：LLM 确认 + 补充遗漏
4. **召回引擎**：名词匹配 + 段落排序

## 核心优势

### 1. 统一的偏移量坐标系
- 全书文本拼接为一个连续字符串
- 所有名词出现位置用全局偏移量 `(start, end)` 表示
- 段落、chunk、页码都可通过偏移量映射

### 2. 精确的名词定位
- 每个名词记录所有出现位置的偏移量
- 支持快速定位到具体段落和上下文
- 召回时直接通过偏移量找段落，无需重新扫描

### 3. 渐进式质量提升
- S0：规则抽取，保证召回率（可离线运行）
- S1：LLM 增强，提升精确度（可选）
- S2：语义聚类（保留接口，暂未启用）

## 文件结构

```
src/core/
  pureTextTable.ts       # 纯文表：全书文本 + 偏移映射 + 段落切分
  nounS0.ts              # S0 规则名词表：抽词 + 偏移定位
  nounS1.ts              # S1 LLM增强：确认 + 补充
  nounS2.ts              # S2 语义聚类（保留接口）
  recallParagraphs.ts    # 段落召回引擎
  bookNounIndex.ts       # 原有规则抽词函数（被 S0 复用）

scripts/
  test-s0-only.ts        # 快速测试 S0 规则表质量
  test-complete-pipeline.ts  # 完整流程测试（含召回）
```

## 快速开始

### 1. 离线测试 S0 规则表

无需 LLM，快速验证规则抽词质量：

```bash
npm run test:s0
```

输出：
- 控制台显示 S0 名词表统计
- 验证偏移量正确性
- 输出高频词列表

### 2. 完整流程测试

需要配置 LLM API（可选）：

```bash
# 方式 1: 使用 .env 文件
cp .env.example .env
# 编辑 .env 配置 LLM_API_KEY

# 方式 2: 临时环境变量
export LLM_API_KEY="your-key"
export CORPUS_PATH="./corpus/example.json"

# 运行完整流程
npm run test:full
```

如果未配置 LLM_API_KEY，会自动跳过 S1，用 S0 直接测试召回。

输出目录 `./output/`:
- `s0-nouns.json`: S0 规则名词表
- `s1-nouns.json`: S1 LLM 增强名词表（如果有 LLM）
- `recall-*.txt`: 各查询的召回结果

## 数据流

```
BookIndex (原始语料)
    ↓
[buildPureTextTable]
    ↓
PureTextTable
  - fullText: 全书拼接文本
  - entries: chunk 偏移映射
  - paragraphs: 段落切分 (每个段落记录 startOffset, endOffset)
    ↓
[buildNounS0Table]
    ↓
NounS0Table
  - entries: 名词列表
    - id: 标准化 ID (lowercase)
    - surface: 展示形式
    - df: 文档频率
    - offsets: [(start, end), ...] 全局偏移量
    ↓
[LLM 增强] (可选)
    ↓
NounS1Table
  - entries: 名词列表
    - ...继承 S0 字段
    - relevance: 1-5 相关性评分
    - fromLlm: 是否 LLM 确认/新增
    - note: LLM 备注
    ↓
[recallParagraphs]
    ↓
RecallResult
  - paragraphs: 召回段落列表
    - text: 段落文本
    - score: 相关性得分
    - matchedNouns: 命中的名词
    - nounScores: 每个名词的权重贡献
```

## 核心算法

### S0 规则抽词

```typescript
// 1. 遍历全文，抽取候选名词
// 2. 为每个名词定位所有出现位置（全局偏移量）
// 3. 过滤低质量名词（df < 2 且非专有名词）
// 4. CJK 子串剪枝（短词被长词包含则剪掉）
```

### 段落召回

```typescript
// 1. 从查询中提取名词
// 2. 在 S1 表中查找匹配的名词（获取 relevance 和 offsets）
// 3. 通过 offsets 定位到段落（二分查找）
// 4. 计算段落得分 = Σ(relevance × df) for each matched noun
// 5. 排序返回 topK
```

## 性能特点

- **S0 构建**：O(n) 遍历全文，O(m log m) 排序名词
- **段落定位**：O(log p) 二分查找，p = 段落数
- **召回查询**：O(k × h)，k = 查询名词数，h = 每词命中数

## 设计决策

### 为何用全局偏移量而非 chunk key？

1. **统一坐标系**：段落可能跨 chunk，偏移量天然支持
2. **快速定位**：二分查找 O(log n) vs 线性扫描 O(n)
3. **精确匹配**：偏移量可以验证抽词正确性（slice 还原）

### 为何先 S0 再 S1？

1. **规则保底**：S0 保证召回率，即使没有 LLM 也能工作
2. **减少幻觉**：LLM 只确认/补充已存在的词，不凭空生成
3. **可调试**：S0 纯规则，可快速验证和调优

### 为何暂不启用 S2 聚类？

1. **当前够用**：S1 已能提供高质量名词表
2. **避免过度**：聚类可能丢失语义细节
3. **保留接口**：未来需要时可随时启用

## 下一步优化方向

1. **S0 规则增强**：
   - 多词组合识别（机器学习、深度学习）
   - 领域术语库补充
   - OCR 错误纠正

2. **S1 Prompt 优化**：
   - 分批处理（避免超长 context）
   - Few-shot 示例
   - 多轮确认

3. **召回算法**：
   - BM25 加权
   - 语义相似度补充
   - 用户反馈学习

## 测试验证

当前测试覆盖：
- ✅ S0 偏移量正确性
- ✅ S0 名词去重和过滤
- ✅ 段落切分和定位
- ✅ 召回引擎基本功能

待补充：
- [ ] 大规模语料性能测试
- [ ] 召回精度评估（需要标注数据）
- [ ] 多语言混合文本测试
