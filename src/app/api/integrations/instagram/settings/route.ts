import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// The owner's switches for the connected Instagram account.
export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { ai_enabled?: unknown }
    if (typeof body.ai_enabled !== 'boolean') {
      return NextResponse.json({ error: 'ai_enabled must be a boolean' }, { status: 400 })
    }
    const { data, error } = await supabaseAdmin()
      .from('instagram_connections')
      .update({ ai_enabled: body.ai_enabled, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .select('ai_enabled')
    if (error) {
      console.error('[instagram] settings update failed:', error)
      return NextResponse.json({ error: 'No se pudo guardar.' }, { status: 500 })
    }
    if (!data?.length) return NextResponse.json({ error: 'not_connected' }, { status: 404 })
    return NextResponse.json({ ok: true, aiEnabled: data[0].ai_enabled })
  } catch (err) {
    return toErrorResponse(err)
  }
}
