import {
  AiError,
  type AiUsage,
  type BookingAppointment,
  type ChatMessage,
  type ContentPart,
  type ResolvedAttachment,
  type TimeSlot,
} from '../types'
import type { KnowledgeExcerpt, KnowledgeBaseSummary } from '../knowledge'

// ============================================================
// Bits shared by the OpenAI + Anthropic adapters.
// ============================================================

/** The `search_knowledge_base` function/tool both adapters expose to the
 *  model, and how to run it. `knowledgeBases` becomes the tool's
 *  `knowledge_base` enum (which collection to target); `execute` is a
 *  thin wrapper around `retrieveKnowledgeFromKb` supplied by the caller
 *  (generate.ts), so this module never touches the DB directly. */
export interface KnowledgeSearchTool {
  knowledgeBases: KnowledgeBaseSummary[]
  execute: (args: { query: string; knowledgeBaseName?: string }) => Promise<KnowledgeExcerpt[]>
}

export const KNOWLEDGE_SEARCH_TOOL_NAME = 'search_knowledge_base'

/** One catalog match for `send_attachment` — a name/description hit in
 *  `ai_attachments`. */
export interface AttachmentMatch {
  name: string
  kind: 'image' | 'document'
  mediaUrl: string
  filename: string
  description?: string
  price?: number
  currency?: string
}

/** The `send_attachment` function/tool both adapters expose to the model.
 *  Running it during the tool-call loop never sends anything by
 *  itself — it only resolves a catalog match, which the adapter
 *  accumulates into `ProviderResult.attachments` for the caller
 *  (auto-reply) to dispatch after generation finishes. */
export interface AttachmentSearchTool {
  execute: (args: { query: string }) => Promise<AttachmentMatch[]>
}

export const SEND_ATTACHMENT_TOOL_NAME = 'send_attachment'

/** The `check_availability`/`book_appointment` function/tools both
 *  adapters expose to the model when the account has business hours
 *  configured. `execute` computes open slots for one calendar date
 *  (supplied by generate.ts, backed by `checkAvailability` in
 *  lib/ai/booking.ts) — running it inside the tool-call loop never
 *  writes anything; the adapter only accumulates offered slots /
 *  confirmed appointments into `ProviderResult.booking` for the caller
 *  (auto-reply) to dispatch after generation finishes. */
export interface BookingSearchTool {
  execute: (args: { date: string }) => Promise<TimeSlot[]>
}

export const CHECK_AVAILABILITY_TOOL_NAME = 'check_availability'
export const BOOK_APPOINTMENT_TOOL_NAME = 'book_appointment'

/** The `set_customer_name` function/tool both adapters expose to the model
 *  when the contact's name isn't on file yet. Running it during the
 *  tool-call loop never writes to the DB by itself — it only validates the
 *  name, which the adapter accumulates into `ProviderResult.customerName`
 *  for the caller (auto-reply/widget-reply) to persist onto the contact
 *  after generation finishes. */
export const CAPTURE_NAME_TOOL_NAME = 'set_customer_name'

/** Tool-call rounds allowed before the adapter forces a final,
 *  tool-free round to guarantee text comes back. */
export const MAX_TOOL_ROUNDS = 2

/** Serialize excerpts for a tool result message — the model sees them
 *  the same way it sees the automatically-retrieved excerpts (title
 *  included, for internal attribution only; buildSystemPrompt already
 *  instructs it never to surface a title/source to the customer). */
export function excerptsToToolResult(excerpts: KnowledgeExcerpt[]): string {
  if (excerpts.length === 0) return JSON.stringify({ results: [], note: 'No matching excerpts found.' })
  return JSON.stringify({
    results: excerpts.map((e) => ({ collection: e.kbName, title: e.title, content: e.content })),
  })
}

export interface ProviderArgs {
  apiKey: string
  model: string
  systemPrompt: string
  messages: ChatMessage[]
  timeoutMs: number
  /** When either is present, the adapter exposes the corresponding
   *  function tool to the model and runs its own internal multi-round
   *  tool-call loop (both tools can be offered in the same round). */
  tools?: {
    knowledge?: KnowledgeSearchTool
    attachments?: AttachmentSearchTool
    booking?: BookingSearchTool
    /** True to expose `set_customer_name` — no executor needed, the
     *  adapter just validates and accumulates what the model reports. */
    nameCapture?: boolean
  }
}

/**
 * Coerce a provider's usage block into our normalized `AiUsage`, tolerant
 * of missing/partial fields (providers differ and older API versions may
 * omit counts). Returns null when there's nothing usable, so logging can
 * distinguish "no usage reported" from "zero tokens". `total` falls back
 * to prompt + completion when the provider doesn't send it (Anthropic).
 */
export function normalizeUsage(raw: {
  prompt?: unknown
  completion?: unknown
  total?: unknown
}): AiUsage | null {
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  const promptTokens = num(raw.prompt)
  const completionTokens = num(raw.completion)
  const total = num(raw.total)
  const totalTokens = total > 0 ? total : promptTokens + completionTokens
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
    return null
  }
  return { promptTokens, completionTokens, totalTokens }
}

/** Map a fetch rejection (timeout / DNS / offline) to a typed AiError. */
export function toNetworkError(err: unknown): AiError {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AiError('The AI provider took too long to respond.', {
      code: 'timeout',
      status: 504,
    })
  }
  const msg = err instanceof Error ? err.message : String(err)
  return new AiError(`Could not reach the AI provider: ${msg}`, {
    code: 'network_error',
    status: 502,
  })
}

/** Build a typed AiError from a non-2xx provider response, pulling the
 *  provider's own error message out of the JSON body when present. */
export async function providerHttpError(
  provider: string,
  res: Response,
): Promise<AiError> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    detail =
      typeof body?.error === 'string'
        ? body.error
        : (body?.error?.message ?? '')
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const code =
    status === 401 || status === 403
      ? 'invalid_key'
      : status === 429
        ? 'rate_limited'
        : 'provider_error'
  const base =
    code === 'invalid_key'
      ? `${provider} rejected the API key`
      : code === 'rate_limited'
        ? `${provider} rate limit reached`
        : `${provider} API error (${status})`

  return new AiError(detail ? `${base}: ${detail}` : base, {
    code,
    // Surface an auth failure as 401 so the settings "Test key" button
    // can show "invalid key"; everything else is an upstream 502.
    status: code === 'invalid_key' ? 401 : 502,
  })
}

function toContentParts(content: ChatMessage['content']): ContentPart[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/**
 * Collapse consecutive same-role turns into one (joined with blank lines
 * for plain text; concatenated as content-part arrays once either side is
 * multimodal). Anthropic requires strictly alternating roles; merging is
 * also harmless for OpenAI and keeps the transcript compact.
 */
export function mergeConsecutive(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      if (typeof last.content === 'string' && typeof m.content === 'string') {
        last.content = `${last.content}\n\n${m.content}`
      } else {
        last.content = [...toContentParts(last.content), ...toContentParts(m.content)]
      }
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/** Run the model's `send_attachment` query against the catalog and shape
 *  both the tool-result JSON (what the model sees) and the resolved
 *  attachment (what the caller may later dispatch), for the first match
 *  only — one attachment per call keeps the deferred-send list sane. */
export async function runAttachmentSearch(
  tool: AttachmentSearchTool,
  query: string,
): Promise<{ resultJson: string; attachment: ResolvedAttachment | null }> {
  const matches = await tool.execute({ query })
  const match = matches[0]
  if (!match) {
    return { resultJson: JSON.stringify({ found: false }), attachment: null }
  }
  // Include description/price/currency in what the model sees so it can
  // mention them in its own reply — never inventing a price beyond what
  // the catalog (via this tool) actually confirmed.
  return {
    resultJson: JSON.stringify({
      found: true,
      name: match.name,
      kind: match.kind,
      description: match.description,
      price: match.price,
      currency: match.currency,
    }),
    attachment: {
      name: match.name,
      kind: match.kind,
      mediaUrl: match.mediaUrl,
      filename: match.filename,
      description: match.description,
      price: match.price,
      currency: match.currency,
    },
  }
}

/** Format an ISO timestamp as local wall-clock `HH:mm` — matches how
 *  `checkAvailability` (lib/ai/booking.ts) parses business hours as local
 *  time, so this must use local getters, not `toISOString()` (UTC), or
 *  the displayed time drifts from the account's configured hours whenever
 *  the server isn't running in UTC. */
export function formatLocalHHMM(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Serialize offered slots for the `check_availability` tool result — the
 *  model sees plain HH:mm times (it already knows the requested date) so
 *  it can describe them back to the customer in its own words. */
export function offerToToolResult(slots: TimeSlot[]): string {
  if (slots.length === 0) {
    return JSON.stringify({ available: false, note: 'No open slots that day.' })
  }
  return JSON.stringify({
    available: true,
    slots: slots.map((s) => ({
      startsAt: s.startsAt,
      time: formatLocalHHMM(s.startsAt),
    })),
  })
}

/** Run `check_availability`: resolve slots for the requested date via the
 *  caller-supplied executor and shape the tool-result JSON the model
 *  sees. Never writes anything — the resolved offer is only accumulated
 *  by the adapter for auto-reply to dispatch as WhatsApp buttons. */
export async function runAvailabilityCheck(
  tool: BookingSearchTool,
  date: string,
): Promise<{ resultJson: string; offer: TimeSlot[] }> {
  const slots = await tool.execute({ date })
  return { resultJson: offerToToolResult(slots), offer: slots }
}

/** Validate + normalize the model's `book_appointment` tool-call
 *  arguments into a `BookingAppointment`, or return an error string (sent
 *  back to the model as the tool result, e.g. "startsAt is required") when
 *  the args are incomplete or malformed. */
export function parseBookAppointment(
  rawArgs: unknown,
): { appointment: BookingAppointment } | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const startsAt = typeof args.startsAt === 'string' ? args.startsAt : ''
  const endsAt = typeof args.endsAt === 'string' ? args.endsAt : ''
  const service = typeof args.service === 'string' ? args.service.trim() : ''
  const notes = typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim() : undefined

  if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) {
    return { error: 'startsAt is required and must be a valid ISO timestamp.' }
  }
  if (!endsAt || Number.isNaN(new Date(endsAt).getTime())) {
    return { error: 'endsAt is required and must be a valid ISO timestamp.' }
  }
  if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
    return { error: 'endsAt must be after startsAt.' }
  }
  if (!service) {
    return { error: 'service is required.' }
  }

  return { appointment: { startsAt, endsAt, service, notes } }
}

/** Validate + normalize the model's `set_customer_name` tool-call
 *  arguments, or return an error string (sent back to the model as the
 *  tool result) when the name is missing or absurdly long. */
export function parseCustomerName(
  rawArgs: unknown,
): { name: string } | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return { error: 'name is required.' }
  if (name.length > 100) return { error: 'name must be 100 characters or fewer.' }
  return { name }
}
