# s1 LLM 兜底补缺脚本使用指南

## 核心策略

针对 **s0 (spaCy) 未覆盖的疑似漏词截断**，使用 LLM 补缺提取名词，并保留精确位置索引。

### 提速设计

1. **批量合并** (`BATCH_SIZE=8`)：将多个短截断合并到一个 LLM 请求中
   - 减少网络往返次数
   - 单次请求处理 8 个截断（平均每截断 12 字符，总输入约 100 字符，远低于上下文限制）
   
2. **并行批处理** (`CONCURRENCY=5`)：同时发起 5 个 LLM 请求
   - 理论提速：5× （网络I/O密集型任务）
   - 实际提速：3-4× （考虑API限流）

3. **精确位置索引**：每个名词记录其在纯文表中的全局偏移量 `{start, end}`
   - 支持后续检索直接定位
   - 带上下文窗口（±50字符）优先搜索截断附近区域

### LLM 注意力保护

1. **结构化提示词**：
   - 明确标注每个截断的编号和位置
   - 要求返回严格 JSON 格式（带 `trunc_id` 映射）
   - 避免 LLM 混淆不同截断的输出

2. **独立处理原则**：
   - 每个截断的提取结果独立标注
   - 输出时通过 `trunc_id` 回溯到原始截断位置

3. **温度设置**：
   - `temperature=0.1`（低温模式）：减少随机性，提高提取一致性

## 用法

### 1. 设置环境变量

```powershell
# OpenAI (推荐 gpt-4o-mini，速度快+成本低)
$env:LLM_PROVIDER="openai"
$env:OPENAI_API_KEY="sk-xxxxx"
$env:LLM_MODEL="gpt-4o-mini"

# 或 Anthropic (claude-3-5-haiku-20241022，速度最快)
$env:LLM_PROVIDER="anthropic"
$env:ANTHROPIC_API_KEY="sk-ant-xxxxx"
$env:LLM_MODEL="claude-3-5-haiku-20241022"

# 可选：自定义并发和批量大小
$env:LLM_CONCURRENCY="5"  # 并发请求数
$env:BATCH_SIZE="8"       # 每个请求合并的截断数
```

### 2. 运行脚本

```powershell
node s1-llm-fill.js
```

### 3. 输出文件

`s1-nouns-with-offsets.json`：

```json
{
  "meta": {
    "source": "s1 LLM兜底补缺",
    "llmProvider": "openai",
    "model": "gpt-4o-mini",
    "concurrency": 5,
    "batchSize": 8,
    "inputTruncations": 369,
    "outputNouns": 127,
    "totalOffsets": 384,
    "elapsedSeconds": 18.3
  },
  "nouns": [
    {
      "id": "robotique",
      "surface": "robotique",
      "offsets": [
        { "start": 31004, "end": 31013 },
        { "start": 45821, "end": 45830 }
      ],
      "sourceTruncIds": [31004, 45821]
    },
    {
      "id": "médiatique",
      "surface": "médiatique",
      "offsets": [
        { "start": 30268, "end": 30278 }
      ],
      "sourceTruncIds": [30268]
    }
  ]
}
```

## 性能估算

- **输入**：369 个疑似漏词截断
- **批量合并**：369 ÷ 8 = 47 批
- **并行处理**：47 ÷ 5 = 10 轮
- **预计耗时**：
  - gpt-4o-mini：10 轮 × 2s/轮 = **20 秒**
  - claude-3-5-haiku：10 轮 × 1.5s/轮 = **15 秒**

## 验证质量

运行后检查输出：

1. **覆盖率**：`outputNouns` 数量（预期 100-200 个新名词）
2. **命中率**：`totalOffsets / outputNouns`（预期 2-4 处/词）
3. **前10高频词**：控制台输出，人工审查是否为有效名词

## 下一步

将 s1 结果与 s0 名词表合并：

```powershell
node merge-s0-s1.js  # 待实现：合并去重，生成最终名词索引
```
