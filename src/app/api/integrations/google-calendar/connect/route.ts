import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { appBaseUrl, buildGoogleAuthUrl, googleCalendarConfigured, signState } from '@/lib/google-calendar/oauth'

// Agenda → Google Calendar → "Conectar": sends the admin to Google's
// consent screen. The signed `state` ties the callback to this account
// and user.
export async function GET(request: Request) {
  const base = appBaseUrl() || new URL(request.url).origin
  if (!googleCalendarConfigured()) {
    return NextResponse.redirect(`${base}/agenda?google=not_configured`)
  }
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    if (!(await accountModuleEnabled(supabase, accountId, 'google_calendar'))) {
      return NextResponse.redirect(`${base}/agenda?google=forbidden`)
    }
    return NextResponse.redirect(buildGoogleAuthUrl(signState(accountId, userId)))
  } catch {
    return NextResponse.redirect(`${base}/agenda?google=forbidden`)
  }
}
