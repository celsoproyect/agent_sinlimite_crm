import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { loadAiMessages, parseAiMessageKind } from '@/lib/reports/ai-messages'
import { parseReportChannel } from '@/lib/reports/overview'
import { parseReportRange } from '@/lib/reports/range'

// Paginated list of the messages the AI sent, for Reportes → Mensajes
// atendidos por la IA. Same range and channel params as the overview,
// plus `kind` (all | text | media | interactive), `q` and `page`.
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const [reports, aiMessages] = await Promise.all([
      accountModuleEnabled(supabase, accountId, 'reports'),
      accountModuleEnabled(supabase, accountId, 'ai_messages'),
    ])
    if (!reports || !aiMessages) {
      return NextResponse.json({ error: 'Module disabled' }, { status: 403 })
    }
    const { searchParams } = new URL(request.url)
    const result = await loadAiMessages(supabase, accountId, {
      range: parseReportRange(searchParams.get('from'), searchParams.get('to')),
      channel: parseReportChannel(searchParams.get('channel')),
      kind: parseAiMessageKind(searchParams.get('kind')),
      q: searchParams.get('q') ?? '',
      page: Number(searchParams.get('page') ?? 1),
      pageSize: Number(searchParams.get('pageSize') ?? 25),
    })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}
