import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { setInstagramMessengerProfile, subscribeInstagramWebhooks } from '@/lib/instagram/api'
import { loadInstagramConnection } from '@/lib/instagram/connection'
import { profileInput } from '@/lib/instagram/engagement'
import { instagramDbError, instagramGuard, isMissingInstagramSchema } from '@/lib/instagram/page-api'
import { normalizeInstagramSettings, profileChanged } from '@/lib/instagram/settings'

// accounts.instagram_settings (migration 082): comments AI, story-mention
// thanks, follow text, ice breakers, menu and the hourly DM limit. Any
// member reads; admins save. Ice breakers and the menu are pushed to
// Instagram when they change.

export async function GET() {
  const guard = await instagramGuard('viewer')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { data, error } = await ctx.supabase.from('accounts').select('instagram_settings').eq('id', ctx.accountId).maybeSingle()
  if (error) {
    if (isMissingInstagramSchema(error.code)) return NextResponse.json({ migrated: false, settings: normalizeInstagramSettings(null) })
    return instagramDbError(error)
  }
  return NextResponse.json({ migrated: true, settings: normalizeInstagramSettings(data?.instagram_settings) })
}

export async function PUT(request: Request) {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

  const db = supabaseAdmin()
  const { data: current, error: readErr } = await db.from('accounts').select('instagram_settings').eq('id', ctx.accountId).maybeSingle()
  if (readErr) return instagramDbError(readErr)
  const before = normalizeInstagramSettings(current?.instagram_settings)
  const next = normalizeInstagramSettings({
    ...(body as Record<string, unknown>),
    profile_synced_at: before.profile_synced_at,
    profile_error: before.profile_error,
  })

  // Ice breakers and menu live on Instagram: push them when they change.
  if (profileChanged(before, next) || (body as { resync?: unknown }).resync === true) {
    const conn = await loadInstagramConnection(db, ctx.accountId)
    if (conn) {
      try {
        await setInstagramMessengerProfile(conn.accessToken, profileInput(next))
        next.profile_synced_at = new Date().toISOString()
        next.profile_error = null
      } catch (err) {
        next.profile_error = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      }
      // Accounts connected before live_comments existed pick it up here.
      await subscribeInstagramWebhooks(conn.accessToken).catch((err) =>
        console.error('[instagram] re-subscribing the webhooks failed:', err),
      )
    } else {
      next.profile_error = 'not_connected'
    }
  }

  const { data, error } = await db
    .from('accounts')
    .update({ instagram_settings: next })
    .eq('id', ctx.accountId)
    .select('instagram_settings')
  if (error) return instagramDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_saved' }, { status: 500 })
  return NextResponse.json({ settings: normalizeInstagramSettings(data[0].instagram_settings) })
}
