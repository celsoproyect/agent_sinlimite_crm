import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'
import { appBaseUrl } from '@/lib/google-calendar/oauth'
import { instagramConfigured, instagramRedirectUri } from '@/lib/instagram/api'
import { isMissingTable } from '@/lib/instagram/connection'

// Connection state for Canales → Instagram. Never returns the token.
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'instagram'))) {
      return NextResponse.json({ error: 'Module disabled' }, { status: 403 })
    }
    const { data, error } = await supabaseAdmin()
      .from('instagram_connections')
      .select('username, name, profile_picture_url, ai_enabled, token_expires_at, created_at')
      .eq('account_id', accountId)
      .maybeSingle()
    const migrationPending = isMissingTable(error)
    if (error && !migrationPending) console.error('[instagram] status lookup failed:', error)
    return NextResponse.json({
      configured: instagramConfigured(),
      migrationPending,
      connected: !!data,
      username: data?.username ?? null,
      name: data?.name ?? null,
      profilePictureUrl: data?.profile_picture_url ?? null,
      aiEnabled: data?.ai_enabled ?? true,
      tokenExpiresAt: data?.token_expires_at ?? null,
      connectedAt: data?.created_at ?? null,
      redirectUri: instagramRedirectUri(),
      webhookUrl: `${appBaseUrl()}/api/instagram/webhook`,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
