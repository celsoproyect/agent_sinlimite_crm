import { NextResponse } from 'next/server'
import { parseTableInput, restaurantDbError, restaurantGuard } from '@/lib/restaurant/api'

// Restaurant module: create a table (admins only).

export async function POST(request: Request) {
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseTableInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('restaurant_tables')
    .insert({ account_id: ctx.accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return restaurantDbError(error)
  return NextResponse.json({ table: data }, { status: 201 })
}
