import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'
import { loadInstagramConnection } from '@/lib/instagram/connection'
import { instagramDbError, instagramGuard, isMissingInstagramSchema } from '@/lib/instagram/page-api'
import { igMeUrl, loadLinkStats, newLinkSlug, parseLinkInput, shortLinkUrl, type InstagramLink } from '@/lib/instagram/links'
import { appBaseUrl } from '@/lib/google-calendar/oauth'
import { parseReportRange } from '@/lib/reports/range'

// Campaign links (module instagram_links, migration 083). GET: the links
// with their short URL, ig.me URL and results for ?from=&to=, plus what
// the form picks from. Any member reads. POST: create (admins).

async function moduleGuard(role: 'viewer' | 'admin') {
  const guard = await instagramGuard(role)
  if ('response' in guard) return guard
  if (!(await accountModuleEnabled(guard.ctx.supabase, guard.ctx.accountId, 'instagram_links'))) {
    return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
  }
  return guard
}

export async function GET(request: Request) {
  const guard = await moduleGuard('viewer')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { searchParams } = new URL(request.url)
  const range = parseReportRange(searchParams.get('from'), searchParams.get('to'))

  const { data: links, error } = await ctx.supabase
    .from('instagram_links')
    .select('*')
    .eq('account_id', ctx.accountId)
    .order('created_at')
  if (error) {
    if (isMissingInstagramSchema(error.code)) return NextResponse.json({ migrated: false })
    return instagramDbError(error)
  }
  const admin = supabaseAdmin()
  const [conn, rules, automations, tags, stats] = await Promise.all([
    loadInstagramConnection(admin, ctx.accountId),
    ctx.supabase.from('instagram_keyword_rules').select('id, name, active').eq('account_id', ctx.accountId).order('name'),
    ctx.supabase.from('automations').select('id, name, is_active').eq('account_id', ctx.accountId).order('name').limit(500),
    ctx.supabase.from('tags').select('id, name, color').eq('account_id', ctx.accountId).order('name').limit(500),
    loadLinkStats(admin, ctx.accountId, range),
  ])
  const username = conn?.username ?? null
  const base = appBaseUrl()
  return NextResponse.json({
    migrated: true,
    connected: !!conn,
    username,
    range,
    links: ((links ?? []) as InstagramLink[]).map((l) => ({
      ...l,
      short_url: base ? shortLinkUrl(base, l.slug) : null,
      ig_url: username ? igMeUrl(username, l.code) : null,
      stats: stats.get(l.id) ?? { clicks: 0, chats: 0, newContacts: 0, deals: 0, won: 0, revenue: 0 },
    })),
    rules: rules.data ?? [],
    automations: automations.data ?? [],
    tags: tags.data ?? [],
  })
}

export async function POST(request: Request) {
  const guard = await moduleGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const parsed = parseLinkInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { data, error } = await ctx.supabase
    .from('instagram_links')
    .insert({ account_id: ctx.accountId, slug: newLinkSlug(), ...parsed.input })
    .select('*')
    .single()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'code_taken' }, { status: 409 })
    return instagramDbError(error)
  }
  return NextResponse.json({ link: data }, { status: 201 })
}
