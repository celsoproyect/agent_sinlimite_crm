import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import type { AccountRole } from '@/lib/auth/roles'
import { accountModuleEnabled } from '@/lib/modules-server'
import { cleanKeywords, RULE_TRIGGERS } from './keywords'

// Shared plumbing for the /instagram page routes (phase 2, migration 079).

/** "Relation/column does not exist": migration 079 not run yet. */
export function isMissingInstagramSchema(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205' || code === '42703'
}

export function instagramDbError(error: { code?: string; message: string }) {
  if (isMissingInstagramSchema(error.code)) return NextResponse.json({ error: 'needs_migration' }, { status: 503 })
  if (error.code === '23503') return NextResponse.json({ error: 'invalid_reference' }, { status: 400 })
  return NextResponse.json({ error: error.message }, { status: 500 })
}

/** The role and the instagram module on, or the error response to return. */
export async function instagramGuard(role: AccountRole): Promise<{ ctx: AccountContext } | { response: Response }> {
  let ctx: AccountContext
  try {
    ctx = await requireRole(role)
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'instagram'))) {
    return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
  }
  return { ctx }
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function uuidOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return undefined
  return /^[0-9a-f-]{36}$/i.test(value) ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : []
}

/** Keyword-rule fields from a request body. `partial` = PATCH. Pure. */
export function parseRuleInput(
  raw: unknown,
  partial: boolean,
): { input: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_body' }
  const b = raw as Record<string, unknown>
  const input: Record<string, unknown> = {}
  const want = (k: string) => !partial || k in b

  // Posts: `media_ids` (080), or the single `media_id` of older clients.
  if (want('media_ids') || want('media_id')) {
    const raw = 'media_ids' in b ? b.media_ids : b.media_id ? [b.media_id] : []
    if (raw !== null && raw !== undefined && !Array.isArray(raw)) return { error: 'invalid_media' }
    const ids: string[] = []
    for (const v of (raw ?? []) as unknown[]) {
      if (typeof v !== 'string' || !/^\d{5,40}$/.test(v)) return { error: 'invalid_media' }
      if (!ids.includes(v)) ids.push(v)
    }
    if (ids.length > 100) return { error: 'too_many_posts' }
    input.media_ids = ids
    input.media_id = ids[0] ?? null
  }
  if (want('name')) input.name = text(b.name, 80) ?? ''
  if (want('keywords')) input.keywords = cleanKeywords(stringList(b.keywords))
  if (want('match_any')) input.match_any = b.match_any === true
  if (want('public_replies')) {
    input.public_replies = stringList(b.public_replies)
      .map((r) => r.trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 10)
  }
  if (want('dm_opening')) input.dm_opening = text(b.dm_opening, 900)
  if (want('dm_button_label')) input.dm_button_label = text(b.dm_button_label, 20)
  if (want('dm_text')) input.dm_text = text(b.dm_text, 2000) ?? ''
  if (want('dm_link_url')) {
    const link = text(b.dm_link_url, 1000)
    if (link && !/^https?:\/\/\S+$/i.test(link)) return { error: 'invalid_link' }
    input.dm_link_url = link
  }
  if (want('dm_media_url')) {
    const url = text(b.dm_media_url, 1000)
    if (url && !/^https:\/\/\S+$/i.test(url)) return { error: 'invalid_file' }
    input.dm_media_url = url
    input.dm_media_kind = url ? (b.dm_media_kind === 'image' ? 'image' : 'document') : null
    input.dm_media_name = url ? text(b.dm_media_name, 120) : null
  }
  for (const key of ['catalog_item_id', 'tag_id', 'automation_id'] as const) {
    if (want(key)) {
      const id = uuidOrNull(b[key])
      if (id === undefined) return { error: `invalid_${key}` }
      input[key] = id
    }
  }
  // Migration 082: only sent by clients that know it ran.
  if ('triggers' in b) {
    const list = stringList(b.triggers).filter((t) => (RULE_TRIGGERS as readonly string[]).includes(t))
    if (list.length === 0) return { error: 'triggers_required' }
    input.triggers = [...new Set(list)]
  }
  if ('require_follow' in b) input.require_follow = b.require_follow === true
  if (want('once_per_user')) input.once_per_user = b.once_per_user !== false
  if (want('active')) input.active = b.active !== false

  if (!partial) {
    const problem = ruleProblem(input as unknown as RuleShape)
    if (problem) return { error: problem }
  }
  return { input }
}

interface RuleShape {
  keywords: string[]
  match_any: boolean
  public_replies: string[]
  dm_text: string
  dm_link_url: string | null
  catalog_item_id: string | null
  dm_button_label: string | null
  dm_media_url?: string | null
  automation_id?: string | null
}

/** Why a whole rule can't be saved, or null. Pure. */
export function ruleProblem(rule: RuleShape): string | null {
  if (!rule.match_any && rule.keywords.length === 0) return 'keywords_required'
  if (
    !rule.dm_text &&
    !rule.dm_link_url &&
    !rule.catalog_item_id &&
    !rule.dm_media_url &&
    !rule.automation_id &&
    rule.public_replies.length === 0
  ) {
    return 'reply_required'
  }
  // A private reply carries text only: a catalog picture or a file needs
  // the button (the customer's tap opens the window to send it), and so
  // does an automation, whose messages need that window too.
  if (rule.catalog_item_id && !rule.dm_button_label) return 'catalog_needs_button'
  if (rule.dm_media_url && !rule.dm_button_label) return 'file_needs_button'
  if (rule.automation_id && !rule.dm_button_label) return 'automation_needs_button'
  return null
}

/** A post's offer fields from a request body (migration 082). Pure. */
export function parseOfferInput(raw: unknown): { input: Record<string, unknown> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'invalid_body' }
  const b = raw as Record<string, unknown>
  const input: Record<string, unknown> = {}
  if ('offer_text' in b) input.offer_text = text(b.offer_text, 1500)
  if ('offer_link_url' in b) {
    const link = text(b.offer_link_url, 1000)
    if (link && !/^https?:\/\/\S+$/i.test(link)) return { error: 'invalid_link' }
    input.offer_link_url = link
  }
  if ('offer_media_url' in b) {
    const url = text(b.offer_media_url, 1000)
    if (url && !/^https:\/\/\S+$/i.test(url)) return { error: 'invalid_file' }
    input.offer_media_url = url
    input.offer_media_name = url ? text(b.offer_media_name, 120) : null
  }
  if ('offer_catalog_item_id' in b) {
    const id = uuidOrNull(b.offer_catalog_item_id)
    if (id === undefined) return { error: 'invalid_catalog_item_id' }
    input.offer_catalog_item_id = id
  }
  if ('offer_expires_on' in b) {
    const d = b.offer_expires_on
    if (d === null || d === '') input.offer_expires_on = null
    else if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) input.offer_expires_on = d
    else return { error: 'invalid_date' }
  }
  if ('ai_comments_enabled' in b) input.ai_comments_enabled = b.ai_comments_enabled !== false
  if (Object.keys(input).length === 0) return { error: 'invalid_body' }
  return { input }
}
