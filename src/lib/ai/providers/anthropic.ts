import {
  AiError,
  type AiUsage,
  type BookingOutcome,
  type ChatMessage,
  type ProviderResult,
  type ResolvedAttachment,
} from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  excerptsToToolResult,
  mergeConsecutive,
  normalizeUsage,
  parseBookAppointment,
  parseCustomerName,
  providerHttpError,
  runAttachmentSearch,
  runAvailabilityCheck,
  toNetworkError,
  BOOK_APPOINTMENT_TOOL_NAME,
  CAPTURE_NAME_TOOL_NAME,
  CHECK_AVAILABILITY_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  SEND_ATTACHMENT_TOOL_NAME,
  MAX_TOOL_ROUNDS,
  type AttachmentSearchTool,
  type BookingSearchTool,
  type KnowledgeSearchTool,
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
  source?: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** Translate our provider-neutral content into Anthropic's block shape.
 *  An `image` part's `url` is either a real https URL (public bucket) or
 *  a `data:<mime>;base64,<bytes>` URI (resolved proxy pointer, see
 *  context.ts) — Anthropic wants those as two different source types. */
function toAnthropicContent(content: ChatMessage['content']): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'document_text') {
      blocks.push({ type: 'text', text: `[documento: ${part.title}]\n${part.text}` })
    } else if (part.type === 'image') {
      const dataUri = /^data:([^;]+);base64,([\s\S]*)$/.exec(part.url)
      blocks.push({
        type: 'image',
        source: dataUri
          ? { type: 'base64', media_type: dataUri[1], data: dataUri[2] }
          : { type: 'url', url: part.url },
      })
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
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

function buildTools(
  knowledgeBaseNames: string[] | null,
  attachmentsEnabled: boolean,
  bookingEnabled: boolean,
  nameCaptureEnabled: boolean,
) {
  const tools: { name: string; description: string; input_schema: Record<string, unknown> }[] = []
  if (knowledgeBaseNames) {
    tools.push({
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
    })
  }
  if (attachmentsEnabled) {
    tools.push({
      name: SEND_ATTACHMENT_TOOL_NAME,
      description:
        "Look up a product image or document in the business's attachment catalog by name/description, to send to the customer.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for (product name, or document name/topic).' },
        },
        required: ['query'],
      },
    })
  }
  if (bookingEnabled) {
    tools.push({
      name: CHECK_AVAILABILITY_TOOL_NAME,
      description:
        'Look up open appointment slots for a given calendar date, to offer the customer a real time to book.',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The date to check, as YYYY-MM-DD.' },
        },
        required: ['date'],
      },
    })
    tools.push({
      name: BOOK_APPOINTMENT_TOOL_NAME,
      description:
        'Confirm a real appointment booking once the customer has clearly accepted a specific offered time. Only call this after check_availability offered the slot and the customer confirmed it.',
      input_schema: {
        type: 'object',
        properties: {
          startsAt: { type: 'string', description: 'ISO 8601 start timestamp, exactly one of the offered slots.' },
          endsAt: { type: 'string', description: 'ISO 8601 end timestamp for that same slot.' },
          service: { type: 'string', description: 'What the appointment is for.' },
          notes: { type: 'string', description: 'Optional extra notes from the customer.' },
        },
        required: ['startsAt', 'endsAt', 'service'],
      },
    })
  }
  if (nameCaptureEnabled) {
    tools.push({
      name: CAPTURE_NAME_TOOL_NAME,
      description:
        "Record the customer's name once they've told it to you in the conversation, so the CRM can label this conversation with it. Call this exactly once, right after they state their name.",
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The customer's name or preferred name, exactly as they gave it." },
        },
        required: ['name'],
      },
    })
  }
  return tools
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
 * Returns the raw assistant text + token usage + any resolved attachments
 * (handoff parsing happens in `generateReply`).
 *
 * When `tools.knowledge`/`tools.attachments` are present, exposes the
 * corresponding Anthropic tool(s) and runs an internal loop: up to
 * `MAX_TOOL_ROUNDS` rounds where the model may emit `tool_use` blocks
 * (a round can carry several), then one final round with tools omitted
 * so a text reply is guaranteed. Usage is summed across every round.
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, temperature, tools: toolArgs } = args
  const knowledgeTool = toolArgs?.knowledge
  const attachmentTool = toolArgs?.attachments
  const bookingTool = toolArgs?.booking
  const nameCaptureEnabled = !!toolArgs?.nameCapture
  const tools = buildTools(
    knowledgeTool ? knowledgeTool.knowledgeBases.map((kb) => kb.name) : null,
    !!attachmentTool,
    !!bookingTool,
    nameCaptureEnabled,
  )

  const conversation: AnthropicMessage[] = normalizeForAnthropic(messages).map((m) => ({
    role: m.role,
    content: toAnthropicContent(m.content),
  }))

  let usage: AiUsage | null = null
  const attachments: ResolvedAttachment[] = []
  const booking: BookingOutcome = {}
  const nameCapture: { name?: string } = {}

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
          ...(temperature != null ? { temperature } : {}),
          ...(withTools && tools.length > 0 ? { tools } : {}),
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

    if (toolUses.length > 0) {
      conversation.push({ role: 'assistant', content: blocks })
      const resultBlocks: AnthropicContentBlock[] = []
      for (const toolUse of toolUses) {
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: await runAnthropicTool(
            toolUse,
            knowledgeTool,
            attachmentTool,
            bookingTool,
            nameCaptureEnabled,
            attachments,
            booking,
            nameCapture,
          ),
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
    return {
      text,
      usage,
      attachments,
      booking: booking.offer || booking.appointment ? booking : undefined,
      customerName: nameCapture.name,
    }
  }
}

async function runAnthropicTool(
  toolUse: AnthropicContentBlock,
  knowledgeTool: KnowledgeSearchTool | undefined,
  attachmentTool: AttachmentSearchTool | undefined,
  bookingTool: BookingSearchTool | undefined,
  nameCaptureEnabled: boolean,
  attachments: ResolvedAttachment[],
  booking: BookingOutcome,
  nameCapture: { name?: string },
): Promise<string> {
  if (toolUse.name === KNOWLEDGE_SEARCH_TOOL_NAME && knowledgeTool) {
    const input = toolUse.input as { query?: string; knowledge_base?: string } | undefined
    const query = typeof input?.query === 'string' ? input.query : ''
    const knowledgeBaseName = typeof input?.knowledge_base === 'string' ? input.knowledge_base : undefined
    if (!query) return excerptsToToolResult([])
    try {
      return excerptsToToolResult(await knowledgeTool.execute({ query, knowledgeBaseName }))
    } catch {
      return excerptsToToolResult([])
    }
  }

  if (toolUse.name === SEND_ATTACHMENT_TOOL_NAME && attachmentTool) {
    const input = toolUse.input as { query?: string } | undefined
    const query = typeof input?.query === 'string' ? input.query : ''
    if (!query) return JSON.stringify({ found: false })
    try {
      const { resultJson, attachment } = await runAttachmentSearch(attachmentTool, query)
      if (attachment) attachments.push(attachment)
      return resultJson
    } catch {
      return JSON.stringify({ found: false })
    }
  }

  if (toolUse.name === CHECK_AVAILABILITY_TOOL_NAME && bookingTool) {
    const input = toolUse.input as { date?: string } | undefined
    const date = typeof input?.date === 'string' ? input.date : ''
    if (!date) return JSON.stringify({ available: false })
    try {
      const { resultJson, offer } = await runAvailabilityCheck(bookingTool, date)
      if (offer.length > 0) booking.offer = offer
      return resultJson
    } catch {
      return JSON.stringify({ available: false })
    }
  }

  if (toolUse.name === BOOK_APPOINTMENT_TOOL_NAME && bookingTool) {
    const result = parseBookAppointment(toolUse.input)
    if ('error' in result) return JSON.stringify({ confirmed: false, error: result.error })
    booking.appointment = result.appointment
    return JSON.stringify({ confirmed: true })
  }

  if (toolUse.name === CAPTURE_NAME_TOOL_NAME && nameCaptureEnabled) {
    const result = parseCustomerName(toolUse.input)
    if ('error' in result) return JSON.stringify({ recorded: false, error: result.error })
    nameCapture.name = result.name
    return JSON.stringify({ recorded: true })
  }

  return JSON.stringify({ error: 'unknown tool' })
}
