import { NextResponse } from 'next/server'
import { eventsDbError, eventsGuard } from '@/lib/events/api'
import { parseHallInput } from '@/lib/events/input'

// Events module: create a hall (admins only).

export async function POST(request: Request) {
  const guard = await eventsGuard('admin')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx

  const parsed = parseHallInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await supabase
    .from('event_halls')
    .insert({ account_id: accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return eventsDbError(error)
  return NextResponse.json({ hall: data }, { status: 201 })
}
