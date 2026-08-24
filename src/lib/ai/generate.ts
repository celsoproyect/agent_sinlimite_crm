import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import type { KnowledgeSearchTool } from './providers/shared'
import type { KnowledgeBaseSummary } from './knowledge'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** The account's knowledge-base collections — required alongside
   *  `searchKnowledgeBase` to enable the `search_knowledge_base` tool.
   *  Omit either to run tool-free, as before. */
  knowledgeBases?: KnowledgeBaseSummary[]
  /** Runs a targeted KB search for the model's tool call (normally a
   *  thin wrapper around `retrieveKnowledgeFromKb`). */
  searchKnowledgeBase?: KnowledgeSearchTool['execute']
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, knowledgeBases, searchKnowledgeBase } = args
  const timeoutMs = aiRequestTimeoutMs()
  const tool: KnowledgeSearchTool | undefined =
    knowledgeBases && knowledgeBases.length > 0 && searchKnowledgeBase
      ? { knowledgeBases, execute: searchKnowledgeBase }
      : undefined
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    tool,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
