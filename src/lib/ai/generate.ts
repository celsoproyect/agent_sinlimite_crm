import {
  AiError,
  type AiConfig,
  type AiSentiment,
  type AiUsage,
  type BookingOutcome,
  type CapturedCustomField,
  type ChatMessage,
  type GenerateResult,
  type ResolvedAttachment,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import type { AttachmentSearchTool, BookingSearchTool, KnowledgeSearchTool } from './providers/shared'
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
  /** Runs a catalog lookup for the model's `send_attachment` tool call.
   *  Omit to run without the tool. */
  searchAttachments?: AttachmentSearchTool['execute']
  /** Runs the availability lookup for the model's `check_availability`
   *  tool call, enabling both booking tools. Omit to run without them. */
  checkAvailability?: BookingSearchTool['execute']
  /** True to expose the `set_customer_name` tool — the caller decides
   *  this (typically "the contact has no real name on file yet"). No
   *  executor needed: the adapter only validates and reports the name. */
  captureCustomerName?: boolean
  /** True to expose the `add_note` tool. No executor needed. */
  captureNote?: boolean
  /** Names of the account's custom fields — present to expose
   *  `set_custom_field`, constrained to this exact list. No executor
   *  needed. */
  customFieldNames?: string[]
  /** Names of the configured lead pipeline's stages — present to expose
   *  `set_lead_stage`, constrained to this exact list. No executor
   *  needed. */
  leadStageNames?: string[]
  /** True to expose the `set_sentiment` tool. No executor needed. */
  captureSentiment?: boolean
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const {
    config,
    systemPrompt,
    messages,
    knowledgeBases,
    searchKnowledgeBase,
    searchAttachments,
    checkAvailability,
    captureCustomerName,
    captureNote,
    customFieldNames,
    leadStageNames,
    captureSentiment,
  } = args
  const timeoutMs = aiRequestTimeoutMs()
  const knowledge: KnowledgeSearchTool | undefined =
    knowledgeBases && knowledgeBases.length > 0 && searchKnowledgeBase
      ? { knowledgeBases, execute: searchKnowledgeBase }
      : undefined
  const attachments: AttachmentSearchTool | undefined = searchAttachments
    ? { execute: searchAttachments }
    : undefined
  const booking: BookingSearchTool | undefined = checkAvailability ? { execute: checkAvailability } : undefined
  const nameCapture = !!captureCustomerName
  const noteCapture = !!captureNote
  const sentimentCapture = !!captureSentiment
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    temperature: config.temperature,
    tools:
      knowledge ||
      attachments ||
      booking ||
      nameCapture ||
      noteCapture ||
      (customFieldNames && customFieldNames.length > 0) ||
      (leadStageNames && leadStageNames.length > 0) ||
      sentimentCapture
        ? { knowledge, attachments, booking, nameCapture, noteCapture, customFieldNames, leadStageNames, sentimentCapture }
        : undefined,
  }

  let result: {
    text: string
    usage: AiUsage | null
    attachments: ResolvedAttachment[]
    booking?: BookingOutcome
    customerName?: string
    note?: string
    customFields?: CapturedCustomField[]
    leadStage?: string
    sentiment?: AiSentiment
  }
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

  return parseGeneration(
    result.text,
    result.usage,
    result.attachments,
    result.booking,
    result.customerName,
    result.note,
    result.customFields,
    result.leadStage,
    result.sentiment,
  )
}

/**
 * Split the raw model output into `{ text, handoff, usage, attachments,
 * booking, customerName, note, customFields, leadStage, sentiment }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. The rest of the fields are passed straight through.
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
  attachments: ResolvedAttachment[] = [],
  booking?: BookingOutcome,
  customerName?: string,
  note?: string,
  customFields?: CapturedCustomField[],
  leadStage?: string,
  sentiment?: AiSentiment,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage, attachments, booking, customerName, note, customFields, leadStage, sentiment }
}
