import { AiError, type AiUsage, type ChatMessage, type ProviderResult } from '../types'
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

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

function buildTools(knowledgeBaseNames: string[]) {
  return [
    {
      name: KNOWLEDGE_SEARCH_TOOL_NAME,
      description:
        'Search one specific knowledge-base collection for excerpts relevant to a query. Only use this when the excerpts already given in the system prompt do not cover what you need.',
      input_schema: {
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
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 *
 * When `tool` is present, exposes `search_knowledge_base` as an
 * Anthropic tool and runs an internal loop: up to `MAX_TOOL_ROUNDS`
 * rounds where the model may emit `tool_use` blocks, then one final
 * round with tools omitted so a text reply is guaranteed. Usage is
 * summed across every round before returning.
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tool } = args
  const tools = tool ? buildTools(tool.knowledgeBases.map((kb) => kb.name)) : undefined

  const conversation: AnthropicMessage[] = normalizeForAnthropic(messages).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  let usage: AiUsage | null = null

  async function callAnthropic(withTools: boolean): Promise<AnthropicResponse> {
    let res: Response
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: conversation,
          ...(withTools && tools ? { tools } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('Anthropic', res)
    const data = (await res.json().catch(() => null)) as AnthropicResponse | null
    if (!data) {
      throw new AiError('Anthropic returned an unreadable response.', { code: 'empty_response' })
    }
    usage = sumUsage(
      usage,
      normalizeUsage({
        prompt: data.usage?.input_tokens,
        completion: data.usage?.output_tokens,
      }),
    )
    return data
  }

  let round = 0
  for (;;) {
    const allowTools = round < MAX_TOOL_ROUNDS
    const data = await callAnthropic(allowTools)
    const blocks = data.content ?? []
    const toolUses = allowTools ? blocks.filter((b) => b.type === 'tool_use') : []

    if (tool && toolUses.length > 0) {
      conversation.push({ role: 'assistant', content: blocks })
      const resultBlocks: AnthropicContentBlock[] = []
      for (const toolUse of toolUses) {
        const input = toolUse.input as { query?: string; knowledge_base?: string } | undefined
        const query = typeof input?.query === 'string' ? input.query : ''
        const knowledgeBaseName =
          typeof input?.knowledge_base === 'string' ? input.knowledge_base : undefined
        let excerpts: Awaited<ReturnType<typeof tool.execute>> = []
        if (query) {
          try {
            excerpts = await tool.execute({ query, knowledgeBaseName })
          } catch {
            excerpts = []
          }
        }
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: excerptsToToolResult(excerpts),
        })
      }
      conversation.push({ role: 'user', content: resultBlocks })
      round += 1
      continue
    }

    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!text) {
      throw new AiError('Anthropic returned an empty response.', {
        code: 'empty_response',
      })
    }
    return { text, usage }
  }
}
