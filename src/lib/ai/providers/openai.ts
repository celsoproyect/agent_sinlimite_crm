import { AiError, type AiUsage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  excerptsToToolResult,
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  MAX_TOOL_ROUNDS,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: string
  content?: string | null
  tool_calls?: OpenAiToolCall[]
  tool_call_id?: string
}

interface OpenAiResponse {
  choices?: { message?: OpenAiMessage }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function buildTools(knowledgeBaseNames: string[]) {
  return [
    {
      type: 'function' as const,
      function: {
        name: KNOWLEDGE_SEARCH_TOOL_NAME,
        description:
          'Search one specific knowledge-base collection for excerpts relevant to a query. Only use this when the excerpts already given in the system prompt do not cover what you need.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for.' },
            knowledge_base: {
              type: 'string',
              enum: knowledgeBaseNames,
              description: 'Which collection to search.',
            },
          },
          required: ['query'],
        },
      },
    },
  ]
}

function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a) return b
  if (!b) return a
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 *
 * When `tool` is present, exposes `search_knowledge_base` as an OpenAI
 * function tool and runs an internal loop: up to `MAX_TOOL_ROUNDS` rounds
 * where the model may call the tool, then one final round with tools
 * omitted so a text reply is guaranteed. Usage is summed across every
 * round before returning.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tool } = args
  const tools = tool ? buildTools(tool.knowledgeBases.map((kb) => kb.name)) : undefined

  const conversation: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(messages).map((m) => ({ role: m.role, content: m.content })),
  ]

  let usage: AiUsage | null = null

  async function callOpenAi(withTools: boolean): Promise<OpenAiResponse> {
    let res: Response
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: conversation,
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          ...(withTools && tools ? { tools, tool_choice: 'auto' } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('OpenAI', res)
    const data = (await res.json().catch(() => null)) as OpenAiResponse | null
    if (!data) {
      throw new AiError('OpenAI returned an unreadable response.', { code: 'empty_response' })
    }
    usage = sumUsage(
      usage,
      normalizeUsage({
        prompt: data.usage?.prompt_tokens,
        completion: data.usage?.completion_tokens,
        total: data.usage?.total_tokens,
      }),
    )
    return data
  }

  let round = 0
  for (;;) {
    const allowTools = round < MAX_TOOL_ROUNDS
    const data = await callOpenAi(allowTools)
    const message = data.choices?.[0]?.message
    const toolCalls = allowTools ? message?.tool_calls : undefined

    if (tool && toolCalls && toolCalls.length > 0) {
      conversation.push({
        role: 'assistant',
        content: message?.content ?? null,
        tool_calls: toolCalls,
      })
      for (const toolCall of toolCalls) {
        let query = ''
        let knowledgeBaseName: string | undefined
        try {
          const parsed = JSON.parse(toolCall.function.arguments || '{}')
          query = typeof parsed.query === 'string' ? parsed.query : ''
          knowledgeBaseName =
            typeof parsed.knowledge_base === 'string' ? parsed.knowledge_base : undefined
        } catch {
          // Malformed arguments — fall through with an empty query below.
        }
        let excerpts: Awaited<ReturnType<typeof tool.execute>> = []
        if (query) {
          try {
            excerpts = await tool.execute({ query, knowledgeBaseName })
          } catch {
            excerpts = []
          }
        }
        conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: excerptsToToolResult(excerpts),
        })
      }
      round += 1
      continue
    }

    const text = message?.content
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new AiError('OpenAI returned an empty response.', {
        code: 'empty_response',
      })
    }
    return { text, usage }
  }
}
