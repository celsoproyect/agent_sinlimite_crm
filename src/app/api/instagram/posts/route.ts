import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadInstagramConnection } from '@/lib/instagram/connection'
import { syncInstagramPosts } from '@/lib/instagram/comments'
import { normalizeRule } from '@/lib/instagram/keywords'
import { normalizeInstagramSettings } from '@/lib/instagram/settings'
import { instagramDbError, instagramGuard, isMissingInstagramSchema } from '@/lib/instagram/page-api'

// /instagram page data: posts and reels, keyword rules, and what the rule
// form picks from (catalog items, tags). Any member reads. Posts are
// re-synced on the way when the newest sync is older than STALE_MS.

const STALE_MS = 12 * 60 * 60 * 1000
// `*` so the offer columns of migration 082 come along once it has run.
const POST_COLUMNS = '*'

export async function GET() {
  const guard = await instagramGuard('viewer')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const conn = await loadInstagramConnection(supabaseAdmin(), ctx.accountId)
  const postsQuery = () =>
    ctx.supabase
      .from('instagram_posts')
      .select(POST_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('posted_at', { ascending: false, nullsFirst: false })
      .limit(200)

  let posts = await postsQuery()
  if (posts.error) {
    if (isMissingInstagramSchema(posts.error.code)) {
      return NextResponse.json({ migrated: false, v2: false, connected: !!conn, posts: [], rules: [], catalog: [], tags: [], automations: [] })
    }
    return instagramDbError(posts.error)
  }

  const newest = (posts.data ?? []).reduce((max, p) => Math.max(max, new Date(p.synced_at as string).getTime()), 0)
  let syncError: string | null = null
  if (conn && Date.now() - newest > STALE_MS) {
    try {
      await syncInstagramPosts(supabaseAdmin(), conn)
      posts = await postsQuery()
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err)
    }
  }

  const [rules, catalog, tags, automations, ruleColumns, settingsRow] = await Promise.all([
    ctx.supabase.from('instagram_keyword_rules').select('*').eq('account_id', ctx.accountId).order('created_at'),
    ctx.supabase.from('ai_attachments').select('id, name, kind').eq('account_id', ctx.accountId).order('name').limit(500),
    ctx.supabase.from('tags').select('id, name, color').eq('account_id', ctx.accountId).order('name').limit(500),
    ctx.supabase.from('automations').select('id, name, trigger_type, is_active').eq('account_id', ctx.accountId).order('name').limit(500),
    // Migration 080 (several posts per rule, files, automations, examples).
    ctx.supabase.from('instagram_keyword_rules').select('media_ids', { head: true, count: 'exact' }).eq('account_id', ctx.accountId),
    // Migration 082 (comments AI, offers, triggers, ice breakers, queue).
    ctx.supabase.from('accounts').select('instagram_settings').eq('id', ctx.accountId).maybeSingle(),
  ])
  if (rules.error) return instagramDbError(rules.error)

  return NextResponse.json({
    migrated: true,
    connected: !!conn,
    username: conn?.username ?? null,
    syncError,
    posts: posts.data ?? [],
    v2: !ruleColumns.error,
    v3: !settingsRow.error,
    settings: normalizeInstagramSettings(settingsRow.data?.instagram_settings),
    rules: ((rules.data ?? []) as Record<string, unknown>[]).map(normalizeRule),
    catalog: catalog.data ?? [],
    tags: tags.data ?? [],
    automations: automations.data ?? [],
  })
}
