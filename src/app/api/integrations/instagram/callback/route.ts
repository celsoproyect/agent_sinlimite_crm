import { NextResponse } from 'next/server'
import { getCurrentAccount } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import { appBaseUrl } from '@/lib/google-calendar/oauth'
import {
  exchangeInstagramCode,
  fetchInstagramMe,
  subscribeInstagramWebhooks,
  verifyInstagramState,
  type InstagramProfile,
} from '@/lib/instagram/api'
import { isMissingTable } from '@/lib/instagram/connection'

// Instagram redirects here after consent: code → long-lived token, the
// professional account's profile, webhook subscription, then the
// encrypted token is saved. Back to /channels?instagram=<status>.
export async function GET(request: Request) {
  const url = new URL(request.url)
  const base = appBaseUrl() || url.origin
  const back = (status: string) => NextResponse.redirect(`${base}/channels?instagram=${status}`)

  if (url.searchParams.get('error')) return back('denied')
  const state = verifyInstagramState(url.searchParams.get('state'))
  const code = url.searchParams.get('code')
  if (!state || !code) return back('error')

  // The browser that comes back must be the same user that started.
  try {
    const ctx = await getCurrentAccount()
    if (ctx.accountId !== state.accountId || ctx.userId !== state.userId) return back('error')
  } catch {
    return back('error')
  }

  let token: { accessToken: string; expiresIn: number | null }
  let profile: InstagramProfile
  try {
    token = await exchangeInstagramCode(code)
    profile = await fetchInstagramMe(token.accessToken)
  } catch (err) {
    console.error('[instagram] connecting failed:', err)
    return back('error')
  }

  const db = supabaseAdmin()
  // One Instagram account belongs to one CRM account: webhooks are
  // routed by its id.
  const { data: owner, error: ownerErr } = await db
    .from('instagram_connections')
    .select('account_id')
    .eq('ig_user_id', profile.igUserId)
    .maybeSingle()
  if (ownerErr && isMissingTable(ownerErr)) return back('migration')
  if (owner && owner.account_id !== state.accountId) return back('in_use')

  try {
    await subscribeInstagramWebhooks(token.accessToken)
  } catch (err) {
    // Not fatal: sending still works and the owner can reconnect. Logged
    // so a missing webhook is explainable.
    console.error('[instagram] webhook subscription failed:', err)
  }

  const now = new Date()
  const { data, error } = await db
    .from('instagram_connections')
    .upsert(
      {
        account_id: state.accountId,
        ig_user_id: profile.igUserId,
        username: profile.username,
        name: profile.name,
        profile_picture_url: profile.profilePictureUrl,
        access_token: encrypt(token.accessToken),
        token_expires_at: token.expiresIn ? new Date(now.getTime() + token.expiresIn * 1000).toISOString() : null,
        token_refreshed_at: now.toISOString(),
        connected_by: state.userId,
        updated_at: now.toISOString(),
      },
      { onConflict: 'account_id' },
    )
    .select('account_id')
  if (error || !data?.length) {
    console.error('[instagram] saving the connection failed:', error)
    return back(isMissingTable(error) ? 'migration' : 'error')
  }
  return back('connected')
}
