import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'

// Save / remove this browser's Web Push subscription for the current
// user (migration 071). Writes go through the service role so a device
// that was subscribed under another login is simply taken over by the
// current user (endpoint is unique); the user id always comes from the
// session, never the body.

function migrationPending(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205'
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'web_push'))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
    const body = (await request.json().catch(() => null)) as {
      endpoint?: unknown
      keys?: { p256dh?: unknown; auth?: unknown }
    } | null
    const endpoint = body?.endpoint
    const p256dh = body?.keys?.p256dh
    const auth = body?.keys?.auth
    if (!isHttpsUrl(endpoint) || !isKey(p256dh) || !isKey(auth)) {
      return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 })
    }
    const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null
    const { data, error } = await supabaseAdmin()
      .from('push_subscriptions')
      .upsert(
        {
          account_id: accountId,
          user_id: userId,
          endpoint,
          p256dh,
          auth,
          user_agent: userAgent,
        },
        { onConflict: 'endpoint' },
      )
      .select('id')
    if (error) {
      if (migrationPending(error.code)) {
        return NextResponse.json({ error: 'push_not_migrated' }, { status: 503 })
      }
      console.error('[push] subscribe failed:', error)
      return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    }
    if (!data?.length) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const { userId } = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null
    const endpoint = body?.endpoint
    if (typeof endpoint !== 'string' || !endpoint) {
      return NextResponse.json({ error: 'invalid_subscription' }, { status: 400 })
    }
    const { error } = await supabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', userId)
    if (error && !migrationPending(error.code)) {
      console.error('[push] unsubscribe failed:', error)
      return NextResponse.json({ error: 'delete_failed' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
