import { NextResponse } from 'next/server'
import { clinicAdmin, clinicDbError } from '@/lib/clinic/api'
import { parseServiceInput } from '@/lib/clinic/input'

// Clinic module: create a service with its own length (admins only,
// migration 067).

export async function POST(request: Request) {
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseServiceInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('clinic_services')
    .insert({ account_id: ctx.accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return clinicDbError(error)
  return NextResponse.json({ service: data }, { status: 201 })
}
