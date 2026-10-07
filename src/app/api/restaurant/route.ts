import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { isMissingRestaurantSchema } from '@/lib/restaurant/engine'
import { normalizeRestaurantSettings } from '@/lib/restaurant/settings'
import type { BookingSettings } from '@/types'

// Restaurant module (migration 068): the floor plan and settings for the
// /restaurant page — every area and table, inactive and examples included,
// plus the agenda's hours and holidays (the fallback when the restaurant
// has no hours of its own).

export async function GET() {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'restaurant'))) {
    return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
  }
  const [areasRes, tablesRes, settingsRes] = await Promise.all([
    ctx.supabase.from('restaurant_areas').select('*').eq('account_id', ctx.accountId).order('sort_order').order('name'),
    ctx.supabase.from('restaurant_tables').select('*').eq('account_id', ctx.accountId).order('sort_order').order('name'),
    ctx.supabase.from('accounts').select('restaurant_settings').eq('id', ctx.accountId).maybeSingle(),
  ])
  const { data: account } = await ctx.supabase.from('accounts').select('booking_settings').eq('id', ctx.accountId).maybeSingle()
  const business = (account?.booking_settings ?? null) as BookingSettings | null
  const missing = [areasRes.error, tablesRes.error, settingsRes.error].find((e) => e && isMissingRestaurantSchema(e.code))
  if (missing) {
    return NextResponse.json({ migrated: false, settings: normalizeRestaurantSettings(null), areas: [], tables: [], business })
  }
  const failed = areasRes.error ?? tablesRes.error ?? settingsRes.error
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 })
  return NextResponse.json({
    migrated: true,
    settings: normalizeRestaurantSettings(settingsRes.data?.restaurant_settings),
    areas: areasRes.data ?? [],
    tables: tablesRes.data ?? [],
    business,
  })
}
