import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { appBaseUrl } from '@/lib/google-calendar/oauth'
import { buildInstagramAuthUrl, instagramConfigured, signInstagramState } from '@/lib/instagram/api'

// Canales → Instagram → "Conectar": sends the admin to Instagram's
// consent screen. The signed `state` ties the callback to this account
// and user.
export async function GET(request: Request) {
  const base = appBaseUrl() || new URL(request.url).origin
  const back = (status: string) => NextResponse.redirect(`${base}/channels?instagram=${status}`)
  if (!instagramConfigured()) return back('not_configured')
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    if (!(await accountModuleEnabled(supabase, accountId, 'instagram'))) return back('forbidden')
    return NextResponse.redirect(buildInstagramAuthUrl(signInstagramState(accountId, userId)))
  } catch {
    return back('forbidden')
  }
}
