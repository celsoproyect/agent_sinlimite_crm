// ============================================================
// "Mensajes atendidos por la IA": every message the AI sent in a date
// range, newest first, with the customer message it answered.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import type { DayRange } from '@/lib/bookings/ranges'
import { rangeInstants } from './range'
import type { ReportChannel } from './overview'

export type AiMessageKind = 'all' | 'text' | 'media' | 'interactive'

export function parseAiMessageKind(v: string | null): AiMessageKind {
  return v === 'text' || v === 'media' || v === 'interactive' ? v : 'all'
}

const MEDIA_TYPES = ['image', 'video', 'document', 'audio']

export interface AiMessageRow {
  id: string
  conversationId: string
  channel: string
  contactName: string | null
  contactPhone: string | null
  contentType: string
  text: string | null
  createdAt: string
  /** The latest customer message before this reply, if any. */
  question: string | null
}

export interface AiMessagesPage {
  rows: AiMessageRow[]
  total: number
  page: number
  pageSize: number
}

/** Strip the characters PostgREST's filter grammar treats specially. */
export function sanitizeSearch(q: string): string {
  return q.replace(/[%*,()\\:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
}

interface Row {
  id: string
  conversation_id: string
  content_type: string
  content_text: string | null
  created_at: string
  conversations: {
    channel: string | null
    contact: { name: string | null; phone: string | null } | null
  } | null
}

export async function loadAiMessages(
  db: SupabaseClient,
  accountId: string,
  opts: {
    range: DayRange
    channel: ReportChannel
    kind: AiMessageKind
    q: string
    page: number
    pageSize: number
  },
): Promise<AiMessagesPage> {
  const { fromISO, toISO } = rangeInstants(opts.range)
  const page = Math.max(1, Math.floor(opts.page) || 1)
  const pageSize = Math.min(100, Math.max(10, opts.pageSize))
  const offset = (page - 1) * pageSize

  let query = db
    .from('messages')
    .select(
      'id, conversation_id, content_type, content_text, created_at, conversations!inner(account_id, channel, contact:contacts(name, phone))',
      { count: 'exact' },
    )
    .eq('conversations.account_id', accountId)
    .eq('ai_generated', true)
    .gte('created_at', fromISO)
    .lt('created_at', toISO)
  if (opts.channel !== 'all') query = query.eq('conversations.channel', opts.channel)
  if (opts.kind === 'text') query = query.eq('content_type', 'text')
  else if (opts.kind === 'interactive') query = query.eq('content_type', 'interactive')
  else if (opts.kind === 'media') query = query.in('content_type', MEDIA_TYPES)
  const q = sanitizeSearch(opts.q)
  if (q) query = query.ilike('content_text', `%${q}%`)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + pageSize - 1)
  if (error) throw error
  const rows = (data ?? []) as unknown as Row[]

  // The customer message each reply answered: the latest one before it in
  // the same conversation. One read covers the whole page.
  const questions = new Map<string, string | null>()
  if (rows.length > 0) {
    const convIds = [...new Set(rows.map((r) => r.conversation_id))]
    const oldest = rows[rows.length - 1].created_at
    const newest = rows[0].created_at
    const lookback = new Date(Date.parse(oldest) - 7 * 86_400_000).toISOString()
    const { data: asked } = await db
      .from('messages')
      .select('conversation_id, content_text, content_type, created_at')
      .in('conversation_id', convIds)
      .eq('sender_type', 'customer')
      .gte('created_at', lookback)
      .lte('created_at', newest)
      .order('created_at', { ascending: false })
      .limit(1000)
    const customer = (asked ?? []) as { conversation_id: string; content_text: string | null; content_type: string; created_at: string }[]
    for (const r of rows) {
      const hit = customer.find((c) => c.conversation_id === r.conversation_id && c.created_at < r.created_at)
      questions.set(r.id, hit ? hit.content_text || `[${hit.content_type}]` : null)
    }
  }

  return {
    rows: rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      channel: r.conversations?.channel || 'whatsapp',
      contactName: r.conversations?.contact?.name ?? null,
      contactPhone: r.conversations?.contact?.phone ?? null,
      contentType: r.content_type,
      text: r.content_text,
      createdAt: r.created_at,
      question: questions.get(r.id) ?? null,
    })),
    total: count ?? rows.length,
    page,
    pageSize,
  }
}
