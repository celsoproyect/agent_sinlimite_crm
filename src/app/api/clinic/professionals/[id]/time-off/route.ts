import { NextResponse } from 'next/server'
import { clinicAdmin, clinicDbError } from '@/lib/clinic/api'
import { parseTimeOffInput } from '@/lib/clinic/input'

// Clinic module: add days off to a doctor (admins only, migration 067).
// The doctor offers no slots on those days.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseTimeOffInput(await request.json().catch(() => null))
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data: professional, error: lookupError } = await ctx.supabase
    .from('professionals')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (lookupError) return clinicDbError(lookupError)
  if (!professional) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const { data, error } = await ctx.supabase
    .from('professional_time_off')
    .insert({ account_id: ctx.accountId, professional_id: id, ...parsed.input })
    .select('*')
    .single()
  if (error) return clinicDbError(error)
  return NextResponse.json({ time_off: data }, { status: 201 })
}
