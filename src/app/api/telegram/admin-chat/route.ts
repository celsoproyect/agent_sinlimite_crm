import crypto from 'node:crypto'
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { setTelegramWebhook, deleteTelegramWebhook } from '@/lib/telegram/send'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST/DELETE /api/telegram/admin-chat
//
// Turns the Telegram ops-assistant (051) on/off for the caller's
// account. Admin-only — this registers a public webhook URL with
// Telegram and mints the secret that authenticates it, so it belongs
// next to the other settings-class Telegram actions (detect-chat,
// test), not something an 'agent' role should touch.
// ============================================================

function appUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || ''
  return raw.replace(/\/+$/, '')
}

export async function POST(): Promise<NextResponse> {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`telegram-admin-chat:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: account, error } = await supabase
      .from('accounts')
      .select('telegram_bot_token, telegram_chat_id')
      .eq('id', accountId)
      .single()
    if (error || !account?.telegram_bot_token || !account?.telegram_chat_id) {
      return NextResponse.json({ error: 'Save a bot token and detect a chat first' }, { status: 400 })
    }
    const base = appUrl()
    if (!base) {
      return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL is not configured' }, { status: 500 })
    }

    const secretToken = crypto.randomBytes(32).toString('hex')
    await setTelegramWebhook({
      botToken: account.telegram_bot_token,
      url: `${base}/api/telegram/webhook/${accountId}`,
      secretToken,
    })

    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ telegram_admin_chat_enabled: true, telegram_webhook_secret: secretToken })
      .eq('id', accountId)
    if (updateErr) throw updateErr

    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err)
    }
    console.error('[telegram admin-chat] enable failed:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}

export async function DELETE(): Promise<NextResponse> {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`telegram-admin-chat:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: account } = await supabase
      .from('accounts')
      .select('telegram_bot_token')
      .eq('id', accountId)
      .single()

    if (account?.telegram_bot_token) {
      try {
        await deleteTelegramWebhook(account.telegram_bot_token)
      } catch (err) {
        // Best-effort — even if Telegram's deleteWebhook call fails
        // (e.g. token was revoked), still disable locally so the
        // webhook route stops answering.
        console.error('[telegram admin-chat] deleteWebhook failed:', err)
      }
    }

    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ telegram_admin_chat_enabled: false, telegram_webhook_secret: null })
      .eq('id', accountId)
    if (updateErr) throw updateErr

    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err)
    }
    console.error('[telegram admin-chat] disable failed:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
