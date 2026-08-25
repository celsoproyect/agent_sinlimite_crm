import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { getLatestTelegramChat } from '@/lib/telegram/send'

// Proxies Telegram's getUpdates lookup for the Channels settings UI's
// "Detect chat" button — Telegram's API doesn't send permissive CORS
// headers, so this can't be called directly from the browser. Reads
// the bot token the admin already saved on `accounts` (via direct
// supabase-js update, same pattern as the widget settings panel)
// rather than accepting one in the request body, so a caller can't
// use this account's session to probe an arbitrary bot token.
export async function POST(): Promise<NextResponse> {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data: account, error } = await supabase
      .from('accounts')
      .select('telegram_bot_token')
      .eq('id', accountId)
      .single()

    if (error || !account?.telegram_bot_token) {
      return NextResponse.json({ error: 'Save a bot token first' }, { status: 400 })
    }

    const chat = await getLatestTelegramChat(account.telegram_bot_token)
    if (!chat) {
      return NextResponse.json(
        { error: 'No messages found. Send any message to your bot in Telegram, then try again.' },
        { status: 404 },
      )
    }

    return NextResponse.json({ chat_id: chat.chatId, name: chat.name })
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err)
    }
    console.error('[telegram detect-chat] failed:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
