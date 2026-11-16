import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { runAutomationById } from '@/lib/automations/engine'
import type { InstagramConnection } from './connection'
import { loadKeywordRules } from './comments'
import { runRule } from './engagement'
import { instagramEngineSendText } from './send'
import { loadInstagramSettings } from './settings'
import { chunks, IN_CHUNK, paged } from './report'
import { rangeInstants } from '@/lib/reports/range'
import type { DayRange } from '@/lib/bookings/ranges'

// ============================================================
// Campaign links and QR codes (module `instagram_links`, migration 083).
//
// The owner creates a link with a code (e.g. QR_LOCAL). Its public short
// URL <site>/go/<slug> counts the click and sends the person to
// ig.me/m/<account>?ref=<code>, which opens the business's Instagram
// chat. Meta then passes `ref` back — as a referral event when the
// person opens the chat, or on their first message — and webhook.ts
// saves it on conversations.source ({ type: 'link', ref }). Here the
// link's action runs once per chat (24h): a welcome message, a keyword
// rule, an automation, or the AI (which also gets the link's context in
// its prompt for the rest of the chat, see linkPromptForConversation).
// ============================================================

export const LINK_ACTIONS = ['message', 'ai', 'rule', 'automation'] as const
export type LinkAction = (typeof LINK_ACTIONS)[number]

export interface InstagramLink {
  id: string
  account_id: string
  name: string
  code: string
  slug: string
  action: LinkAction
  welcome_text: string | null
  ai_context: string | null
  rule_id: string | null
  automation_id: string | null
  tag_id: string | null
  active: boolean
  is_sample: boolean
  created_at: string
}

/** How long one arrival counts: the same person reopening the link the next day starts again. */
export const ARRIVAL_WINDOW_MS = 24 * 60 * 60 * 1000

const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/

/** A code as the owner types it → the stored form (or null when invalid). Pure. */
export function normalizeLinkCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw
    .trim()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '_')
    .toUpperCase()
  return CODE_RE.test(code) ? code : null
}

/** A random short id for /go/<slug> (no look-alike characters). */
export function newLinkSlug(random: () => number = Math.random): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length]
  return out
}

/** Where the link sends the person: the business's Instagram chat with the code. Pure. */
export function igMeUrl(username: string, code: string): string {
  return `https://ig.me/m/${encodeURIComponent(username)}?ref=${encodeURIComponent(code)}`
}

/** The public short URL (it counts the click). Pure. */
export function shortLinkUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/go/${slug}`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * The page /go/<slug> shows: one button to the Instagram chat. iOS only
 * opens the app from a tapped link, never at the end of redirects. Pure.
 */
export function linkLandingHtml(args: { url: string; username: string; business: string | null }): string {
  const url = escapeHtml(args.url)
  const user = escapeHtml(args.username)
  const title = escapeHtml(args.business?.trim() || `@${args.username}`)
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title>
<style>
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#f4f4f5;color:#18181b}
main{width:100%;max-width:22rem;margin:1rem;padding:2rem 1.5rem;background:#fff;border-radius:1rem;box-shadow:0 4px 20px rgba(0,0,0,.08);text-align:center}
.logo{width:4rem;height:4rem;margin:0 auto 1rem;border-radius:1rem;background:linear-gradient(45deg,#f58529,#dd2a7b,#8134af);display:flex;align-items:center;justify-content:center;color:#fff;font-size:2rem}
h1{font-size:1.25rem;margin:0 0 .25rem}p{margin:0 0 1.5rem;color:#71717a;font-size:.95rem}
a.btn{display:block;padding:.9rem 1rem;border-radius:.75rem;background:linear-gradient(45deg,#f58529,#dd2a7b,#8134af);color:#fff;font-weight:600;text-decoration:none;font-size:1rem}
small{display:block;margin-top:1rem;color:#a1a1aa}
</style></head>
<body><main><div class="logo">&#9993;</div><h1>${title}</h1><p>Escríbenos por Instagram y te atendemos al momento.</p>
<a class="btn" href="${url}">Abrir chat en Instagram</a><small>@${user}</small></main></body></html>`
}

/** Meta's ref may come back with other characters around it; compare like this. Pure. */
export function sameCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The link's lines for the DM agent's system prompt. Pure. */
export function formatLinkForAgent(link: Pick<InstagramLink, 'name' | 'code' | 'ai_context'>): string {
  const lines = [
    `This customer opened the chat from the campaign link "${link.name}" (code ${link.code}).`,
  ]
  if (link.ai_context?.trim()) lines.push(link.ai_context.trim().slice(0, 2000))
  lines.push('Keep this in mind when they say "the promo", "what I saw" or "the QR".')
  return lines.join('\n')
}

export interface LinkStats {
  clicks: number
  chats: number
  newContacts: number
  deals: number
  won: number
  revenue: number
}

export interface LinkEventRow {
  link_id: string
  kind: 'click' | 'open'
  contact_id: string | null
  is_new_contact: boolean
  created_at: string
}

export interface LinkDealRow {
  contact_id: string | null
  status: string | null
  value: number | null
  created_at: string
}

/**
 * Per link: clicks, chats opened, new contacts, and the deals those
 * contacts got after their first arrival by that link (won + revenue).
 * Pure.
 */
export function computeLinkStats(events: LinkEventRow[], deals: LinkDealRow[]): Map<string, LinkStats> {
  const out = new Map<string, LinkStats>()
  const firstArrival = new Map<string, Map<string, number>>() // link → contact → first open
  const get = (id: string) => {
    let s = out.get(id)
    if (!s) {
      s = { clicks: 0, chats: 0, newContacts: 0, deals: 0, won: 0, revenue: 0 }
      out.set(id, s)
    }
    return s
  }
  for (const e of events) {
    const s = get(e.link_id)
    if (e.kind === 'click') {
      s.clicks++
      continue
    }
    s.chats++
    if (e.is_new_contact) s.newContacts++
    if (e.contact_id) {
      const byContact = firstArrival.get(e.link_id) ?? new Map<string, number>()
      const at = new Date(e.created_at).getTime()
      const prev = byContact.get(e.contact_id)
      if (prev === undefined || at < prev) byContact.set(e.contact_id, at)
      firstArrival.set(e.link_id, byContact)
    }
  }
  for (const [linkId, byContact] of firstArrival) {
    const s = get(linkId)
    for (const d of deals) {
      if (!d.contact_id) continue
      const arrived = byContact.get(d.contact_id)
      if (arrived === undefined || new Date(d.created_at).getTime() < arrived) continue
      s.deals++
      if (d.status === 'won') {
        s.won++
        s.revenue += Number(d.value) || 0
      }
    }
  }
  return out
}

// ---------- server ----------

const LINK_COLUMNS =
  'id, account_id, name, code, slug, action, welcome_text, ai_context, rule_id, automation_id, tag_id, active, is_sample, created_at'

/** An active link by its code, or null (none, inactive, migration 083 not run). */
export async function findLinkByCode(db: SupabaseClient, accountId: string, code: string): Promise<InstagramLink | null> {
  const { data, error } = await db.from('instagram_links').select(LINK_COLUMNS).eq('account_id', accountId).eq('active', true)
  if (error || !data) return null
  return ((data as InstagramLink[]).find((l) => sameCode(l.code, code)) ?? null)
}

export interface LinkOutcome {
  /** The link answered this message; flows, automations and the AI skip it. */
  handled: boolean
}

const NOT_HANDLED: LinkOutcome = { handled: false }

/**
 * Someone arrived by a campaign link: logs the arrival once per chat
 * (24h), tags the contact, and runs the link's action once. `hasMessage`
 * is false for Meta's referral event (they opened the chat but haven't
 * written yet). Best-effort: failures fall back to the normal pipeline.
 */
export async function handleLinkArrival(
  db: SupabaseClient,
  conn: InstagramConnection,
  args: {
    ref: string
    igsid: string
    contactId: string
    conversationId: string
    isNewContact: boolean
    hasMessage: boolean
  },
): Promise<LinkOutcome> {
  try {
    if (!(await accountModuleEnabled(db, conn.accountId, 'instagram_links'))) return NOT_HANDLED
    const link = await findLinkByCode(db, conn.accountId, args.ref)
    if (!link) return NOT_HANDLED

    const since = new Date(Date.now() - ARRIVAL_WINDOW_MS).toISOString()
    const { data: existing } = await db
      .from('instagram_link_events')
      .select('id, replied')
      .eq('conversation_id', args.conversationId)
      .eq('link_id', link.id)
      .eq('kind', 'open')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    let eventId = (existing?.id as string | undefined) ?? null
    if (existing?.replied) return NOT_HANDLED

    if (!eventId) {
      const { data: inserted, error } = await db
        .from('instagram_link_events')
        .insert({
          account_id: conn.accountId,
          link_id: link.id,
          kind: 'open',
          contact_id: args.contactId,
          conversation_id: args.conversationId,
          igsid: args.igsid,
          is_new_contact: args.isNewContact,
        })
        .select('id')
        .single()
      if (error) {
        console.error('[instagram] logging the link arrival failed:', error)
        return NOT_HANDLED
      }
      eventId = inserted.id as string
      if (link.tag_id) {
        await addContactTagAndDispatch({
          db,
          accountId: conn.accountId,
          contactId: args.contactId,
          tagId: link.tag_id,
          context: { conversation_id: args.conversationId },
        }).catch((err) => console.error('[instagram] tagging the link contact failed:', err))
      }
    }

    const base = { accountId: conn.accountId, conversationId: args.conversationId, contactId: args.contactId }
    const ran = await runLinkAction(db, conn, link, base, args)
    if (ran.done) await db.from('instagram_link_events').update({ replied: true }).eq('id', eventId)
    return { handled: ran.handled }
  } catch (err) {
    console.error('[instagram] campaign link handling failed:', err)
    return NOT_HANDLED
  }
}

async function runLinkAction(
  db: SupabaseClient,
  conn: InstagramConnection,
  link: InstagramLink,
  base: { accountId: string; conversationId: string; contactId: string },
  args: { igsid: string; hasMessage: boolean },
): Promise<{ done: boolean; handled: boolean }> {
  const welcome = link.welcome_text?.trim() ?? ''
  // The AI answers what they wrote, knowing the link (prompt). With no
  // message yet, the welcome (if any) greets them meanwhile.
  if (link.action === 'ai') {
    if (args.hasMessage) return { done: true, handled: false }
    if (!welcome) return { done: false, handled: false }
    return (await sendText(base, welcome)) ? { done: true, handled: false } : { done: false, handled: false }
  }
  if (welcome && !(await sendText(base, welcome))) return { done: false, handled: false }
  if (link.action === 'message') return { done: !!welcome, handled: !!welcome }

  if (link.action === 'rule' && link.rule_id) {
    const rules = await loadKeywordRules(db, conn.accountId)
    const rule = rules.find((r) => r.id === link.rule_id)
    if (!rule) return { done: !!welcome, handled: !!welcome }
    const settings = await loadInstagramSettings(db, conn.accountId)
    await runRule(db, conn, rule, base, args.igsid, settings)
    return { done: true, handled: true }
  }
  if (link.action === 'automation' && link.automation_id) {
    await runAutomationById({
      accountId: conn.accountId,
      automationId: link.automation_id,
      contactId: base.contactId,
      context: { conversation_id: base.conversationId, vars: { instagram_link: link.name } },
    })
    return { done: true, handled: true }
  }
  return { done: !!welcome, handled: !!welcome }
}

async function sendText(base: { accountId: string; conversationId: string; contactId: string }, text: string): Promise<boolean> {
  try {
    await instagramEngineSendText({ ...base, text })
    return true
  } catch (err) {
    // Meta may refuse a message before the person writes; it goes with their first message.
    console.error('[instagram] sending the link welcome failed:', err)
    return false
  }
}

/**
 * The ref of a chat that arrived by a link in the last 24h and whose
 * action hasn't run yet (Meta refused the welcome before they wrote).
 */
export async function pendingLinkRef(db: SupabaseClient, conversationId: string): Promise<string | null> {
  const { data, error } = await db.from('conversations').select('source').eq('id', conversationId).maybeSingle()
  if (error || !data?.source) return null
  const source = data.source as { type?: string; ref?: string | null; at?: string }
  if (source.type !== 'link' || !source.ref) return null
  if (source.at && Date.now() - new Date(source.at).getTime() > ARRIVAL_WINDOW_MS) return null
  return source.ref
}

/** The DM agent's block for a chat that came by a campaign link (null otherwise). Best-effort. */
export async function linkPromptForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    if (!(await accountModuleEnabled(db, accountId, 'instagram_links'))) return null
    const { data, error } = await db.from('conversations').select('source').eq('id', conversationId).maybeSingle()
    if (error || !data?.source) return null
    const source = data.source as { type?: string; ref?: string | null }
    if (source.type !== 'link' || !source.ref) return null
    const link = await findLinkByCode(db, accountId, source.ref)
    return link ? formatLinkForAgent(link) : null
  } catch (err) {
    console.error('[instagram] loading the campaign link failed:', err)
    return null
  }
}

// ---------- request bodies ----------

const UUID_RE = /^[0-9a-f-]{36}$/i

function cleanText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function idOrNull(value: unknown): string | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' && UUID_RE.test(value) ? value : 'invalid'
}

/**
 * Link fields from a request body (`partial` = PATCH). The action needs
 * what it sends: a welcome text for "message", a rule or an automation.
 * Pure.
 */
export function parseLinkInput(raw: unknown, partial: boolean): { input: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'invalid_body' }
  const body = raw as Record<string, unknown>
  const input: Record<string, unknown> = {}
  if (!partial || 'name' in body) {
    const name = cleanText(body.name, 120)
    if (!name) return { error: 'name_required' }
    input.name = name
  }
  if (!partial || 'code' in body) {
    const code = normalizeLinkCode(body.code)
    if (!code) return { error: 'invalid_code' }
    input.code = code
  }
  if (!partial || 'action' in body) {
    if (!(LINK_ACTIONS as readonly string[]).includes(body.action as string)) return { error: 'invalid_action' }
    input.action = body.action
  }
  if (!partial || 'welcome_text' in body) input.welcome_text = cleanText(body.welcome_text, 1000)
  if (!partial || 'ai_context' in body) input.ai_context = cleanText(body.ai_context, 2000)
  for (const key of ['rule_id', 'automation_id', 'tag_id'] as const) {
    if (!partial || key in body) {
      const id = idOrNull(body[key])
      if (id === 'invalid') return { error: 'invalid_reference' }
      input[key] = id
    }
  }
  if ('active' in body) input.active = body.active !== false
  if (!partial) {
    const problem = linkProblem(input as Partial<InstagramLink>)
    if (problem) return { error: problem }
  }
  return { input }
}

/** What a complete link lacks for its action, or null. Pure. */
export function linkProblem(link: Partial<InstagramLink>): string | null {
  if (link.action === 'message' && !link.welcome_text?.trim()) return 'welcome_required'
  if (link.action === 'rule' && !link.rule_id) return 'rule_required'
  if (link.action === 'automation' && !link.automation_id) return 'automation_required'
  return null
}

// ---------- results ----------

/** Each link's results for a business-local day range. Empty when 083 hasn't run. */
export async function loadLinkStats(db: SupabaseClient, accountId: string, range: DayRange): Promise<Map<string, LinkStats>> {
  const { fromISO, toISO } = rangeInstants(range)
  try {
    const events = await paged<LinkEventRow>((from, to) =>
      db
        .from('instagram_link_events')
        .select('link_id, kind, contact_id, is_new_contact, created_at')
        .eq('account_id', accountId)
        .gte('created_at', fromISO)
        .lt('created_at', toISO)
        .order('created_at', { ascending: true })
        .range(from, to),
    )
    const contactIds = [...new Set(events.map((e) => e.contact_id).filter((v): v is string => !!v))]
    const deals: LinkDealRow[] = []
    for (const ids of chunks(contactIds, IN_CHUNK)) {
      deals.push(
        ...(await paged<LinkDealRow>((from, to) =>
          db
            .from('deals')
            .select('contact_id, status, value, created_at')
            .eq('account_id', accountId)
            .in('contact_id', ids)
            .gte('created_at', fromISO)
            .order('created_at', { ascending: true })
            .range(from, to),
        )),
      )
    }
    return computeLinkStats(events, deals)
  } catch (err) {
    console.error('[instagram] loading the link results failed:', err)
    return new Map()
  }
}
