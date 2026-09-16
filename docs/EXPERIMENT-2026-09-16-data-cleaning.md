# 实验记录：纯文表 / 名词表 前期数据清理

日期：2026-09-16
范围：`docuverse_cartographies_squizoanalythiques_Fe_lix_Guattari` 语料的纯文表构建与 s0/s1 名词抽取管道

## 背景

纯文表（pure text table）是名词抽取管道的第一层产物：从 docuverse 的 chunk 集合里筛出"可检索原子"（`isRetrievableAtom`），拼接出 `atomSearchText`，再交给 s0（spaCy 规则）和 s1（LLM 补缺）抽取名词、生成 `final-noun-index.json`。这次的工作是排查并清理这一层里混进正文的非语言学噪声。

## 问题一：图脸占位说明混入正文

### 现象
`final-noun-index.json` 里出现 "Z-Library"、"p.39"、"Library" 等书源相关的"名词"，明显不是文本内容。

### 根因
`isRetrievableAtom` 用长度阈值（`< 24` 字符）判断是否跳过无 OCR 文字层的 `fig` 类型占位说明。但这类占位说明的固定模板：

```
图脸 · cartographies squizoanalythiques (Félix Guattari) (Z-Library) p.39 · 无文字层/未OCR；仅全页图像锚点。请依据可见版面回答；勿编造未提供的文字。
```

本身超过 24 字符，绕开了长度过滤，被当成正文送进纯文表。s0 规则据此把书源元数据当成名词提取了出来。

### 修复
在 `isRetrievableAtom` 中新增判断：若 chunk 为 `fig` 类型且无真实文字层（`faces.text` 不存在），且原始 `note` 命中 `/无文字层|未OCR/`，直接排除，不依赖长度阈值。

同步修改的文件（`text.ts` 中未被其余脚本引用，是各脚本内联复制的同一逻辑）：
- `src/core/text.ts`
- `merge-s0-s1.js`
- `validate-s0-quality.js`
- `s1-llm-fill.js`
- `merge-review-llm.js`

### 验证
- 可检索原子从 1543 降到 1459（排除 84 个占位块）
- 抽查全部 84 个被排除的块，确认无一条包含真实版面内容（均为占位模板文本）
- "Z-Library" 相关噪声全部清除

## 问题二：LaTeX/数学公式残留

### 现象
纯文表中有 28 处片段带公式残留，如：
```
"$ \mathrm{F}^{i \mathrm{m}} $ Ts"
"L'ensemble $\overline{\Phi}T_{CE}$ constitue un module existentiel de base."
```
`final-noun-index.json` 中有 168 条名词条目是纯公式碎片，如 `\Phi$.`（df:18）、`\varphi_1`（df:10）、`\circ`（df:9）、`d^{+}$`（df:6）等。

### 根因
PDF→Markdown 转换时，部分数学公式没有正确渲染，LaTeX 源码直接残留在正文里。s0 规则把 `\varphi_1`、`\circ` 等符号误判为"大写开头/带特殊字符的词"。这类残留还会污染 ±2 邻域窗口内的拓扑链关系和合并候选检测。

### 修复
在 `atomSearchText` 管道中新增 `stripLatexResidue`（`stripHtmlTags` 之后追加一步清理）：
1. 剥离完整的 `$...$` / `$$...$$` 数学环境
2. 剥离裸露的 LaTeX 命令序列（`\command`、`\command{...}`，允许一层嵌套花括号）
3. 清理残留孤立反斜杠
4. 清理残留的上下标花括号片段（`^{...}`、`_{...}`）

同步修改的文件：`src/core/text.ts`、`merge-s0-s1.js`、`validate-s0-quality.js`、`s1-llm-fill.js`、`merge-review-llm.js`。

### 验证
- 修复后可检索原子从 1459 降到 1447（排除 12 个纯公式块，如矩阵、`\circ`/`\backslash` 符号阵列）
- 逐条核对这 12 个被排除的块：清理 LaTeX 语法后剩余文本 `<4` 字符（多数只剩空格或孤立变量名），确认无真实语言内容损失
- 重跑 `merge-s0-s1.js` 生成新 `final-noun-index.json`：LaTeX 残留噪声从 168 条降到 1 条边缘案例（`^+$`，df:1，属于未配对的孤立残留，出现次数极低，未做进一步处理）

## 排查但判定为"不需要清理"的项

| 现象 | 结论 |
|---|---|
| Markdown 标题重复（如 "## Cartographies schizoanalytiques" 出现 26 次）| 真实的章节页眉重复，不是噪声。如果 df 权重敏感可考虑标题去重统计，但非必须 |
| `<Surtout, ne reparas pas...` 被误判为 HTML 标签 | 实际是法语引号 OCR 识别错误（`«»` → `<>`），个例，不构成清理规则 |
| 正文中的 `p. 103`、`Figure 12` 引用 | 作者原文脚注引用，属于合法内容，非书源占位符噪声，不清理 |

## 最终结果对比

| 指标 | 清理前 | 清理后 |
|---|---|---|
| 可检索原子数 | 1543 | 1447 |
| final-noun-index 名词总数 | 18190（估计值，含噪声）| 18344（清理后统计口径） |
| Z-Library/书源占位噪声 | 84 处 | 0 |
| LaTeX 公式碎片名词 | 168 条 | 1 条边缘案例 |

清理前的 `final-noun-index.json` 备份为 `final-noun-index.before-latex-fix.json`（未提交进大体积产物清单，已加入 `.gitignore`；如需对比可本地查看）。

## 后续待办

- 若后续要引入更严格的 df 权重排序，需要评估是否对重复标题行做统计去重
- 当前所有清理逻辑分散在 5 个文件中（1 个 TS + 4 个内联复制的 JS 脚本），维护成本较高，长期看应考虑让 4 个 JS 脚本改为直接 import `src/core/text.ts`，避免后续再次出现"改了一处、漏了三处"的风险
