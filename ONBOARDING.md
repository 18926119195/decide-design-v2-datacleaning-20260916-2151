# decide-design-v2-datacleaning-20260916-2151 入库指南

审阅基线 [`main` 的 `83a856c`](https://github.com/18926119195/decide-design-v2-datacleaning-20260916-2151/commit/83a856c35d8af6df248a58124cff5b67885da869)，2026-11-19。这个快照用于研究 Docuverse 语料清理和名词抽取。它的可交接成果是过滤规则、历史终词表和可按偏移复核的证据。若目的只是调整召回，先确定采用哪一版词表和清理逻辑。[实验范围与数据口径](docs/EXPERIMENT-2026-09-16-data-cleaning.md)

## 从聊天到可核查状态

| 时间 | 协作意图 | 截至基线的代码和证据 |
| --- | --- | --- |
| 09-16 21:45，UTC+8 | 将 Docuverse 转为纯文表，先用规则做 S0 词表，再以 LLM 补 S1，输出可定位的名词 | 初始提交与 TypeScript 管线及独立 JS 工具都已入库。TS 服务和 JS 工作流有不同入口，输入需分别核对。[初始提交](https://github.com/18926119195/decide-design-v2-datacleaning-20260916-2151/commit/e7cd749c7215faf4b846623312b91806a4a69229) · [TS 管线](src/core/pipeline.ts) · [JS 工作流](README-complete-workflow.md) |
| 09-16 21:48，UTC+8 | 查明书源占位、无 OCR 图脸和 LaTeX 残留如何进入词表 | 原始清理会话、Git 建库会话和实验记录已归档。保留真实正文和作者脚注，排除无文字层的占位说明与公式噪声。`docs/chat-transcripts/session-913ee55a-data-cleaning.jsonl` · [建库会话](docs/chat-transcripts/session-1b6503ec-git-setup.jsonl) · [记录与人工核查](docs/EXPERIMENT-2026-09-16-data-cleaning.md) |
| 09-16 21:54，UTC+8 | 用修正规则重新生成终词表 | 历史报告记载可检索原子 1543 → 1459 → 1447，纯公式噪声剩 1 条边缘样例；本次离线读取词表确认有 18,344 条词。报告中的全部原子变化和词质分布仍取决于原语料与当时配置。[再生成提交](https://github.com/18926119195/decide-design-v2-datacleaning-20260916-2151/commit/83a856c35d8af6df248a58124cff5b67885da869) · [终词表](final-noun-index.json) |
| 后续待办 | 让所有入口对同一正文返回同一坐标，将异常项复现并避免规则漂移 | 清理代码仍有 TS 和 4 个 JS 副本。重复篇章标题的统计口径可做对照试验，文档将其视为真实页眉。默认安装脚本中 `smoke`、`test:s0`、`test:full` 指向的脚本在该快照未跟踪。[过滤规则](src/core/text.ts) · [待办](docs/EXPERIMENT-2026-09-16-data-cleaning.md#后续待办) · [命令清单](package.json) |

## 第一次复现和数据边界

- **定位输入度量点。** 输入是带图脸、文本层、页码与 chunk ID 的 Docuverse 语料，产出清洗正文的 offset、S0/S1 质量报告和终词表。先从 [`text.ts`](src/core/text.ts)看检索原子筛选、LaTeX 剥离，再到 [`pureTextTable.ts`](src/core/pureTextTable.ts) 确认偏移构造。
- **最小本地复现。** 在 Node 24 下运行 `node test-s1-dedup-confidence.js` 展示 S0/S1 重叠样例与偏移输出，结合真实打印值检查，脚本结尾的描述来自预写文本。审阅另用合成块直接断言 `isRetrievableAtom` 排除了超过 24 字符的无 OCR 图脸，`atomSearchText` 去掉公式且保留两侧正文。未调用远程 LLM，也未以全量源文重算历史词表。
- **恢复全量输入。** 用获授权的源语料及隔离副本，按 [工作流](README-complete-workflow.md)准备 spaCy 法语模型与 sidecar，再核对实际 JS 脚本的模型环境配置。锁定语料、规则版本、S1 输入及输出文件位置；相同输入也会受 OCR 和模型输出波动影响。

## 将质量反馈纳入开发顺序

1. **固定最小夹具。** 放入长图脸占位、带真实文字的图、带公式正文、纯公式、作者引用和法语特殊标点。维护者标注保留与排除预期，Agent 记录原始及清洗文本的坐标和变更原因。
2. **收敛规则。** 用同一夹具对照 TS 与四个 JS 路径，先证明输出一致，再将重复逻辑改成单一可导入来源，或由维护者明确保留的兼容差异。建议门槛为夹具上真实内容零误删、噪声正确过滤、所有词表位置可回查正文。
3. **受控重算。** 用已固定的语料和运行参数重放，导出阶段计数、被删除块类型、残余噪声、抽样位置准确率和 S1 失败数。出现变化先追至输入、过滤或 S1，人工复核变更样本后才替换团队参考数据。异常时保留前版本和差异报告，便于复核和回退。
4. **让接续者能验证。** 把会话段落、规则位置、夹具版本、运行配置与审核结果放入同一个 PR。Agent 首先回放本地样例，评审人批准后再恢复全量数据任务。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)
