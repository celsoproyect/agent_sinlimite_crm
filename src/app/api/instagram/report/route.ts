import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'
import { instagramGuard } from '@/lib/instagram/page-api'
import { loadPostReport } from '@/lib/instagram/report'
import { parseReportRange } from '@/lib/reports/range'

// GET /api/instagram/report?from=&to= (module instagram_reports): the
// funnel per post. Any member reads, like the Reports page.

export async function GET(request: Request) {
  const guard = await instagramGuard('viewer')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'instagram_reports'))) {
    return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
  }
  const { searchParams } = new URL(request.url)
  const range = parseReportRange(searchParams.get('from'), searchParams.get('to'))
  try {
    return NextResponse.json(await loadPostReport(supabaseAdmin(), ctx.accountId, range))
  } catch (err) {
    console.error('[instagram] report failed:', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'report_failed' }, { status: 500 })
  }
}
