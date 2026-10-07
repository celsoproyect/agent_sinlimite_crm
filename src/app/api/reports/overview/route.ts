import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { loadReportOverview, parseReportChannel } from '@/lib/reports/overview'
import { parseReportRange } from '@/lib/reports/range'

// Reports page summary. `from`/`to` are business-local days
// (YYYY-MM-DD, inclusive); `channel` is all | whatsapp | web. Reads go
// through the caller's RLS-scoped client and are also filtered by
// account, like the bookings and deals routes.
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'reports'))) {
      return NextResponse.json({ error: 'Module disabled' }, { status: 403 })
    }
    const { searchParams } = new URL(request.url)
    const range = parseReportRange(searchParams.get('from'), searchParams.get('to'))
    const channel = parseReportChannel(searchParams.get('channel'))
    const overview = await loadReportOverview(supabase, accountId, range, channel)
    return NextResponse.json(overview)
  } catch (err) {
    return toErrorResponse(err)
  }
}
