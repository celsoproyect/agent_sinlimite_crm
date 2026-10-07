import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentAccount, requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { isMissingRestaurantSchema } from '@/lib/restaurant/engine'
import { loadBookingSettings } from '@/lib/ai/booking'
import type { EventHall, EventPackage } from '@/types'
import type { EventDirectory } from './engine'
import { normalizeEventSettings } from './settings'

// Shared plumbing for the events module's routes (/api/events/*).

/** A Supabase error as the route's JSON response. */
export function eventsDbError(error: { code?: string; message: string }) {
  if (isMissingRestaurantSchema(error.code)) {
    return NextResponse.json({ error: 'needs_migration' }, { status: 503 })
  }
  if (error.code === '23P01') return NextResponse.json({ error: 'hall_busy' }, { status: 409 })
  if (error.code === '23514') return NextResponse.json({ error: 'invalid_value' }, { status: 400 })
  return NextResponse.json({ error: error.message }, { status: 500 })
}

/** The caller with the role and the events module on, or the error response. */
export async function eventsGuard(
  role: 'admin' | 'agent' | 'any',
): Promise<{ ctx: AccountContext } | { response: Response }> {
  let ctx: AccountContext
  try {
    ctx = role === 'any' ? await getCurrentAccount() : await requireRole(role)
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'events'))) {
    return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
  }
  return { ctx }
}

/**
 * Every active hall and package (examples included, unlike the AI's
 * directory, so the team can book an example hall by hand), or null when
 * there is no active hall.
 */
export async function loadManualEventDirectory(db: SupabaseClient, accountId: string): Promise<EventDirectory | null | 'needs_migration'> {
  const [hallsRes, packagesRes, settingsRes, business] = await Promise.all([
    db.from('event_halls').select('*').eq('account_id', accountId).eq('active', true).order('sort_order').order('name'),
    db.from('event_packages').select('*').eq('account_id', accountId).eq('active', true).order('sort_order').order('name'),
    db.from('accounts').select('event_settings').eq('id', accountId).maybeSingle(),
    loadBookingSettings(db, accountId),
  ])
  if (hallsRes.error) return isMissingRestaurantSchema(hallsRes.error.code) ? 'needs_migration' : null
  const halls = (hallsRes.data ?? []) as EventHall[]
  if (halls.length === 0) return null
  return {
    settings: normalizeEventSettings(settingsRes.data?.event_settings),
    halls,
    packages: (packagesRes.data ?? []) as EventPackage[],
    business,
  }
}
