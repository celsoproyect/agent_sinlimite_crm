// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  /** Null = "sin límite" — no per-conversation reply cap. */
  autoReplyMaxPerConversation: number | null
  /** Seconds the bot waits after its OWN last reply before answering
   *  again, so a burst of customer messages in that window is answered
   *  once instead of one reply per inbound. 0 = reply immediately
   *  (today's behaviour). WhatsApp auto-reply only. */
  replyDelaySeconds: number
  /** Sampling temperature (0-2) passed straight through to the
   *  provider's request body. */
  temperature: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Which OpenAI embeddings model to use (see lib/ai/models.ts) — always
   *  resolves to 1536 dims to match the `vector(1536)` column. */
  embeddingsModel: string
}

/**
 * One piece of a multimodal message. Provider-agnostic — each adapter
 * (openai.ts/anthropic.ts) translates these into its own native content
 * block shape when building the request body.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  | { type: 'document_text'; title: string; text: string }

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

/** An attachment resolved by the `send_attachment` tool, ready to be
 *  dispatched via `engineSendMedia` after generation finishes. */
export interface ResolvedAttachment {
  name: string
  kind: 'image' | 'document'
  mediaUrl: string
  filename: string
  description?: string
  price?: number
  currency?: string
}

/** One open appointment slot, as computed by `check_availability` and
 *  (up to 3, WhatsApp's button cap) offered to the model to present. */
export interface TimeSlot {
  startsAt: string
  endsAt: string
}

/** A confirmed appointment the model built via `book_appointment`, ready
 *  for auto-reply to insert into `bookings` after generation finishes —
 *  no DB write happens inside the provider adapters themselves. */
export interface BookingAppointment {
  startsAt: string
  endsAt: string
  service: string
  notes?: string
}

/** What the model did with the booking tools this turn, if anything. */
export interface BookingOutcome {
  /** Slots offered via `check_availability`, to be sent as WhatsApp
   *  reply buttons. */
  offer?: TimeSlot[]
  /** An appointment confirmed via `book_appointment`. */
  appointment?: BookingAppointment
}

/**
 * Flatten a `ChatMessage.content` down to plain text, for call sites that
 * only need a string (knowledge-base query text, the handoff summary
 * quote). Non-text parts become a short bracketed marker rather than
 * being dropped silently, so e.g. an image-only customer turn still shows
 * up as *something* in a handoff note.
 */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text
        case 'image':
          return '[imagen]'
        case 'document_text':
          return `[documento: ${part.title}]`
      }
    })
    .join(' ')
    .trim()
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
  /** Attachments the model selected via `send_attachment`, resolved but
   *  not yet sent — only auto-reply dispatches these. */
  attachments: ResolvedAttachment[]
  /** Set only when the booking tools were offered and the model used
   *  one of them this turn — only auto-reply dispatches these. */
  booking?: BookingOutcome
  /** Set only when the `set_customer_name` tool was offered and the model
   *  captured a name this turn — only auto-reply/widget-reply persist it
   *  onto the contact. */
  customerName?: string
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
  /** Attachments the model selected via `send_attachment`, resolved but
   *  not yet sent — only auto-reply dispatches these. */
  attachments: ResolvedAttachment[]
  /** Set only when the booking tools were offered and the model used
   *  one of them this turn — only auto-reply dispatches these. */
  booking?: BookingOutcome
  /** Set only when the `set_customer_name` tool was offered and the model
   *  captured a name this turn — only auto-reply/widget-reply persist it
   *  onto the contact. */
  customerName?: string
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
