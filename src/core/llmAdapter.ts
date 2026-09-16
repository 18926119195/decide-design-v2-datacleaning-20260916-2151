/**
 * LLM适配器：提供s1补缺和合并审查的LLM实现
 * 支持批量调用和错误处理
 */

import type { LLMExtractor } from './nounS1Fill.ts'
import type { MergeReviewer } from './nounMerge.ts'

/**
 * 通用LLM调用接口
 */
export type LLMProvider = {
  /** 调用LLM生成文本 */
  generate: (prompt: string, signal?: AbortSignal) => Promise<string>
}

/**
 * s1补缺提示词模板
 */
function buildS1ExtractPrompt(truncText: string): string {
  return `请从以下文本片段中提取所有名词（noun phrases），包括专有名词、普通名词、复合名词。

要求：
1. 只返回名词本身，每行一个
2. 保持原文形式（不要翻译或改写）
3. 如果是中文，提取2-4字的名词短语
4. 如果是英文，提取完整的名词短语（包括修饰词）
5. 不要返回动词、形容词或其他词性

文本片段：
"""
${truncText}
"""

请返回名词列表（每行一个）：`
}

/**
 * 解析s1提取结果
 */
function parseS1ExtractResult(rawOutput: string): string[] {
  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  // 过滤掉明显不是名词的行（如数字、标点、单字母）
  return lines.filter((line) => {
    if (/^[\d\s\p{P}]+$/u.test(line)) return false
    if (line.length < 2) return false
    return true
  })
}

/**
 * 创建s1补缺提取器
 */
export function createS1Extractor(provider: LLMProvider): LLMExtractor {
  return async (truncText: string): Promise<string[]> => {
    try {
      const prompt = buildS1ExtractPrompt(truncText)
      const rawOutput = await provider.generate(prompt)
      return parseS1ExtractResult(rawOutput)
    } catch (error) {
      console.warn('s1补缺提取失败:', error)
      return []
    }
  }
}

/**
 * 合并审查提示词模板
 */
function buildMergeReviewPrompt(
  leftSurface: string,
  rightSurface: string,
  context: string,
): string {
  return `请判断以下两个相邻名词是否应该合并为一个复合名词。

左词：${leftSurface}
右词：${rightSurface}

上下文：
"""
${context}
"""

判断规则：
1. 如果两个词在语义上紧密相关，形成一个完整概念，应该合并
2. 如果两个词只是偶然相邻，但语义独立，不应该合并
3. 常见复合名词模式：
   - 中文：修饰词+中心词（如"人工智能"、"机器学习"）
   - 英文：形容词+名词、名词+名词（如"machine learning"、"deep neural network"）

请回答：
- 如果应该合并，返回合并后的完整名词（保持原文形式）
- 如果不应该合并，返回"NO"

你的回答（只返回合并后的名词或"NO"）：`
}

/**
 * 解析合并审查结果
 */
function parseMergeReviewResult(rawOutput: string): string | null {
  const cleaned = rawOutput.trim()
  if (cleaned.toUpperCase() === 'NO' || cleaned === '不应该合并') {
    return null
  }
  // 如果返回的是合法名词（长度>=2），返回
  if (cleaned.length >= 2) {
    return cleaned
  }
  return null
}

/**
 * 创建合并审查器
 */
export function createMergeReviewer(provider: LLMProvider): MergeReviewer {
  return async (
    leftSurface: string,
    rightSurface: string,
    context: string,
  ): Promise<string | null> => {
    try {
      const prompt = buildMergeReviewPrompt(leftSurface, rightSurface, context)
      const rawOutput = await provider.generate(prompt)
      return parseMergeReviewResult(rawOutput)
    } catch (error) {
      console.warn('合并审查失败:', error)
      return null
    }
  }
}

/**
 * Mock LLM Provider（用于测试）
 */
export function createMockLLMProvider(): LLMProvider {
  return {
    generate: async (prompt: string): Promise<string> => {
      // 简单mock：s1提取返回空，合并审查返回NO
      if (prompt.includes('提取所有名词')) {
        return ''
      }
      if (prompt.includes('是否应该合并')) {
        return 'NO'
      }
      return ''
    },
  }
}

/**
 * 基于OpenAI API的LLM Provider示例
 */
export function createOpenAIProvider(config: {
  apiKey: string
  model?: string
  baseURL?: string
}): LLMProvider {
  const { apiKey, model = 'gpt-4', baseURL = 'https://api.openai.com/v1' } = config

  return {
    generate: async (prompt: string, signal?: AbortSignal): Promise<string> => {
      const response = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 2000,
        }),
        signal,
      })

      if (!response.ok) {
        throw new Error(`OpenAI API错误: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      return data.choices[0]?.message?.content || ''
    },
  }
}

/**
 * 基于Anthropic API的LLM Provider示例
 */
export function createAnthropicProvider(config: {
  apiKey: string
  model?: string
}): LLMProvider {
  const { apiKey, model = 'claude-3-5-sonnet-20241022' } = config

  return {
    generate: async (prompt: string, signal?: AbortSignal): Promise<string> => {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      })

      if (!response.ok) {
        throw new Error(`Anthropic API错误: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      return data.content[0]?.text || ''
    },
  }
}
