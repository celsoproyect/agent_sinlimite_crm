import {
  AiError,
  type AiSentiment,
  type AiUsage,
  type AvailabilityResult,
  type BookingAppointment,
  type BookingOutcome,
  type CapturedCustomField,
  type ChatMessage,
  type ContentPart,
  type LeadValue,
  type ManagedBooking,
  type ResolvedAttachment,
  type TimeSlot,
} from '../types'
import { businessDate, businessTime, businessWeekday, normalizeAiTimestamp } from '@/lib/business-timezone'
import type { KnowledgeExcerpt, KnowledgeBaseSummary } from '../knowledge'
import { shortProfessionalName } from '@/lib/clinic/directory'
import { runVenueTool, venueToolDefinitions, type VenueTools } from './venue-tools'

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
  /** Absent when only the restaurant/events tools are on (no agenda
   *  hours): check_availability and book_appointment are then left out. */
  execute?: (args: AvailabilityArgs) => Promise<AvailabilityResult>
  /** Writes the booking for `book_appointment`, returning the honest
   *  outcome so the model learns about a rejected/failed booking while
   *  it is still composing its reply. Omitted by callers that only offer
   *  slots and never persist (the Playground), in which case the tool
   *  reports success without writing. */
  create?: (
    appointment: BookingAppointment,
  ) => Promise<{ confirmed: boolean; error?: string; reference?: string; professional?: string }>
  /** Present to expose `find_appointments` / `reschedule_appointment` /
   *  `cancel_appointment` (auto-reply only — they write to the real
   *  agenda). */
  manage?: BookingManageTool
  /** Clinic module: present when the account schedules per doctor. Adds
   *  `find_professionals` and the doctor/specialty arguments on the
   *  booking tools. */
  clinic?: ProfessionalSearchTool
  /** Restaurant/events modules (migration 068): table and hall tools. */
  venue?: VenueTools
}

/** `check_availability` arguments. `professionalId`/`specialty` only
 *  exist in clinic mode. */
export interface AvailabilityArgs {
  date: string
  time?: string
  professionalId?: string
  specialty?: string
  /** Clinic services (migration 067): its id or exact name. */
  serviceId?: string
}

/** Searches the clinic's doctors for `find_professionals`. */
export interface ProfessionalSearchTool {
  find: (args: { query?: string; specialty?: string }) => Promise<unknown[]> | unknown[]
  /** The clinic has services: expose `service_id` on the booking tools. */
  services?: boolean
  /** The clinic asks for the health insurance: `book_appointment`
   *  requires `insurance`. */
  insurance?: boolean
}

/** Executors for the tools that act on an appointment that already
 *  exists. The customer identifies it by the phone number they booked
 *  with, plus the reference code when they have it. */
export interface BookingManageTool {
  find: (args: { phone: string }) => Promise<ManagedBooking[]>
  reschedule: (args: {
    phone: string
    reference?: string
    startsAt: string
    endsAt: string
    professionalId?: string
    /** Table reservations: consent to several tables, and how. */
    customerAgreed?: boolean
    seating?: 'joined' | 'separate'
  }) => Promise<{
    rescheduled: boolean
    error?: string
    appointments?: ManagedBooking[]
    appointment?: BookingAppointment
  }>
  cancel: (args: { phone: string; reference?: string }) => Promise<{
    cancelled: boolean
    error?: string
    appointments?: ManagedBooking[]
    reference?: string
  }>
}

export const CHECK_AVAILABILITY_TOOL_NAME = 'check_availability'
export const BOOK_APPOINTMENT_TOOL_NAME = 'book_appointment'
export const FIND_APPOINTMENTS_TOOL_NAME = 'find_appointments'
export const RESCHEDULE_APPOINTMENT_TOOL_NAME = 'reschedule_appointment'
export const CANCEL_APPOINTMENT_TOOL_NAME = 'cancel_appointment'
export const FIND_PROFESSIONALS_TOOL_NAME = 'find_professionals'

/** `book_appointment`'s parameters, shared by both adapters. */
export const BOOK_APPOINTMENT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    startsAt: { type: 'string', description: 'ISO 8601 start timestamp, exactly one of the offered slots.' },
    endsAt: { type: 'string', description: 'ISO 8601 end timestamp for that same slot.' },
    service: { type: 'string', description: 'What the appointment is for.' },
    customerName: { type: 'string', description: "The customer's full name, as they gave it for the appointment." },
    customerPhone: {
      type: 'string',
      description: 'The phone number the customer gave for the appointment. It is how they find it again later.',
    },
    notes: { type: 'string', description: 'Optional extra notes from the customer.' },
  },
  required: ['startsAt', 'endsAt', 'service', 'customerName', 'customerPhone'],
}

/** The tools that act on an existing appointment, in a provider-neutral
 *  shape (name, description, JSON-schema parameters) each adapter wraps
 *  in its own envelope. */
export const MANAGE_APPOINTMENT_TOOLS: {
  name: string
  description: string
  parameters: Record<string, unknown>
}[] = [
  {
    name: FIND_APPOINTMENTS_TOOL_NAME,
    description:
      "Look up the customer's upcoming appointments by the phone number they booked with. Use it when they ask about, want to change or want to cancel an appointment.",
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The phone number the customer booked with.' },
      },
      required: ['phone'],
    },
  },
  {
    name: RESCHEDULE_APPOINTMENT_TOOL_NAME,
    description:
      'Move an existing appointment to a new time. The old time is freed; no new appointment is created. Only call it after check_availability offered the new slot and the customer accepted it. Never use book_appointment to change an appointment.',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The phone number the customer booked with.' },
        reference: {
          type: 'string',
          description: 'The appointment reference (e.g. CITA-3F9A2C), from find_appointments. Required when the customer has more than one.',
        },
        startsAt: { type: 'string', description: 'ISO 8601 start timestamp of the new slot, exactly as offered.' },
        endsAt: { type: 'string', description: 'ISO 8601 end timestamp of that same slot.' },
      },
      required: ['phone', 'startsAt', 'endsAt'],
    },
  },
  {
    name: CANCEL_APPOINTMENT_TOOL_NAME,
    description: 'Cancel an existing appointment, once the customer clearly asked to cancel it (not to move it).',
    parameters: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'The phone number the customer booked with.' },
        reference: {
          type: 'string',
          description: 'The appointment reference (e.g. CITA-3F9A2C), from find_appointments. Required when the customer has more than one.',
        },
      },
      required: ['phone'],
    },
  },
]

/** Minimum digits for something to count as a phone number. */
const MIN_PHONE_DIGITS = 7

function cleanPhone(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function phoneIsValid(phone: string): boolean {
  return phone.replace(/\D/g, '').length >= MIN_PHONE_DIGITS
}

/**
 * Run one of the existing-appointment tools, or return null when `name`
 * isn't one of them. A successful reschedule hands back the moved
 * appointment so the caller treats the turn like a booking (no slot
 * buttons on top of the confirmation).
 */
export async function runManageAppointmentTool(
  tool: BookingManageTool,
  name: string,
  rawArgs: unknown,
): Promise<{ resultJson: string; appointment?: BookingAppointment } | null> {
  if (
    name !== FIND_APPOINTMENTS_TOOL_NAME &&
    name !== RESCHEDULE_APPOINTMENT_TOOL_NAME &&
    name !== CANCEL_APPOINTMENT_TOOL_NAME
  ) {
    return null
  }
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const phone = cleanPhone(args.phone)
  if (!phoneIsValid(phone)) {
    return {
      resultJson: JSON.stringify({
        error: 'phone is required: ask the customer for the phone number they booked with.',
      }),
    }
  }
  const reference = typeof args.reference === 'string' && args.reference.trim() ? args.reference.trim() : undefined

  try {
    if (name === FIND_APPOINTMENTS_TOOL_NAME) {
      const appointments = await tool.find({ phone })
      return {
        resultJson: JSON.stringify(
          appointments.length > 0
            ? { appointments }
            : { appointments: [], note: 'No upcoming appointment was found for that phone number.' },
        ),
      }
    }

    if (name === CANCEL_APPOINTMENT_TOOL_NAME) {
      return { resultJson: JSON.stringify(await tool.cancel({ phone, reference })) }
    }

    const startsAt = typeof args.startsAt === 'string' ? normalizeAiTimestamp(args.startsAt) : null
    const endsAt = typeof args.endsAt === 'string' ? normalizeAiTimestamp(args.endsAt) : null
    if (!startsAt || !endsAt || new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      return {
        resultJson: JSON.stringify({
          rescheduled: false,
          error: 'startsAt and endsAt must be one of the slots check_availability offered.',
        }),
      }
    }
    const professionalId =
      typeof args.professional_id === 'string' && args.professional_id.trim() ? args.professional_id.trim() : undefined
    const seating = args.seating === 'joined' || args.seating === 'separate' ? args.seating : undefined
    const { appointment, ...rest } = await tool.reschedule({
      phone,
      reference,
      startsAt,
      endsAt,
      ...(professionalId ? { professionalId } : {}),
      ...(args.customer_agreed === true ? { customerAgreed: true } : {}),
      ...(seating ? { seating } : {}),
    })
    return {
      resultJson: JSON.stringify(
        appointment
          ? {
              ...rest,
              reference: appointment.reference,
              date: businessDate(appointment.startsAt),
              time: businessTime(appointment.startsAt),
              ...(appointment.professionalName ? { professional: appointment.professionalName } : {}),
            }
          : rest,
      ),
      appointment,
    }
  } catch (err) {
    console.error(`[ai booking] ${name} executor threw:`, err)
    return { resultJson: JSON.stringify({ error: 'the appointment could not be looked up' }) }
  }
}

/** Id prefix on the WhatsApp reply buttons auto-reply sends for the slots
 *  `check_availability` offered (`booking_slot_0`…). The webhook keys off
 *  it to recognise a tap that belongs to the AI rather than to a Flow —
 *  see `isAiBookingSlotReply`. */
export const BOOKING_SLOT_BUTTON_PREFIX = 'booking_slot_'

/** True when an inbound interactive reply is a tap on one of the AI's own
 *  offered-slot buttons. */
export function isAiBookingSlotReply(interactiveReplyId: string | null | undefined): boolean {
  return !!interactiveReplyId && interactiveReplyId.startsWith(BOOKING_SLOT_BUTTON_PREFIX)
}

/** The `set_customer_name` function/tool both adapters expose to the model
 *  when the contact's name isn't on file yet. Running it during the
 *  tool-call loop never writes to the DB by itself — it only validates the
 *  name, which the adapter accumulates into `ProviderResult.customerName`
 *  for the caller (auto-reply/widget-reply) to persist onto the contact
 *  after generation finishes. */
export const CAPTURE_NAME_TOOL_NAME = 'set_customer_name'

/** The `add_note` function/tool both adapters expose to the model when
 *  note capture is enabled. Running it during the tool-call loop never
 *  writes to the DB by itself — it only validates the text, which the
 *  adapter accumulates into `ProviderResult.note` for the caller
 *  (auto-reply/widget-reply) to insert as a `contact_notes` row after
 *  generation finishes. */
export const ADD_NOTE_TOOL_NAME = 'add_note'

/** The `set_custom_field` function/tool both adapters expose to the model
 *  when the account has custom fields defined. `field` is constrained to
 *  the account's real field names via an enum (same pattern as
 *  `search_knowledge_base`'s `knowledge_base` enum) so the model can never
 *  invent one. Running it never writes to the DB — the adapter
 *  accumulates validated entries into `ProviderResult.customFields` for
 *  the caller to upsert onto `contact_custom_values`. */
export const CAPTURE_FIELD_TOOL_NAME = 'set_custom_field'

/** The `set_lead_stage` function/tool both adapters expose to the model
 *  only when the account has a lead pipeline configured. `stage` is
 *  constrained to that pipeline's real stage names via an enum. Running
 *  it never writes to the DB — the adapter accumulates the chosen stage
 *  into `ProviderResult.leadStage` for auto-reply to apply to the
 *  contact's deal after generation finishes. */
export const CAPTURE_LEAD_STAGE_TOOL_NAME = 'set_lead_stage'

/** The `set_sentiment` function/tool both adapters expose to the model
 *  when sentiment capture is enabled. Running it never writes to the DB —
 *  the adapter accumulates the reported mood into
 *  `ProviderResult.sentiment` for the caller to persist onto the contact. */
export const CAPTURE_SENTIMENT_TOOL_NAME = 'set_sentiment'

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
  /** Sampling temperature (0-2). Omit to use the provider's own
   *  default — the OpenAI adapter also omits it for models that reject
   *  a non-default value (see models.ts `supportsTemperature`). */
  temperature?: number
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
    /** True to expose `add_note` — no executor needed, same shape as
     *  `nameCapture`. */
    noteCapture?: boolean
    /** Present to expose `set_custom_field`, constrained to these field
     *  names — no executor needed, the adapter just validates against
     *  this list and accumulates what the model reports. */
    customFieldNames?: string[]
    /** Present to expose `set_lead_stage`, constrained to these stage
     *  names — no executor needed, same idea as `customFieldNames`. */
    leadStageNames?: string[]
    /** True to expose `set_sentiment` — no executor needed, same shape as
     *  `nameCapture`. */
    sentimentCapture?: boolean
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

/** Format an ISO timestamp as `HH:mm` in the business's own timezone —
 *  the same clock `checkAvailability` reads the configured business hours
 *  on. Explicitly zoned rather than using the host's local getters, so a
 *  server running outside America/Santo_Domingo doesn't quote the
 *  customer a time that drifts from the account's configured hours. */
export function formatLocalHHMM(iso: string): string {
  return businessTime(iso)
}

/** Serialize a `check_availability` result for the model. Each slot
 *  carries its own business-local date, weekday and HH:mm (alternatives can
 *  fall on a different day than the one asked for) plus the exact
 *  startsAt/endsAt to pass to `book_appointment`. */
export function offerToToolResult(result: AvailabilityResult): string {
  const slots = result.slots.map((s) => ({
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    date: businessDate(s.startsAt),
    weekday: WEEKDAY_NAMES[businessWeekday(businessDate(s.startsAt))],
    time: formatLocalHHMM(s.startsAt),
    ...(s.professionalId ? { professional_id: s.professionalId, professional: s.professionalName } : {}),
  }))
  if (result.error) {
    return JSON.stringify({ available: false, error: result.error })
  }
  // A holiday: say so, so the model explains it instead of just
  // offering other days.
  const holiday = result.holiday
    ? {
        holiday: {
          ...result.holiday,
          note: `${result.holiday.date}${result.holiday.name ? ` (${result.holiday.name})` : ''} is a holiday and the business is closed: tell the customer and offer the listed slots on other days. Never book on a holiday.`,
        },
      }
    : {}
  if (!result.requested) {
    return JSON.stringify(
      slots.length > 0
        ? { available: true, ...holiday, slots }
        : { available: false, ...holiday, note: 'No open slots on that date or the following two weeks.' },
    )
  }
  const { date, time, available } = result.requested
  return JSON.stringify({
    requested: { date, time, available },
    ...holiday,
    ...(available
      ? { note: 'The requested time is free. Its slot is the first one listed; the others are nearby alternatives.' }
      : {
          note:
            slots.length > 0
              ? 'The requested time is NOT available (taken, outside business hours, on a closed day, or already past). The slots listed are the closest open alternatives.'
              : 'The requested time is NOT available and there are no open slots nearby.',
        }),
    slots,
  })
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Run `check_availability`: resolve slots for the requested date (and
 *  optional preferred time) via the caller-supplied executor and shape the
 *  tool-result JSON the model sees. Never writes anything — the resolved
 *  offer is only accumulated by the adapter for auto-reply to dispatch as
 *  WhatsApp buttons. */
export async function runAvailabilityCheck(
  tool: BookingSearchTool,
  date: string,
  time?: string,
  clinic: { professionalId?: string; specialty?: string; serviceId?: string } = {},
): Promise<{ resultJson: string; offer: TimeSlot[] }> {
  if (!tool.execute) return { resultJson: JSON.stringify({ available: false }), offer: [] }
  const result = await tool.execute({ date, time, ...clinic })
  return { resultJson: offerToToolResult(result), offer: result.slots }
}

/** Parse `check_availability` arguments from either adapter. The clinic
 *  fields are only set when the model passed them. */
export function parseAvailabilityArgs(rawArgs: unknown): AvailabilityArgs {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const date = typeof args.date === 'string' ? args.date.trim() : ''
  const rawTime = typeof args.time === 'string' ? args.time.trim() : ''
  // Accept "9:00" as well as "09:00"; anything else is ignored rather than
  // failing the whole lookup.
  const m = /^(\d{1,2}):(\d{2})$/.exec(rawTime)
  const time = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined
  const professionalId = typeof args.professional_id === 'string' ? args.professional_id.trim() : ''
  const specialty = typeof args.specialty === 'string' ? args.specialty.trim() : ''
  const serviceId = typeof args.service_id === 'string' ? args.service_id.trim() : ''
  return {
    date,
    time,
    ...(professionalId ? { professionalId } : {}),
    ...(specialty ? { specialty } : {}),
    ...(serviceId ? { serviceId } : {}),
  }
}

/** One booking tool in a provider-neutral shape (name, description,
 *  JSON-schema parameters) each adapter wraps in its own envelope. */
export interface BookingToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const PROFESSIONAL_ID_PARAM = {
  type: 'string',
  description: 'The professional_id of the doctor, from the doctor list, find_professionals or the chosen check_availability slot.',
}

const SERVICE_ID_PARAM = {
  type: 'string',
  description: 'The service_id of the service the customer needs, from the services list. It sets the appointment length and which doctors offer it.',
}

const INSURANCE_PARAM = {
  type: 'string',
  description: 'The health insurance (ARS) and affiliate number the customer gave (e.g. "Humano, afiliado 123456"), or "privado" if they pay themselves.',
}

/**
 * The booking tools to expose for `tool`: check_availability and
 * book_appointment, the existing-appointment tools when `manage` is set,
 * and in clinic mode `find_professionals` plus the doctor/specialty
 * arguments (book_appointment then requires `professional_id`).
 */
export function bookingToolDefinitions(tool: BookingSearchTool): BookingToolDefinition[] {
  const clinic = !!tool.clinic
  const services = !!tool.clinic?.services
  const insurance = !!tool.clinic?.insurance
  const availability: BookingToolDefinition = {
    name: CHECK_AVAILABILITY_TOOL_NAME,
    description: clinic
      ? "Look up open appointment slots on the doctors' agendas. Pass the date, and the time too whenever the customer named one: the result then says whether exactly that time is free and lists the closest open alternatives (possibly on nearby days). Pass professional_id when the customer wants a specific doctor, or specialty to search every doctor of that specialty. Each slot says which doctor it is with."
      : 'Look up open appointment slots. Pass the date, and the time too whenever the customer named one: the result then says whether exactly that time is free and lists the closest open alternatives (possibly on nearby days).',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The date to check, as YYYY-MM-DD.' },
        time: {
          type: 'string',
          description: 'Optional. The time the customer asked for, as 24-hour HH:mm in business local time (e.g. 20:00 for 8 pm).',
        },
        ...(clinic
          ? {
              professional_id: { ...PROFESSIONAL_ID_PARAM, description: 'Optional. Only this doctor\'s agenda.' },
              specialty: {
                type: 'string',
                description: 'Optional. Search every doctor with this specialty (e.g. "Pediatría"), when no specific doctor was chosen.',
              },
              ...(services ? { service_id: { ...SERVICE_ID_PARAM, description: `Optional. ${SERVICE_ID_PARAM.description}` } } : {}),
            }
          : {}),
      },
      required: ['date'],
    },
  }
  const book: BookingToolDefinition = {
    name: BOOK_APPOINTMENT_TOOL_NAME,
    description:
      'Confirm a real appointment booking once the customer has clearly accepted a specific offered time. Only call this after check_availability offered the slot and the customer confirmed it.' +
      (clinic ? ' Pass the professional_id of that slot.' : '') +
      (services ? ' Pass the same service_id you searched with.' : ''),
    parameters: clinic
      ? {
          ...BOOK_APPOINTMENT_PARAMETERS,
          properties: {
            ...(BOOK_APPOINTMENT_PARAMETERS.properties as Record<string, unknown>),
            professional_id: PROFESSIONAL_ID_PARAM,
            ...(services ? { service_id: SERVICE_ID_PARAM } : {}),
            ...(insurance ? { insurance: INSURANCE_PARAM } : {}),
          },
          required: [
            ...(BOOK_APPOINTMENT_PARAMETERS.required as string[]),
            'professional_id',
            ...(insurance ? ['insurance'] : []),
          ],
        }
      : BOOK_APPOINTMENT_PARAMETERS,
  }
  const defs = tool.execute ? [availability, book] : []
  const tables = !!tool.venue?.restaurant
  if (tool.manage) {
    for (const def of MANAGE_APPOINTMENT_TOOLS) {
      if ((clinic || tables) && def.name === RESCHEDULE_APPOINTMENT_TOOL_NAME) {
        defs.push({
          ...def,
          description: tables
            ? `${def.description} For a table reservation (RES-…), check the new time with check_table_availability instead; events (EVT-…) are changed by the team.`
            : def.description,
          parameters: {
            ...def.parameters,
            properties: {
              ...(def.parameters.properties as Record<string, unknown>),
              ...(clinic
                ? {
                    professional_id: {
                      ...PROFESSIONAL_ID_PARAM,
                      description: 'Optional. The doctor of the new slot, when it is with a different doctor. Defaults to the same one.',
                    },
                  }
                : {}),
              ...(tables
                ? {
                    customer_agreed: {
                      type: 'boolean',
                      description: 'Table reservations: true once the customer accepted several tables at the new time.',
                    },
                    seating: { type: 'string', enum: ['joined', 'separate'], description: 'Table reservations with several tables.' },
                  }
                : {}),
            },
          },
        })
      } else {
        defs.push(def)
      }
    }
  }
  if (clinic) {
    defs.push({
      name: FIND_PROFESSIONALS_TOOL_NAME,
      description:
        "Search the clinic's doctors by name or specialty. Returns each doctor's professional_id, name, specialties and working hours. Use it when the customer asks which doctors there are, who sees a specialty, or names a doctor you need to identify.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional. A doctor name or a specialty, as the customer said it.' },
          specialty: { type: 'string', description: 'Optional. Only doctors with this specialty.' },
        },
      },
    })
  }
  if (tool.venue) defs.push(...venueToolDefinitions(tool.venue))
  return defs
}

/**
 * Run any booking tool call against `tool`, recording what happened in
 * `outcome` (offered slots / the booked or moved appointment). Returns
 * the tool-result JSON, or null when `name` isn't a booking tool.
 */
export async function runBookingTool(
  tool: BookingSearchTool,
  name: string,
  rawArgs: unknown,
  outcome: BookingOutcome,
): Promise<string | null> {
  if (tool.venue) {
    const venue = await runVenueTool(tool.venue, name, rawArgs)
    if (venue !== null) return venue
  }

  if (name === CHECK_AVAILABILITY_TOOL_NAME && tool.execute) {
    const { date, time, professionalId, specialty, serviceId } = parseAvailabilityArgs(rawArgs)
    if (!date) return JSON.stringify({ available: false })
    try {
      const clinic = tool.clinic
        ? {
            ...(professionalId ? { professionalId } : {}),
            ...(specialty ? { specialty } : {}),
            ...(serviceId && tool.clinic.services ? { serviceId } : {}),
          }
        : {}
      const { resultJson, offer } = await runAvailabilityCheck(tool, date, time, clinic)
      if (offer.length > 0) outcome.offer = offer
      return resultJson
    } catch {
      return JSON.stringify({ available: false })
    }
  }

  if (name === BOOK_APPOINTMENT_TOOL_NAME && tool.execute) {
    const { resultJson, appointment } = await runBookAppointment(tool, rawArgs)
    if (appointment) outcome.appointment = appointment
    return resultJson
  }

  if (name === FIND_PROFESSIONALS_TOOL_NAME && tool.clinic) {
    const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const specialty = typeof args.specialty === 'string' ? args.specialty.trim() : ''
    try {
      const professionals = await tool.clinic.find({
        ...(query ? { query } : {}),
        ...(specialty ? { specialty } : {}),
      })
      return JSON.stringify(
        professionals.length > 0
          ? { professionals }
          : { professionals: [], note: 'No doctor matches that. Offer the specialties and doctors from the list instead.' },
      )
    } catch (err) {
      console.error('[ai booking] find_professionals executor threw:', err)
      return JSON.stringify({ professionals: [], error: 'the doctors could not be looked up' })
    }
  }

  if (tool.manage) {
    const managed = await runManageAppointmentTool(tool.manage, name, rawArgs)
    if (managed) {
      if (managed.appointment) outcome.appointment = managed.appointment
      return managed.resultJson
    }
  }
  return null
}

/** Title for one offered-slot WhatsApp button (20-char cap). Just the time
 *  when every offered slot is on the same day; otherwise prefixed with the
 *  day/month, since alternatives can land on different dates and a bare
 *  "09:00" tap would be ambiguous. */
export function slotButtonTitle(slot: TimeSlot, offer: TimeSlot[]): string {
  const sameDay = offer.every((s) => businessDate(s.startsAt) === businessDate(offer[0].startsAt))
  const time = formatLocalHHMM(slot.startsAt)
  const [, mm, dd] = businessDate(slot.startsAt).split('-')
  const when = sameDay ? time : `${dd}/${mm} ${time}`
  // Clinic module: when the offer spans several doctors, the tap must say
  // which one, so the doctor's name fills what's left of the 20 chars.
  const doctors = new Set(offer.map((s) => s.professionalId).filter(Boolean))
  if (doctors.size > 1 && slot.professionalName) {
    return `${when} ${shortProfessionalName(slot.professionalName)}`.slice(0, 20).trim()
  }
  return when
}

/**
 * Run `book_appointment`: validate the model's arguments, then actually
 * write the booking via the caller's `create` executor and report the
 * real outcome back to the model.
 *
 * The booking used to be persisted long after generation finished, with
 * the tool answering `{ confirmed: true }` no matter what — so a slot
 * that was already taken, or an insert that failed, still had the model
 * telling the customer they were booked. Doing the write here means a
 * refusal reaches the model in time for it to say so and offer another
 * time. `appointment` is only returned (for the caller to act on) when
 * the write succeeded.
 */
export async function runBookAppointment(
  tool: BookingSearchTool,
  rawArgs: unknown,
): Promise<{ resultJson: string; appointment?: BookingAppointment }> {
  const parsed = parseBookAppointment(rawArgs)
  if ('error' in parsed) {
    return { resultJson: JSON.stringify({ confirmed: false, error: parsed.error }) }
  }
  // No writer wired up (the Playground, which must never touch the real
  // agenda): behave as before and just report the intent back.
  if (!tool.create) {
    return { resultJson: JSON.stringify({ confirmed: true }), appointment: parsed.appointment }
  }
  let outcome: { confirmed: boolean; error?: string; reference?: string; professional?: string }
  try {
    outcome = await tool.create(parsed.appointment)
  } catch (err) {
    console.error('[ai booking] book_appointment executor threw:', err)
    outcome = { confirmed: false, error: 'the booking could not be saved' }
  }
  return {
    resultJson: JSON.stringify(outcome),
    appointment: outcome.confirmed
      ? {
          ...parsed.appointment,
          reference: outcome.reference,
          ...(outcome.professional ? { professionalName: outcome.professional } : {}),
        }
      : undefined,
  }
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
  const customerName = typeof args.customerName === 'string' ? args.customerName.trim().slice(0, 100) : ''
  const customerPhone = cleanPhone(args.customerPhone).slice(0, 40)
  const professionalId =
    typeof args.professional_id === 'string' && args.professional_id.trim() ? args.professional_id.trim() : undefined
  const serviceId = typeof args.service_id === 'string' && args.service_id.trim() ? args.service_id.trim() : undefined
  const insurance =
    typeof args.insurance === 'string' && args.insurance.trim() ? args.insurance.trim().slice(0, 200) : undefined

  // A timestamp the model wrote without a zone means business-local
  // time — that's the only clock it was ever shown — so anchor it to the
  // business offset instead of the host's. Echoing back one of
  // check_availability's own (UTC, `Z`-suffixed) values passes through
  // unchanged.
  const startsAtUtc = startsAt ? normalizeAiTimestamp(startsAt) : null
  const endsAtUtc = endsAt ? normalizeAiTimestamp(endsAt) : null

  if (!startsAtUtc) {
    return { error: 'startsAt is required and must be a valid ISO timestamp.' }
  }
  if (!endsAtUtc) {
    return { error: 'endsAt is required and must be a valid ISO timestamp.' }
  }
  if (new Date(endsAtUtc).getTime() <= new Date(startsAtUtc).getTime()) {
    return { error: 'endsAt must be after startsAt.' }
  }
  if (!service) {
    return { error: 'service is required.' }
  }
  if (!customerName) {
    return { error: 'customerName is required: ask the customer for their full name before booking.' }
  }
  if (!phoneIsValid(customerPhone)) {
    return { error: 'customerPhone is required: ask the customer for their phone number before booking.' }
  }

  return {
    appointment: {
      startsAt: startsAtUtc,
      endsAt: endsAtUtc,
      service,
      notes,
      customerName,
      customerPhone,
      ...(professionalId ? { professionalId } : {}),
      ...(serviceId ? { serviceId } : {}),
      ...(insurance ? { insurance } : {}),
    },
  }
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

/** Validate + normalize the model's `add_note` tool-call arguments, or
 *  return an error string (sent back to the model as the tool result)
 *  when the text is missing or absurdly long. */
export function parseNote(rawArgs: unknown): { text: string } | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (!text) return { error: 'text is required.' }
  if (text.length > 1000) return { error: 'text must be 1000 characters or fewer.' }
  return { text }
}

/** Validate + normalize the model's `set_custom_field` tool-call
 *  arguments against the account's real field names, or return an error
 *  string (sent back to the model as the tool result) when the field is
 *  unknown or the value is missing/too long. */
export function parseCustomField(
  rawArgs: unknown,
  allowedFieldNames: string[],
): CapturedCustomField | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const field = typeof args.field === 'string' ? args.field.trim() : ''
  const value = typeof args.value === 'string' ? args.value.trim() : ''
  if (!field || !allowedFieldNames.includes(field)) {
    return { error: `field must be one of: ${allowedFieldNames.join(', ')}.` }
  }
  if (!value) return { error: 'value is required.' }
  if (value.length > 500) return { error: 'value must be 500 characters or fewer.' }
  return { field, value }
}

/** Validate + normalize the model's `set_lead_stage` tool-call arguments
 *  against the configured pipeline's real stage names, or return an error
 *  string (sent back to the model as the tool result) when the stage is
 *  unknown. */
export function parseLeadStage(
  rawArgs: unknown,
  allowedStageNames: string[],
): { stage: string; value?: LeadValue } | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const stage = typeof args.stage === 'string' ? args.stage.trim() : ''
  if (!stage || !allowedStageNames.includes(stage)) {
    return { error: `stage must be one of: ${allowedStageNames.join(', ')}.` }
  }
  // The amount is optional and best-effort: a missing or malformed one
  // never fails the stage update. Accepts "3,500" as well as 3500.
  const rawAmount =
    typeof args.value === 'number' ? args.value : typeof args.value === 'string' ? Number(args.value.replace(/,/g, '')) : NaN
  const rawCurrency = typeof args.currency === 'string' ? args.currency.trim().toUpperCase() : ''
  const value: LeadValue | undefined =
    Number.isFinite(rawAmount) && rawAmount > 0
      ? { amount: rawAmount, ...(/^[A-Z]{3}$/.test(rawCurrency) ? { currency: rawCurrency } : {}) }
      : undefined
  return value ? { stage, value } : { stage }
}

const VALID_SENTIMENTS: AiSentiment[] = ['positive', 'neutral', 'negative']

/** Validate + normalize the model's `set_sentiment` tool-call arguments,
 *  or return an error string (sent back to the model as the tool result)
 *  when the value isn't one of the three allowed moods. */
export function parseSentiment(rawArgs: unknown): { sentiment: AiSentiment } | { error: string } {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>
  const sentiment = typeof args.sentiment === 'string' ? args.sentiment : ''
  if (!VALID_SENTIMENTS.includes(sentiment as AiSentiment)) {
    return { error: `sentiment must be one of: ${VALID_SENTIMENTS.join(', ')}.` }
  }
  return { sentiment: sentiment as AiSentiment }
}
