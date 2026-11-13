import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { loadInstagramConnection } from '@/lib/instagram/connection'
import { syncInstagramPosts } from '@/lib/instagram/comments'
import { instagramGuard } from '@/lib/instagram/page-api'

// "Sincronizar": pulls the latest posts and reels now. Admins only.
export async function POST() {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard.response
  const admin = supabaseAdmin()
  const conn = await loadInstagramConnection(admin, guard.ctx.accountId)
  if (!conn) return NextResponse.json({ error: 'not_connected' }, { status: 409 })
  try {
    const count = await syncInstagramPosts(admin, conn)
    return NextResponse.json({ ok: true, count })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/does not exist|schema cache/i.test(message)) return NextResponse.json({ error: 'needs_migration' }, { status: 503 })
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
