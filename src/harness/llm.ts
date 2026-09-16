export type LlmConfig = {
  baseUrl: string
  apiKey: string
  model: string
  thinkingDisabled: boolean
}

export function loadLlmConfigFromEnv(): LlmConfig {
  const baseUrl = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(
    /\/$/,
    '',
  )
  const apiKey = process.env.LLM_API_KEY || ''
  const model = process.env.LLM_MODEL || 'deepseek-chat'
  const thinkingDisabled =
    (process.env.LLM_THINKING || 'disabled').toLowerCase() !== 'enabled'
  return { baseUrl, apiKey, model, thinkingDisabled }
}

export async function chatCompletions(input: {
  config: LlmConfig
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}): Promise<
  | { ok: true; content: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }
  | { ok: false; note: string }
> {
  const { config } = input
  if (!config.apiKey.trim()) {
    return { ok: false, note: '缺少 LLM_API_KEY' }
  }
  const url = `${config.baseUrl}/chat/completions`
  const body: Record<string, unknown> = {
    model: config.model,
    temperature: input.temperature ?? 0.2,
    max_tokens: input.maxTokens ?? 8192,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
  }
  if (config.thinkingDisabled) {
    body.thinking = { type: 'disabled' }
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal: input.signal,
    })
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : 'fetch 失败',
    }
  }

  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (!res.ok) {
    return {
      ok: false,
      note: `HTTP ${res.status} · ${JSON.stringify(json).slice(0, 240)}`,
    }
  }
  const choices = json?.choices as Array<{ message?: { content?: string } }> | undefined
  const content = choices?.[0]?.message?.content ?? ''
  if (!content.trim()) {
    return { ok: false, note: '空 content' }
  }
  const usage = json?.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined
  return { ok: true, content, usage }
}
