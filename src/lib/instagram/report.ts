import type { SupabaseClient } from '@supabase/supabase-js'
import type { DayRange } from '@/lib/bookings/ranges'
import { rangeInstants } from '@/lib/reports/range'

// ============================================================
// Phase 5 (module `instagram_reports`): per post, the funnel
//   comments → handled (rule / AI) → DMs sent → customers who answered
//   → leads (a deal created after the comment) → sales (won deals).
// computePostReport is pure; loadPostReport pages past Supabase's
// 1000-row cap with the service-role client.
// ============================================================

export interface ReportComment {
  media_id: string | null
  igsid: string
  rule_id: string | null
  ai_category: string | null
  dm_status: string | null
  contact_id: string | null
  conversation_id: string | null
  created_at: string
  source: string | null
}

export interface ReportDeal {
  contact_id: string | null
  created_at: string
  status: string | null
  value: number | null
  currency: string | null
}

export interface PostFunnel {
  mediaId: string | null
  comments: number
  byRule: number
  byAi: number
  dmsSent: number
  queued: number
  replied: number
  leads: number
  sales: number
  revenue: Record<string, number>
}

const SENT = new Set(['sent', 'awaiting_tap', 'delivered'])

function emptyFunnel(mediaId: string | null): PostFunnel {
  return { mediaId, comments: 0, byRule: 0, byAi: 0, dmsSent: 0, queued: 0, replied: 0, leads: 0, sales: 0, revenue: {} }
}

/**
 * The funnel per post plus the total. `repliedConversations` maps a
 * conversation to its customer messages' times; a comment counts as
 * answered when the customer wrote after it. Leads and sales count each
 * contact once per post, from deals created after their first comment.
 * Pure.
 */
export function computePostReport(input: {
  comments: ReportComment[]
  deals: ReportDeal[]
  customerMessages: Map<string, string[]>
}): { posts: PostFunnel[]; total: PostFunnel } {
  const byPost = new Map<string, PostFunnel>()
  const firstComment = new Map<string, Map<string, string>>() // post → contact → first comment at
  const repliedKeys = new Set<string>()

  for (const c of input.comments) {
    if (c.source && c.source !== 'comment' && c.source !== 'live') continue
    const key = c.media_id ?? ''
    const f = byPost.get(key) ?? emptyFunnel(c.media_id)
    byPost.set(key, f)
    f.comments += 1
    if (c.rule_id) f.byRule += 1
    else if (c.ai_category) f.byAi += 1
    if (c.dm_status && SENT.has(c.dm_status)) f.dmsSent += 1
    if (c.dm_status === 'queued') f.queued += 1
    if (c.conversation_id) {
      const times = input.customerMessages.get(c.conversation_id) ?? []
      const replyKey = `${key}|${c.conversation_id}`
      if (!repliedKeys.has(replyKey) && times.some((t) => t > c.created_at)) {
        repliedKeys.add(replyKey)
        f.replied += 1
      }
    }
    if (c.contact_id) {
      const contacts = firstComment.get(key) ?? new Map<string, string>()
      firstComment.set(key, contacts)
      const prev = contacts.get(c.contact_id)
      if (!prev || c.created_at < prev) contacts.set(c.contact_id, c.created_at)
    }
  }

  const dealsByContact = new Map<string, ReportDeal[]>()
  for (const d of input.deals) {
    if (!d.contact_id) continue
    dealsByContact.set(d.contact_id, [...(dealsByContact.get(d.contact_id) ?? []), d])
  }
  for (const [key, contacts] of firstComment) {
    const f = byPost.get(key)!
    for (const [contactId, at] of contacts) {
      const after = (dealsByContact.get(contactId) ?? []).filter((d) => d.created_at >= at)
      if (after.length === 0) continue
      f.leads += 1
      const won = after.filter((d) => d.status === 'won')
      if (won.length) f.sales += 1
      for (const d of won) {
        const cur = d.currency || 'USD'
        f.revenue[cur] = (f.revenue[cur] ?? 0) + (Number(d.value) || 0)
      }
    }
  }

  const posts = [...byPost.values()].sort((a, b) => b.comments - a.comments)
  const total = emptyFunnel(null)
  for (const f of posts) {
    for (const k of ['comments', 'byRule', 'byAi', 'dmsSent', 'queued', 'replied', 'leads', 'sales'] as const) total[k] += f[k]
    for (const [cur, v] of Object.entries(f.revenue)) total.revenue[cur] = (total.revenue[cur] ?? 0) + v
  }
  return { posts, total }
}

const PAGE = 1000
export const IN_CHUNK = 150

export async function paged<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string; message?: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Loads the range's comments, then the deals and answers of their contacts. */
export async function loadPostReport(db: SupabaseClient, accountId: string, range: DayRange) {
  const { fromISO, toISO } = rangeInstants(range)
  let comments: ReportComment[]
  try {
    comments = await paged<ReportComment>((from, to) =>
      db
        .from('instagram_comments')
        .select('media_id, igsid, rule_id, ai_category, dm_status, contact_id, conversation_id, created_at, source')
        .eq('account_id', accountId)
        .gte('created_at', fromISO)
        .lt('created_at', toISO)
        .order('created_at', { ascending: true })
        .range(from, to),
    )
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === '42703' || code === '42P01' || code === 'PGRST205') return { migrated: false as const }
    throw err
  }

  const contactIds = [...new Set(comments.map((c) => c.contact_id).filter((v): v is string => !!v))]
  const conversationIds = [...new Set(comments.map((c) => c.conversation_id).filter((v): v is string => !!v))]
  const deals: ReportDeal[] = []
  for (const ids of chunks(contactIds, IN_CHUNK)) {
    deals.push(
      ...(await paged<ReportDeal>((from, to) =>
        db
          .from('deals')
          .select('contact_id, created_at, status, value, currency')
          .eq('account_id', accountId)
          .in('contact_id', ids)
          .gte('created_at', fromISO)
          .order('created_at', { ascending: true })
          .range(from, to),
      )),
    )
  }
  const customerMessages = new Map<string, string[]>()
  for (const ids of chunks(conversationIds, IN_CHUNK)) {
    const rows = await paged<{ conversation_id: string; created_at: string }>((from, to) =>
      db
        .from('messages')
        .select('conversation_id, created_at')
        .in('conversation_id', ids)
        .eq('sender_type', 'customer')
        .gte('created_at', fromISO)
        .order('created_at', { ascending: true })
        .range(from, to),
    )
    for (const r of rows) customerMessages.set(r.conversation_id, [...(customerMessages.get(r.conversation_id) ?? []), r.created_at])
  }

  const report = computePostReport({ comments, deals, customerMessages })
  const mediaIds = report.posts.map((p) => p.mediaId).filter((v): v is string => !!v)
  const postInfo: Record<string, { caption: string | null; permalink: string | null; thumbnail: string | null; kind: string | null }> = {}
  for (const ids of chunks(mediaIds, IN_CHUNK)) {
    const { data } = await db
      .from('instagram_posts')
      .select('media_id, caption, permalink, thumbnail_url, media_url, media_type, media_product_type')
      .eq('account_id', accountId)
      .in('media_id', ids)
    for (const p of data ?? []) {
      postInfo[p.media_id as string] = {
        caption: (p.caption as string | null) ?? null,
        permalink: (p.permalink as string | null) ?? null,
        thumbnail: ((p.thumbnail_url as string | null) || (p.media_type === 'VIDEO' ? null : (p.media_url as string | null))) ?? null,
        kind: (p.media_product_type as string | null) ?? null,
      }
    }
  }
  return { migrated: true as const, range, ...report, postInfo }
}
