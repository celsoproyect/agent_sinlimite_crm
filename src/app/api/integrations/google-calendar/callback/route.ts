import { after } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  appBaseUrl,
  exchangeGoogleCode,
  fetchGoogleEmail,
  revokeGoogleToken,
  verifyState,
} from '@/lib/google-calendar/oauth'
import { oauthResult } from '@/lib/google-calendar/popup'
import type { GoogleOAuthResult } from '@/lib/google-calendar/oauth-result'
import { forgetGoogleConnection, syncUpcomingBookings } from '@/lib/google-calendar/sync'

// Google redirects here after consent. Stores the encrypted refresh
// token, then pushes the upcoming bookings into the calendar in the
// background and returns to the agenda with ?google=connected|error, or,
// for a popup flow, answers with a page that notifies the CRM and closes.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const base = appBaseUrl() || url.origin
  const state = verifyState(url.searchParams.get('state'))
  const back = (status: GoogleOAuthResult) => oauthResult(base, status, !!state?.popup)

  if (url.searchParams.get('error')) return back('denied')
  const code = url.searchParams.get('code')
  if (!state || !code) return back('error')

  // The browser that comes back must be the same user that started.
  try {
    const ctx = await getCurrentAccount()
    if (ctx.accountId !== state.accountId || ctx.userId !== state.userId) return back('error')
  } catch {
    return back('error')
  }

  let tokens
  try {
    tokens = await exchangeGoogleCode(code)
  } catch (err) {
    console.error('[gcal] code exchange failed:', err)
    return back('error')
  }
  if (!tokens.refresh_token) {
    console.error('[gcal] Google returned no refresh token')
    return back('error')
  }

  const email = await fetchGoogleEmail(tokens.access_token)
  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin()
    .from('google_calendar_connections')
    .upsert(
      {
        account_id: state.accountId,
        google_email: email,
        refresh_token: encrypt(tokens.refresh_token),
        calendar_id: 'primary',
        connected_by: state.userId,
        updated_at: now,
      },
      { onConflict: 'account_id' },
    )
    .select('account_id')
  if (error || !data?.length) {
    console.error('[gcal] saving the connection failed:', error)
    await revokeGoogleToken(tokens.refresh_token)
    return back(error?.code === '42P01' || error?.code === 'PGRST205' ? 'migration' : 'error')
  }

  forgetGoogleConnection(state.accountId)
  after(() => syncUpcomingBookings(state.accountId))
  return back('connected')
}
