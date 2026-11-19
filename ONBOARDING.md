# decide-design-v2-datacleaning-20260916-2151 入库指南

[一分钟定位](#一分钟定位) · [沿聊天时间线看灵感](#沿聊天时间线看灵感) · [从代码反查来由](#从代码反查来由) · [走读与维护记录](#走读与维护记录)

## 一分钟定位

这是以 Docuverse 纯文表和终词表为对象的 9 月 16 日清理快照。从 [清理实验](docs/EXPERIMENT-2026-09-16-data-cleaning.md)开始就能看清在解决哪些噪声、哪些原文必须保留，以及计数为什么变化。[默认分支 `main @ 83a856c`](https://github.com/18926119195/decide-design-v2-datacleaning-20260916-2151/commit/83a856c35d8af6df248a58124cff5b67885da869)

- [`src/core/text.ts`](src/core/text.ts)和 [`pureTextTable.ts`](src/core/pureTextTable.ts)描述 TS 的检索筛选与坐标构造；[独立 JS 工作流](README-complete-workflow.md)是另一条离线生成链。
- [`final-noun-index.json`](final-noun-index.json)是一次清理后合表结果，审阅读取了 18,344 个词项。实验报告还比较了清理前的版本；旧份备份未纳入本基线。
- [新管线说明](README-NEW-PIPELINE.md)包含更大的名词召回设计。想解释本库为何存在，优先看原子筛选、S0 质量对照、S1 补缺与合表。

以钱学森工程控制论的观察与反馈组织指南：用户决定什么应当保留，规则和阶段产物使结果可观察，读到差异就追到词表批次、源文本和聊天。

## 沿聊天时间线看灵感

**如何读状态。** 已实现表示在所列版本找到与灵感相符的代码路径。部分实现表示已有其中一段。未实现表示已查的入口尚无对应实现。证据不足时标待确认。归档与设计文稿按资料本身的状态描述。

日期均为 2026-09-16，北京时间。主会话位于 `docs/chat-transcripts/session-913ee55a-data-cleaning.jsonl`，各行保留用户原始时间；这里只给脱敏定位。另有 [建库会话](docs/chat-transcripts/session-1b6503ec-git-setup.jsonl)可比对导出节点。

| ID | 聊天位置 | 当时的灵感或要求 | 当前状态 | 实现证据 |
| --- | --- | --- | --- | --- |
| <a name="idea-i01"></a>I01 | 16:03，第 99 行 | 面对多份处理版本，厘清统一的 S0 → 截断 → S1 → 合并 → 终词表 → 召回结构。 | 部分落地 | 有 TS 链和独立 JS 链，清理逻辑还在多个入口重复出现，可从两边看它们如何进入合表。 [TS 管线](src/core/pipeline.ts) · [合表入口](merge-s0-s1.js) |
| <a name="idea-i02"></a>I02 | 16:32 与 18:29，第 133、274 行 | 前段尽量用规则提词，逐位对照纯文表质量，再决定让 LLM 补哪里。 | 已有实现 | S0 验证器定位词形、用命中掩码提取截断。 [位置统计](validate-s0-quality.js#L91) · [S0 报告](s0-quality-report.json) |
| <a name="idea-i03"></a>I03 | 18:36，第 278 行 | 并发处理 S1 补缺，提高速度，同时能把输出定位回纯文表。 | 已实现 | 有 worker 并发与 `locateNounInFullText`，产物存名词和偏移。 [S1 入口](s1-llm-fill.js#L300) · [S1 结果](s1-nouns-with-offsets.json) |
| <a name="idea-i04"></a>I04 | 21:04–21:11，第 492、505 行，前期清理讨论中的图脸检查 | 去掉无 OCR 图脸模板里混入正文的书名、页码和占位提示，保留真实字层。 | 已实现 | 即使模板超过 24 字，识别到无文字层或未 OCR 也会排除。合成占位块验证过该分支。 [原子筛选](src/core/text.ts#L84) · [历史检查](docs/EXPERIMENT-2026-09-16-data-cleaning.md) |
| <a name="idea-i05"></a>I05 | 21:11–21:18，第 505、523 行，继续清理纯文表 | 把 LaTeX 碎片与自然语言分开，让正文可用于词表和偏移。 | 已实现，并有边缘例 | `atomSearchText` 执行 HTML 与 LaTeX 清理；合成样本通过两侧正文保留检查，历史报告保留一条孤立公式残留。 [清理函数](src/core/text.ts#L22) · [重新生成提交](https://github.com/18926119195/decide-design-v2-datacleaning-20260916-2151/commit/83a856c35d8af6df248a58124cff5b67885da869) |
| <a name="idea-i06"></a>I06 | 21:11–21:18，第 505、523 行及同批清理实验记录的「排查但判定为不需要清理」 | 检查反复出现的标题和页码引用是否也应被剔除。 | 审过，标题统计去重未采用 | 实验记录区分真实页眉、作者引用和占位噪声。当前原子过滤仍保留符合正文条件的真实标题。 [排查结果](docs/EXPERIMENT-2026-09-16-data-cleaning.md) · [过滤代码](src/core/text.ts#L84) |

## 从代码反查来由

| 当前文件或入口 | 回读聊天 | 应理解的问题 |
| --- | --- | --- |
| [`src/core/text.ts`](src/core/text.ts) 与 [`merge-s0-s1.js`](merge-s0-s1.js#L37) | [I01](#idea-i01)、[I04](#idea-i04)–[I06](#idea-i06) | 同一意图同时进入 TS 和 JS 版；先判断脚本通过哪份规则生成文本。 |
| [`validate-s0-quality.js`](validate-s0-quality.js#L91) 与 [`s1-llm-fill.js`](s1-llm-fill.js#L300) | [I02](#idea-i02)、[I03](#idea-i03) | S0 提供坐标和未命中区，S1 的补词即使并发也需要回查同一份纯文表。 |
| [`final-noun-index.json`](final-noun-index.json) | [I04](#idea-i04)、[I05](#idea-i05) | 这 18,344 个词是在哪次规则变化之后产生，计数与边缘例各从哪里取证。 |

## 走读与维护记录

从 `isRetrievableAtom` 查一条带「无文字层/未 OCR」的图脸，再回到 [I04](#idea-i04) 与 [I06](#idea-i06)。读完应能解释为什么较长模板仍被排除、真实页眉却保留，以及生成词表的是哪条 JS 路径。发现解释或引用错误时，在指南中标记条目、聊天行和正确的版本化代码证据，避免把另一次运行的计数归到这里。

**指南如何更新。** 以仓库和版本划定范围，从聊天提取原始目标，再用代码与产物校正对当时决策的理解。新证据出现时，回到原编号修订记录。这种读法借鉴了钱学森的系统工程和工程控制论。 [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics)
