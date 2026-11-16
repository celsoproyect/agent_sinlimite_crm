import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'
import { loadInstagramConnection } from '@/lib/instagram/connection'
import { igMeUrl, linkLandingHtml } from '@/lib/instagram/links'

// Public short URL of a campaign link (module instagram_links, 083):
// counts the click and shows a small page with an "Open the chat in
// Instagram" button to ig.me/m/<account>?ref=<code>. Not a redirect: iOS
// only opens the Instagram app from a link the person taps, so after a
// chain of redirects it lands on instagram.com's login page instead.
// Unknown, inactive or switched-off links go to the site's home page.

export const dynamic = 'force-dynamic'

const BOT_RE = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord/i

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const home = new URL('/', request.url)
  if (!/^[a-z0-9]{4,16}$/.test(slug)) return NextResponse.redirect(home, 302)
  const db = supabaseAdmin()
  const { data: link } = await db
    .from('instagram_links')
    .select('id, account_id, code, active')
    .eq('slug', slug)
    .maybeSingle()
  if (!link?.active) return NextResponse.redirect(home, 302)
  const accountId = link.account_id as string
  if (!(await accountModuleEnabled(db, accountId, 'instagram')) || !(await accountModuleEnabled(db, accountId, 'instagram_links'))) {
    return NextResponse.redirect(home, 302)
  }
  const conn = await loadInstagramConnection(db, accountId)
  if (!conn?.username) return NextResponse.redirect(home, 302)

  // Link previews (WhatsApp, Telegram…) fetch the URL too; they aren't clicks.
  if (!BOT_RE.test(request.headers.get('user-agent') ?? '')) {
    const { error } = await db.from('instagram_link_events').insert({ account_id: accountId, link_id: link.id, kind: 'click' })
    if (error) console.error('[instagram] counting the link click failed:', error)
  }
  const { data: account } = await db.from('accounts').select('name').eq('id', accountId).maybeSingle()
  const html = linkLandingHtml({
    url: igMeUrl(conn.username, link.code as string),
    username: conn.username,
    business: (account?.name as string | null) ?? null,
  })
  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
