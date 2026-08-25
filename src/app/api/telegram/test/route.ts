import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { sendTelegramMessage } from '@/lib/telegram/send'

// "Send test message" button on the Channels settings UI — confirms
// the saved bot token + chat id actually work before the admin turns
// on lead notifications for real.
export async function POST(): Promise<NextResponse> {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data: account, error } = await supabase
      .from('accounts')
      .select('telegram_bot_token, telegram_chat_id')
      .eq('id', accountId)
      .single()

    if (error || !account?.telegram_bot_token || !account?.telegram_chat_id) {
      return NextResponse.json({ error: 'Save a bot token and detect a chat first' }, { status: 400 })
    }

    await sendTelegramMessage({
      botToken: account.telegram_bot_token,
      chatId: account.telegram_chat_id,
      text: '✅ CRM: este chat recibirá tus notificaciones de nuevos leads.',
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err)
    }
    console.error('[telegram test] failed:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
