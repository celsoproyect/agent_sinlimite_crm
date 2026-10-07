import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { revokeGoogleToken } from '@/lib/google-calendar/oauth'
import { forgetGoogleConnection } from '@/lib/google-calendar/sync'

// Disconnect Google Calendar: revoke the grant and forget the token.
// Events already created stay in the owner's calendar.
export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    const db = supabaseAdmin()
    const { data: rows, error } = await db
      .from('google_calendar_connections')
      .delete()
      .eq('account_id', accountId)
      .select('refresh_token')
    if (error) {
      console.error('[gcal] disconnect failed:', error)
      return NextResponse.json({ error: 'No se pudo desconectar.' }, { status: 500 })
    }
    forgetGoogleConnection(accountId)
    const token = rows?.[0]?.refresh_token
    if (token) {
      try {
        await revokeGoogleToken(decrypt(token))
      } catch (err) {
        console.error('[gcal] revoke failed:', err)
      }
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
