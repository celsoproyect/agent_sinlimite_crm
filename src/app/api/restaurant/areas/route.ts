import { NextResponse } from 'next/server'
import { parseAreaInput, restaurantDbError, restaurantGuard } from '@/lib/restaurant/api'

// Restaurant module: create a area (admins only).

export async function POST(request: Request) {
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseAreaInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('restaurant_areas')
    .insert({ account_id: ctx.accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return restaurantDbError(error)
  return NextResponse.json({ area: data }, { status: 201 })
}
