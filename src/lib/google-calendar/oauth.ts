// ============================================================
// Google OAuth for the agenda's Google Calendar sync.
//
// The owner connects once from Agenda → Google Calendar; we keep only
// the refresh token (encrypted) and mint short-lived access tokens from
// it. Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from a Google Cloud
// "Web application" OAuth client whose redirect URI is
// `${NEXT_PUBLIC_APP_URL || NEXT_PUBLIC_SITE_URL}/api/integrations/google-calendar/callback`.
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  // Create, move and delete the CRM's events, and read the others to
  // block busy times.
  'https://www.googleapis.com/auth/calendar.events',
]

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
const STATE_MAX_AGE_MS = 15 * 60 * 1000

export function googleCalendarConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET
}

/** Public base URL. The Docker image only bakes NEXT_PUBLIC_SITE_URL. */
export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || ''
  return raw.replace(/\/+$/, '')
}

export function googleRedirectUri(): string {
  return `${appBaseUrl()}/api/integrations/google-calendar/callback`
}

function sign(payload: string): string {
  return createHmac('sha256', process.env.GOOGLE_CLIENT_SECRET ?? '').update(payload).digest('base64url')
}

/**
 * Signed `state` tying the callback to the account and user that started it.
 * `popup` marks a flow started in a popup window, so the callback answers
 * with a page that notifies the opener and closes itself.
 */
export function signState(accountId: string, userId: string, now: number = Date.now(), popup = false): string {
  const payload = Buffer.from(JSON.stringify({ a: accountId, u: userId, t: now, ...(popup ? { p: 1 } : {}) })).toString(
    'base64url',
  )
  return `${payload}.${sign(payload)}`
}

export function verifyState(
  state: string | null,
  now: number = Date.now(),
): { accountId: string; userId: string; popup?: true } | null {
  if (!state) return null
  const [payload, mac] = state.split('.')
  if (!payload || !mac) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const { a, u, t, p } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof a !== 'string' || typeof u !== 'string' || typeof t !== 'number') return null
    if (now - t > STATE_MAX_AGE_MS || t > now + 60_000) return null
    return p === 1 ? { accountId: a, userId: u, popup: true } : { accountId: a, userId: u }
  } catch {
    return null
  }
}

export function buildGoogleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: googleRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Always show consent so Google returns a refresh token even when the
    // user connected before.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      ...body,
    }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(`Google token error: ${json.error ?? res.status}`) as Error & { code?: string }
    err.code = json.error
    throw err
  }
  return json as TokenResponse
}

export function exchangeGoogleCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: googleRedirectUri() })
}

export function refreshGoogleToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' })
}

export async function fetchGoogleEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return null
    const json = (await res.json()) as { email?: string }
    return json.email ?? null
  } catch {
    return null
  }
}

/** Best-effort revoke on disconnect, so the grant disappears from the
 *  owner's Google account too. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' })
  } catch {
    // ignore
  }
}
