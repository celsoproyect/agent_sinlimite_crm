// ============================================================
// Owner reports: who answers the customers (AI vs a person), how fast,
// where sales come from and how much of that the AI helped close.
//
// `computeOverview` is pure (fed already-loaded rows) so it can be unit
// tested; `loadReportOverview` does the account-scoped, paginated reads
// with the service-role client. Supabase caps a select at 1000 rows,
// so every read pages until it gets a short page.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { businessDate } from '@/lib/business-timezone'
import type { DayRange } from '@/lib/bookings/ranges'
import { rangeDays, rangeInstants } from './range'

export type ReportChannel = 'all' | 'whatsapp' | 'web'

export function parseReportChannel(v: string | null): ReportChannel {
  return v === 'whatsapp' || v === 'web' ? v : 'all'
}

export type SenderKind = 'customer' | 'ai' | 'human' | 'automation' | 'system'

export interface ReportMessage {
  conversation_id: string
  sender_type: string
  ai_generated: boolean | null
  content_type: string
  created_at: string
}

export function senderKind(m: Pick<ReportMessage, 'sender_type' | 'ai_generated' | 'content_type'>): SenderKind {
  if (m.content_type === 'system_event') return 'system'
  if (m.sender_type === 'customer') return 'customer'
  if (m.ai_generated) return 'ai'
  if (m.sender_type === 'agent') return 'human'
  return 'automation'
}

export interface WonDeal {
  value: number | null
  currency: string | null
  channel: string
  /** The AI wrote to this customer before the deal was won. */
  aiAssisted: boolean
}

/** Amounts per currency, e.g. `{ DOP: 45000, USD: 300 }`. */
export type MoneyTotals = Record<string, number>

export interface SalesBucket {
  count: number
  totals: MoneyTotals
}

export interface ReportOverview {
  range: DayRange
  channel: ReportChannel
  messages: Record<'customer' | 'ai' | 'human' | 'automation', number>
  conversations: {
    total: number
    aiOnly: number
    withHuman: number
    /** Only customer messages or automations, nobody answered yet. */
    unanswered: number
    /** aiOnly / (aiOnly + withHuman), 0–100; null when there is nothing to divide. */
    aiRate: number | null
  }
  responseTime: {
    ai: { avgSeconds: number | null; medianSeconds: number | null; count: number }
    human: { avgSeconds: number | null; medianSeconds: number | null; count: number }
  }
  series: { date: string; ai: number; human: number; customer: number }[]
  newContacts: { total: number; byChannel: Record<string, number> }
  sales: {
    won: SalesBucket
    byChannel: Record<string, SalesBucket>
    /** Won deals where the AI talked to the customer first. */
    aiAssisted: SalesBucket
  }
  bookings: { total: number; byAi: number }
  /** Sources that could not be read (a migration not run yet). */
  unavailable: string[]
}

function addMoney(bucket: SalesBucket, value: number | null, currency: string | null) {
  bucket.count += 1
  if (value == null || !Number.isFinite(Number(value))) return
  const cur = (currency || 'USD').toUpperCase()
  bucket.totals[cur] = (bucket.totals[cur] ?? 0) + Number(value)
}

function stats(values: number[]) {
  if (values.length === 0) return { avgSeconds: null, medianSeconds: null, count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  return { avgSeconds: Math.round(avg), medianSeconds: Math.round(median), count: values.length }
}

export interface OverviewInput {
  range: DayRange
  channel: ReportChannel
  /** Messages in the range, any order. */
  messages: ReportMessage[]
  newContactChannels: string[]
  wonDeals: WonDeal[]
  bookings: { total: number; byAi: number }
  unavailable?: string[]
}

export function computeOverview(input: OverviewInput): ReportOverview {
  const messages = { customer: 0, ai: 0, human: 0, automation: 0 }
  const days = rangeDays(input.range)
  const seriesMap = new Map(days.map((d) => [d, { date: d, ai: 0, human: 0, customer: 0 }]))

  const byConversation = new Map<string, ReportMessage[]>()
  for (const m of input.messages) {
    const list = byConversation.get(m.conversation_id)
    if (list) list.push(m)
    else byConversation.set(m.conversation_id, [m])
  }

  let aiOnly = 0
  let withHuman = 0
  let unanswered = 0
  const aiTimes: number[] = []
  const humanTimes: number[] = []

  for (const list of byConversation.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at))
    let hasAi = false
    let hasHuman = false
    let waitingSince: number | null = null

    for (const m of list) {
      const kind = senderKind(m)
      if (kind === 'system') continue
      messages[kind] += 1
      const point = seriesMap.get(businessDate(m.created_at))
      if (point && kind !== 'automation') point[kind] += 1

      const at = Date.parse(m.created_at)
      if (kind === 'customer') {
        if (waitingSince == null) waitingSince = at
        continue
      }
      if (kind === 'ai') hasAi = true
      if (kind === 'human') hasHuman = true
      if (waitingSince != null) {
        const seconds = Math.max(0, (at - waitingSince) / 1000)
        if (kind === 'ai') aiTimes.push(seconds)
        else if (kind === 'human') humanTimes.push(seconds)
        waitingSince = null
      }
    }

    if (hasHuman) withHuman += 1
    else if (hasAi) aiOnly += 1
    else unanswered += 1
  }

  const handled = aiOnly + withHuman

  const won: SalesBucket = { count: 0, totals: {} }
  const aiAssisted: SalesBucket = { count: 0, totals: {} }
  const byChannel: Record<string, SalesBucket> = {}
  for (const d of input.wonDeals) {
    addMoney(won, d.value, d.currency)
    addMoney((byChannel[d.channel] ??= { count: 0, totals: {} }), d.value, d.currency)
    if (d.aiAssisted) addMoney(aiAssisted, d.value, d.currency)
  }

  const contactsByChannel: Record<string, number> = {}
  for (const ch of input.newContactChannels) contactsByChannel[ch] = (contactsByChannel[ch] ?? 0) + 1

  return {
    range: input.range,
    channel: input.channel,
    messages,
    conversations: {
      total: byConversation.size,
      aiOnly,
      withHuman,
      unanswered,
      aiRate: handled > 0 ? Math.round((aiOnly / handled) * 100) : null,
    },
    responseTime: { ai: stats(aiTimes), human: stats(humanTimes) },
    series: [...seriesMap.values()],
    newContacts: { total: input.newContactChannels.length, byChannel: contactsByChannel },
    sales: { won, byChannel, aiAssisted },
    bookings: input.bookings,
    unavailable: input.unavailable ?? [],
  }
}

// ------------------------------------------------------------------
// Loading
// ------------------------------------------------------------------

const PAGE = 1000
const IN_CHUNK = 150

interface PgError {
  code?: string
  message?: string
}

/** Run a ranged query until a short page comes back. */
async function paged<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

/** Leave out "Cargar ejemplos" rows (migration 068); before the
 *  migration there is no is_sample column, so read everything. */
async function pagedReal<T>(
  run: (realOnly: boolean, from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgError | null }>,
): Promise<T[]> {
  try {
    return await paged((from, to) => run(true, from, to))
  } catch (err) {
    if (!isMissingColumn(err)) throw err
    return paged((from, to) => run(false, from, to))
  }
}

function chunks<T>(list: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function isMissingColumn(err: unknown): boolean {
  const e = err as PgError | null
  return e?.code === '42703' || e?.code === 'PGRST204' || /column .* does not exist/i.test(e?.message ?? '')
}

interface ConversationRow {
  id: string
  contact_id: string | null
  channel: string | null
  created_at: string
}

async function conversationsForContacts(
  db: SupabaseClient,
  accountId: string,
  contactIds: string[],
): Promise<ConversationRow[]> {
  const out: ConversationRow[] = []
  for (const ids of chunks([...new Set(contactIds)])) {
    const rows = await paged<ConversationRow>((from, to) =>
      db
        .from('conversations')
        .select('id, contact_id, channel, created_at')
        .eq('account_id', accountId)
        .in('contact_id', ids)
        .order('created_at', { ascending: true })
        .range(from, to),
    )
    out.push(...rows)
  }
  return out
}

/** A contact's channel: the one its first conversation came in on. */
function firstChannelByContact(conversations: ConversationRow[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of [...conversations].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (c.contact_id && !map.has(c.contact_id)) map.set(c.contact_id, c.channel || 'whatsapp')
  }
  return map
}

function matchesChannel(channel: ReportChannel, value: string) {
  return channel === 'all' || channel === value
}

export async function loadReportMessages(
  db: SupabaseClient,
  accountId: string,
  range: DayRange,
  channel: ReportChannel,
): Promise<ReportMessage[]> {
  const { fromISO, toISO } = rangeInstants(range)
  return paged<ReportMessage>((from, to) => {
    let q = db
      .from('messages')
      .select('conversation_id, sender_type, ai_generated, content_type, created_at, conversations!inner(account_id, channel)')
      .eq('conversations.account_id', accountId)
      .gte('created_at', fromISO)
      .lt('created_at', toISO)
    if (channel !== 'all') q = q.eq('conversations.channel', channel)
    return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to)
  })
}

async function loadNewContactChannels(
  db: SupabaseClient,
  accountId: string,
  range: DayRange,
  channel: ReportChannel,
): Promise<string[]> {
  const { fromISO, toISO } = rangeInstants(range)
  const contacts = await pagedReal<{ id: string }>((realOnly, from, to) => {
    let q = db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .gte('created_at', fromISO)
      .lt('created_at', toISO)
    if (realOnly) q = q.eq('is_sample', false)
    return q.order('created_at', { ascending: true }).range(from, to)
  })
  if (contacts.length === 0) return []
  const firstChannel = firstChannelByContact(
    await conversationsForContacts(db, accountId, contacts.map((c) => c.id)),
  )
  return contacts
    .map((c) => firstChannel.get(c.id) ?? 'other')
    .filter((ch) => matchesChannel(channel, ch))
}

interface DealRow {
  id: string
  contact_id: string | null
  conversation_id: string | null
  value: number | null
  currency: string | null
  closed_at: string | null
  updated_at: string
}

async function loadWonDeals(
  db: SupabaseClient,
  accountId: string,
  range: DayRange,
  channel: ReportChannel,
): Promise<WonDeal[]> {
  const { fromISO, toISO } = rangeInstants(range)
  const deals = await paged<DealRow>((from, to) =>
    db
      .from('deals')
      .select('id, contact_id, conversation_id, value, currency, closed_at, updated_at')
      .eq('account_id', accountId)
      .eq('status', 'won')
      .gte('closed_at', fromISO)
      .lt('closed_at', toISO)
      .order('closed_at', { ascending: true })
      .range(from, to),
  )
  if (deals.length === 0) return []

  const contactIds = deals.map((d) => d.contact_id).filter((id): id is string => !!id)
  const conversations = await conversationsForContacts(db, accountId, contactIds)
  const firstChannel = firstChannelByContact(conversations)
  const convChannel = new Map(conversations.map((c) => [c.id, c.channel || 'whatsapp']))

  // Earliest AI message per contact, across all of its conversations.
  const contactOfConv = new Map(conversations.map((c) => [c.id, c.contact_id]))
  const firstAiAt = new Map<string, string>()
  for (const ids of chunks(conversations.map((c) => c.id))) {
    const rows = await paged<{ conversation_id: string; created_at: string }>((from, to) =>
      db
        .from('messages')
        .select('conversation_id, created_at')
        .in('conversation_id', ids)
        .eq('ai_generated', true)
        .order('created_at', { ascending: true })
        .range(from, to),
    )
    for (const r of rows) {
      const contact = contactOfConv.get(r.conversation_id)
      if (!contact) continue
      const prev = firstAiAt.get(contact)
      if (!prev || r.created_at < prev) firstAiAt.set(contact, r.created_at)
    }
  }

  // A deal's conversation is normally one of its contact's; look up any
  // that isn't (e.g. a deal whose contact was changed).
  const missingConv = deals
    .map((d) => d.conversation_id)
    .filter((id): id is string => !!id && !convChannel.has(id))
  for (const ids of chunks([...new Set(missingConv)])) {
    const { data } = await db.from('conversations').select('id, channel').eq('account_id', accountId).in('id', ids)
    for (const c of data ?? []) convChannel.set(c.id, c.channel || 'whatsapp')
  }

  return deals
    .map((d) => {
      const ch =
        (d.conversation_id && convChannel.get(d.conversation_id)) ||
        (d.contact_id && firstChannel.get(d.contact_id)) ||
        'other'
      const closedAt = d.closed_at ?? d.updated_at
      const aiAt = d.contact_id ? firstAiAt.get(d.contact_id) : undefined
      return { value: d.value, currency: d.currency, channel: ch, aiAssisted: !!aiAt && aiAt < closedAt }
    })
    .filter((d) => matchesChannel(channel, d.channel))
}

async function loadBookingCounts(
  db: SupabaseClient,
  accountId: string,
  range: DayRange,
  channel: ReportChannel,
): Promise<{ total: number; byAi: number }> {
  const { fromISO, toISO } = rangeInstants(range)
  const rows = await pagedReal<{ created_by: string | null; conversation_id: string | null }>((realOnly, from, to) => {
    let q = db
      .from('bookings')
      .select('created_by, conversation_id')
      .eq('account_id', accountId)
      .not('status', 'in', '(cancelled,no_show)')
      .gte('created_at', fromISO)
      .lt('created_at', toISO)
    if (realOnly) q = q.eq('is_sample', false)
    return q.order('created_at', { ascending: true }).range(from, to)
  })
  let filtered = rows
  if (channel !== 'all') {
    const convIds = [...new Set(rows.map((r) => r.conversation_id).filter((id): id is string => !!id))]
    const channelOf = new Map<string, string>()
    for (const ids of chunks(convIds)) {
      const { data } = await db.from('conversations').select('id, channel').eq('account_id', accountId).in('id', ids)
      for (const c of data ?? []) channelOf.set(c.id, c.channel || 'whatsapp')
    }
    filtered = rows.filter((r) => r.conversation_id && channelOf.get(r.conversation_id) === channel)
  }
  // The AI books with created_by = null; people book as themselves.
  return { total: filtered.length, byAi: filtered.filter((r) => !r.created_by).length }
}

export async function loadReportOverview(
  db: SupabaseClient,
  accountId: string,
  range: DayRange,
  channel: ReportChannel,
): Promise<ReportOverview> {
  const unavailable: string[] = []
  const tolerant = async <T>(name: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (err) {
      if (isMissingColumn(err)) {
        unavailable.push(name)
        return fallback
      }
      throw err
    }
  }

  const [messages, newContactChannels, wonDeals, bookings] = await Promise.all([
    loadReportMessages(db, accountId, range, channel),
    loadNewContactChannels(db, accountId, range, channel),
    tolerant('deals', [] as WonDeal[], () => loadWonDeals(db, accountId, range, channel)),
    tolerant('bookings', { total: 0, byAi: 0 }, () => loadBookingCounts(db, accountId, range, channel)),
  ])

  return computeOverview({ range, channel, messages, newContactChannels, wonDeals, bookings, unavailable })
}
