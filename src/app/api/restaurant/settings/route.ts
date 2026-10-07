import { NextResponse } from 'next/server'
import { restaurantDbError, restaurantGuard } from '@/lib/restaurant/api'
import { normalizeRestaurantSettings } from '@/lib/restaurant/settings'

// Restaurant module: save `accounts.restaurant_settings` (admins only).
// Whatever is sent is clamped by normalizeRestaurantSettings.

export async function PUT(request: Request) {
  const guard = await restaurantGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  const settings = normalizeRestaurantSettings(body)

  const { data, error } = await ctx.supabase
    .from('accounts')
    .update({ restaurant_settings: settings })
    .eq('id', ctx.accountId)
    .select('restaurant_settings')
  if (error) return restaurantDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_saved' }, { status: 403 })
  return NextResponse.json({ settings: normalizeRestaurantSettings(data[0].restaurant_settings) })
}
