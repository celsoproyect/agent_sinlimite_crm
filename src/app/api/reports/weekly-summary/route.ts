import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { sendTelegramMessage } from '@/lib/telegram/send'
import { buildWeeklySummary } from '@/lib/reports/weekly-summary'

// "Enviar resumen ahora" in Canales → Telegram: sends last week's
// summary (Monday–Sunday, business time) to the account's Telegram
// chat right away. The automatic Monday send lives in
// `sendDueWeeklySummaries` (server scheduler).
export async function POST() {
  try {
    const { supabase, accountId, account } = await requireRole('admin')
    if (!(await accountModuleEnabled(supabase, accountId, 'weekly_summary'))) {
      return NextResponse.json({ error: 'Module disabled' }, { status: 403 })
    }

    const { data: row, error } = await supabase
      .from('accounts')
      .select('telegram_bot_token, telegram_chat_id')
      .eq('id', accountId)
      .single()
    if (error || !row?.telegram_bot_token || !row?.telegram_chat_id) {
      return NextResponse.json({ error: 'Primero guarda el token y detecta el chat.' }, { status: 400 })
    }

    const text = await buildWeeklySummary(supabase, accountId, account.name)
    try {
      await sendTelegramMessage({ botToken: row.telegram_bot_token, chatId: row.telegram_chat_id, text })
    } catch (err) {
      console.error('[reports/weekly-summary] telegram send failed:', err)
      const message = err instanceof Error ? err.message : 'Telegram error'
      return NextResponse.json({ error: message }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
