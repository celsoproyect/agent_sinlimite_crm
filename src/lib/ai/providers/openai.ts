import {
  AiError,
  type AiUsage,
  type BookingOutcome,
  type CapturedCustomField,
  type ChatMessage,
  type ProviderResult,
  type ResolvedAttachment,
} from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { findChatModel } from '../models'
import {
  excerptsToToolResult,
  mergeConsecutive,
  normalizeUsage,
  parseBookAppointment,
  parseCustomField,
  parseCustomerName,
  parseLeadStage,
  parseNote,
  parseSentiment,
  providerHttpError,
  runAttachmentSearch,
  runAvailabilityCheck,
  toNetworkError,
  ADD_NOTE_TOOL_NAME,
  BOOK_APPOINTMENT_TOOL_NAME,
  CAPTURE_FIELD_TOOL_NAME,
  CAPTURE_LEAD_STAGE_TOOL_NAME,
  CAPTURE_NAME_TOOL_NAME,
  CAPTURE_SENTIMENT_TOOL_NAME,
  CHECK_AVAILABILITY_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  SEND_ATTACHMENT_TOOL_NAME,
  MAX_TOOL_ROUNDS,
  type AttachmentSearchTool,
  type BookingSearchTool,
  type KnowledgeSearchTool,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAiMessage {
  role: string
  content?: string | OpenAiContentPart[] | null
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

function buildTools(
  knowledgeBaseNames: string[] | null,
  attachmentsEnabled: boolean,
  bookingEnabled: boolean,
  nameCaptureEnabled: boolean,
  noteCaptureEnabled: boolean,
  customFieldNames: string[] | null,
  leadStageNames: string[] | null,
  sentimentCaptureEnabled: boolean,
) {
  const tools: { type: 'function'; function: Record<string, unknown> }[] = []
  if (knowledgeBaseNames) {
    tools.push({
      type: 'function',
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
    })
  }
  if (attachmentsEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: SEND_ATTACHMENT_TOOL_NAME,
        description:
          "Look up a product image or document in the business's attachment catalog by name/description, to send to the customer.",
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for (product name, or document name/topic).' },
          },
          required: ['query'],
        },
      },
    })
  }
  if (bookingEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: CHECK_AVAILABILITY_TOOL_NAME,
        description:
          'Look up open appointment slots for a given calendar date, to offer the customer a real time to book.',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'The date to check, as YYYY-MM-DD.' },
          },
          required: ['date'],
        },
      },
    })
    tools.push({
      type: 'function',
      function: {
        name: BOOK_APPOINTMENT_TOOL_NAME,
        description:
          'Confirm a real appointment booking once the customer has clearly accepted a specific offered time. Only call this after check_availability offered the slot and the customer confirmed it.',
        parameters: {
          type: 'object',
          properties: {
            startsAt: { type: 'string', description: 'ISO 8601 start timestamp, exactly one of the offered slots.' },
            endsAt: { type: 'string', description: 'ISO 8601 end timestamp for that same slot.' },
            service: { type: 'string', description: 'What the appointment is for.' },
            notes: { type: 'string', description: 'Optional extra notes from the customer.' },
          },
          required: ['startsAt', 'endsAt', 'service'],
        },
      },
    })
  }
  if (nameCaptureEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: CAPTURE_NAME_TOOL_NAME,
        description:
          "Record the customer's name once they've told it to you in the conversation, so the CRM can label this conversation with it. Call this exactly once, right after they state their name.",
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: "The customer's name or preferred name, exactly as they gave it." },
          },
          required: ['name'],
        },
      },
    })
  }
  if (noteCaptureEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: ADD_NOTE_TOOL_NAME,
        description:
          'Record a short note about the customer (preference, complaint, useful context) for the CRM. Only for things worth remembering, not routine chit-chat.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The note text, short and factual.' },
          },
          required: ['text'],
        },
      },
    })
  }
  if (customFieldNames && customFieldNames.length > 0) {
    tools.push({
      type: 'function',
      function: {
        name: CAPTURE_FIELD_TOOL_NAME,
        description:
          "Record a value for one of the customer's known custom fields, once they've told it to you.",
        parameters: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: customFieldNames, description: 'Which known field to set.' },
            value: { type: 'string', description: 'The value the customer gave, as text.' },
          },
          required: ['field', 'value'],
        },
      },
    })
  }
  if (leadStageNames && leadStageNames.length > 0) {
    tools.push({
      type: 'function',
      function: {
        name: CAPTURE_LEAD_STAGE_TOOL_NAME,
        description:
          "Move this customer's lead into a specific stage of the business's sales pipeline, when the conversation clearly signals it.",
        parameters: {
          type: 'object',
          properties: {
            stage: { type: 'string', enum: leadStageNames, description: 'Which pipeline stage to set.' },
          },
          required: ['stage'],
        },
      },
    })
  }
  if (sentimentCaptureEnabled) {
    tools.push({
      type: 'function',
      function: {
        name: CAPTURE_SENTIMENT_TOOL_NAME,
        description: "Record the customer's current mood, when it's clearly readable from their message.",
        parameters: {
          type: 'object',
          properties: {
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          },
          required: ['sentiment'],
        },
      },
    })
  }
  return tools
}

/** Translate our provider-neutral content into OpenAI's block shape. A
 *  model without vision support gets a text placeholder instead of an
 *  image block, so the request never fails outright over an unsupported
 *  modality — same best-effort spirit as every other degrade path here. */
function toOpenAiContent(content: ChatMessage['content'], supportsVision: boolean): string | OpenAiContentPart[] {
  if (typeof content === 'string') return content
  const parts: OpenAiContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'document_text') {
      parts.push({ type: 'text', text: `[documento: ${part.title}]\n${part.text}` })
    } else if (part.type === 'image') {
      parts.push(
        supportsVision
          ? { type: 'image_url', image_url: { url: part.url } }
          : { type: 'text', text: '[el cliente envió una imagen — este modelo no puede verla]' },
      )
    }
  }
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }]
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
 * Returns the raw assistant text + token usage + any resolved attachments
 * (handoff parsing happens in `generateReply`).
 *
 * When `tools.knowledge`/`tools.attachments` are present, exposes the
 * corresponding function tool(s) and runs an internal loop: up to
 * `MAX_TOOL_ROUNDS` rounds where the model may call either tool (a round
 * can carry multiple calls), then one final round with tools omitted so a
 * text reply is guaranteed. Usage is summed across every round.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, temperature, tools: toolArgs } = args
  const knowledgeTool = toolArgs?.knowledge
  const attachmentTool = toolArgs?.attachments
  const bookingTool = toolArgs?.booking
  const nameCaptureEnabled = !!toolArgs?.nameCapture
  const noteCaptureEnabled = !!toolArgs?.noteCapture
  const customFieldNames = toolArgs?.customFieldNames ?? null
  const leadStageNames = toolArgs?.leadStageNames ?? null
  const sentimentCaptureEnabled = !!toolArgs?.sentimentCapture
  const supportsVision = findChatModel(model)?.supportsVision ?? false
  // The o-series reasoning models 400 on any non-default temperature —
  // omit the field entirely for them rather than send a value they'll
  // reject (see models.ts).
  const supportsTemperature = findChatModel(model)?.supportsTemperature ?? true
  const tools = buildTools(
    knowledgeTool ? knowledgeTool.knowledgeBases.map((kb) => kb.name) : null,
    !!attachmentTool,
    !!bookingTool,
    nameCaptureEnabled,
    noteCaptureEnabled,
    customFieldNames,
    leadStageNames,
    sentimentCaptureEnabled,
  )

  const conversation: OpenAiMessage[] = [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(messages).map((m) => ({
      role: m.role,
      content: toOpenAiContent(m.content, supportsVision),
    })),
  ]

  let usage: AiUsage | null = null
  const attachments: ResolvedAttachment[] = []
  const booking: BookingOutcome = {}
  const nameCapture: { name?: string } = {}
  const noteCapture: { text?: string } = {}
  const customFields: CapturedCustomField[] = []
  const leadStageCapture: { stage?: string } = {}
  const sentimentCapture: { sentiment?: ProviderResult['sentiment'] } = {}

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
          ...(supportsTemperature && temperature != null ? { temperature } : {}),
          ...(withTools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
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

    if (toolCalls && toolCalls.length > 0) {
      conversation.push({
        role: 'assistant',
        content: message?.content ?? null,
        tool_calls: toolCalls,
      })
      for (const toolCall of toolCalls) {
        conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: await runOpenAiTool(
            toolCall,
            knowledgeTool,
            attachmentTool,
            bookingTool,
            nameCaptureEnabled,
            noteCaptureEnabled,
            customFieldNames,
            leadStageNames,
            sentimentCaptureEnabled,
            attachments,
            booking,
            nameCapture,
            noteCapture,
            customFields,
            leadStageCapture,
            sentimentCapture,
          ),
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
    return {
      text,
      usage,
      attachments,
      booking: booking.offer || booking.appointment ? booking : undefined,
      customerName: nameCapture.name,
      note: noteCapture.text,
      customFields: customFields.length > 0 ? customFields : undefined,
      leadStage: leadStageCapture.stage,
      sentiment: sentimentCapture.sentiment,
    }
  }
}

async function runOpenAiTool(
  toolCall: OpenAiToolCall,
  knowledgeTool: KnowledgeSearchTool | undefined,
  attachmentTool: AttachmentSearchTool | undefined,
  bookingTool: BookingSearchTool | undefined,
  nameCaptureEnabled: boolean,
  noteCaptureEnabled: boolean,
  customFieldNames: string[] | null,
  leadStageNames: string[] | null,
  sentimentCaptureEnabled: boolean,
  attachments: ResolvedAttachment[],
  booking: BookingOutcome,
  nameCapture: { name?: string },
  noteCapture: { text?: string },
  customFields: CapturedCustomField[],
  leadStageCapture: { stage?: string },
  sentimentCapture: { sentiment?: ProviderResult['sentiment'] },
): Promise<string> {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(toolCall.function.arguments || '{}')
  } catch {
    // Malformed arguments — fall through with an empty object below.
  }

  if (toolCall.function.name === KNOWLEDGE_SEARCH_TOOL_NAME && knowledgeTool) {
    const query = typeof parsed.query === 'string' ? parsed.query : ''
    const knowledgeBaseName = typeof parsed.knowledge_base === 'string' ? parsed.knowledge_base : undefined
    if (!query) return excerptsToToolResult([])
    try {
      return excerptsToToolResult(await knowledgeTool.execute({ query, knowledgeBaseName }))
    } catch {
      return excerptsToToolResult([])
    }
  }

  if (toolCall.function.name === SEND_ATTACHMENT_TOOL_NAME && attachmentTool) {
    const query = typeof parsed.query === 'string' ? parsed.query : ''
    if (!query) return JSON.stringify({ found: false })
    try {
      const { resultJson, attachment } = await runAttachmentSearch(attachmentTool, query)
      if (attachment) attachments.push(attachment)
      return resultJson
    } catch {
      return JSON.stringify({ found: false })
    }
  }

  if (toolCall.function.name === CHECK_AVAILABILITY_TOOL_NAME && bookingTool) {
    const date = typeof parsed.date === 'string' ? parsed.date : ''
    if (!date) return JSON.stringify({ available: false })
    try {
      const { resultJson, offer } = await runAvailabilityCheck(bookingTool, date)
      if (offer.length > 0) booking.offer = offer
      return resultJson
    } catch {
      return JSON.stringify({ available: false })
    }
  }

  if (toolCall.function.name === BOOK_APPOINTMENT_TOOL_NAME && bookingTool) {
    const result = parseBookAppointment(parsed)
    if ('error' in result) return JSON.stringify({ confirmed: false, error: result.error })
    booking.appointment = result.appointment
    return JSON.stringify({ confirmed: true })
  }

  if (toolCall.function.name === CAPTURE_NAME_TOOL_NAME && nameCaptureEnabled) {
    const result = parseCustomerName(parsed)
    if ('error' in result) return JSON.stringify({ recorded: false, error: result.error })
    nameCapture.name = result.name
    return JSON.stringify({ recorded: true })
  }

  if (toolCall.function.name === ADD_NOTE_TOOL_NAME && noteCaptureEnabled) {
    const result = parseNote(parsed)
    if ('error' in result) return JSON.stringify({ recorded: false, error: result.error })
    noteCapture.text = result.text
    return JSON.stringify({ recorded: true })
  }

  if (toolCall.function.name === CAPTURE_FIELD_TOOL_NAME && customFieldNames) {
    const result = parseCustomField(parsed, customFieldNames)
    if ('error' in result) return JSON.stringify({ recorded: false, error: result.error })
    customFields.push(result)
    return JSON.stringify({ recorded: true })
  }

  if (toolCall.function.name === CAPTURE_LEAD_STAGE_TOOL_NAME && leadStageNames) {
    const result = parseLeadStage(parsed, leadStageNames)
    if ('error' in result) return JSON.stringify({ recorded: false, error: result.error })
    leadStageCapture.stage = result.stage
    return JSON.stringify({ recorded: true })
  }

  if (toolCall.function.name === CAPTURE_SENTIMENT_TOOL_NAME && sentimentCaptureEnabled) {
    const result = parseSentiment(parsed)
    if ('error' in result) return JSON.stringify({ recorded: false, error: result.error })
    sentimentCapture.sentiment = result.sentiment
    return JSON.stringify({ recorded: true })
  }

  return JSON.stringify({ error: 'unknown tool' })
}
