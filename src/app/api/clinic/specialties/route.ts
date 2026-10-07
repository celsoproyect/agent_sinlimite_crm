import { NextResponse } from 'next/server'
import { clinicAdmin, clinicDbError } from '@/lib/clinic/api'
import { parseSpecialtyInput } from '@/lib/clinic/input'

// Clinic module: create a specialty (admins only).

export async function POST(request: Request) {
  const guard = await clinicAdmin()
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseSpecialtyInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('specialties')
    .insert({ account_id: ctx.accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return clinicDbError(error)
  return NextResponse.json({ specialty: data }, { status: 201 })
}
