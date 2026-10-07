import { NextResponse } from 'next/server'
import { eventsDbError, eventsGuard } from '@/lib/events/api'
import { parsePackageInput } from '@/lib/events/input'

// Events module: edit or delete a package (admins only). Deleting a package
// keeps its past events (event_package_id is set to null).

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await eventsGuard('admin')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx

  const parsed = parsePackageInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  if (Object.keys(parsed.input).length === 0) return NextResponse.json({ error: 'nothing_to_update' }, { status: 400 })

  const { data, error } = await supabase
    .from('event_packages')
    .update(parsed.input)
    .eq('id', id)
    .eq('account_id', accountId)
    .select('*')
  if (error) return eventsDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ package: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await eventsGuard('admin')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx

  const { data, error } = await supabase.from('event_packages').delete().eq('id', id).eq('account_id', accountId).select('id')
  if (error) return eventsDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
