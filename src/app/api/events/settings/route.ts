import { NextResponse } from 'next/server'
import { eventsDbError, eventsGuard } from '@/lib/events/api'
import { normalizeEventSettings } from '@/lib/events/settings'

// Events module: each business decides whether requests need approval,
// whether a deposit is required and its percentage (admins only).

export async function PUT(request: Request) {
  const guard = await eventsGuard('admin')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  const settings = normalizeEventSettings(body)

  const { data, error } = await supabase
    .from('accounts')
    .update({ event_settings: settings })
    .eq('id', accountId)
    .select('event_settings')
  if (error) return eventsDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_saved' }, { status: 403 })
  return NextResponse.json({ settings })
}
