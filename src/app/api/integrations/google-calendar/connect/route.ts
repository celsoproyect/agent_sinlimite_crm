import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { appBaseUrl, buildGoogleAuthUrl, googleCalendarConfigured, signState } from '@/lib/google-calendar/oauth'
import { oauthResult } from '@/lib/google-calendar/popup'

// Agenda → Google Calendar → "Conectar": sends the admin to Google's
// consent screen. The signed `state` ties the callback to this account
// and user. `?popup=1` when it runs in a popup window, so the callback
// closes the popup instead of redirecting.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const base = appBaseUrl() || url.origin
  const popup = url.searchParams.get('popup') === '1'
  if (!googleCalendarConfigured()) return oauthResult(base, 'not_configured', popup)
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    if (!(await accountModuleEnabled(supabase, accountId, 'google_calendar'))) {
      return oauthResult(base, 'forbidden', popup)
    }
    return NextResponse.redirect(buildGoogleAuthUrl(signState(accountId, userId, Date.now(), popup)))
  } catch {
    return oauthResult(base, 'forbidden', popup)
  }
}
