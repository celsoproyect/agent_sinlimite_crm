import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'
import { googleCalendarConfigured, googleRedirectUri } from '@/lib/google-calendar/oauth'

// Connection state for the Agenda's Google Calendar card. Never returns
// the token.
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'google_calendar'))) {
      return NextResponse.json({ error: 'Module disabled' }, { status: 403 })
    }
    const configured = googleCalendarConfigured()
    const { data, error } = await supabaseAdmin()
      .from('google_calendar_connections')
      .select('google_email, created_at')
      .eq('account_id', accountId)
      .maybeSingle()
    const migrationPending = error?.code === '42P01' || error?.code === 'PGRST205'
    if (error && !migrationPending) console.error('[gcal] status lookup failed:', error)
    return NextResponse.json({
      configured,
      migrationPending,
      connected: !!data,
      email: data?.google_email ?? null,
      connectedAt: data?.created_at ?? null,
      redirectUri: googleRedirectUri(),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
