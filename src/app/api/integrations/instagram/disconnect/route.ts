import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Forget the Instagram connection. Conversations and contacts stay; new
// DMs stop arriving until the account connects again.
export async function DELETE() {
  try {
    const { accountId } = await requireRole('admin')
    const { error } = await supabaseAdmin().from('instagram_connections').delete().eq('account_id', accountId)
    if (error) {
      console.error('[instagram] disconnect failed:', error)
      return NextResponse.json({ error: 'No se pudo desconectar.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
