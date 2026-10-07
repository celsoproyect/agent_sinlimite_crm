import { NextResponse } from 'next/server'
import { isMissingRestaurantSchema } from '@/lib/restaurant/engine'
import { eventsGuard } from '@/lib/events/api'
import { normalizeEventSettings } from '@/lib/events/settings'

// Events module: settings, every hall and every package (inactive and
// examples included) for the /events page.

export async function GET() {
  const guard = await eventsGuard('any')
  if ('response' in guard) return guard.response
  const { supabase, accountId } = guard.ctx

  const [hallsRes, packagesRes, settingsRes] = await Promise.all([
    supabase.from('event_halls').select('*').eq('account_id', accountId).order('sort_order').order('name'),
    supabase.from('event_packages').select('*').eq('account_id', accountId).order('sort_order').order('name'),
    supabase.from('accounts').select('event_settings').eq('id', accountId).maybeSingle(),
  ])
  const migrated = !(hallsRes.error && isMissingRestaurantSchema(hallsRes.error.code))
  if (hallsRes.error && migrated) return NextResponse.json({ error: hallsRes.error.message }, { status: 500 })
  return NextResponse.json({
    migrated,
    settings: normalizeEventSettings(settingsRes.error ? null : settingsRes.data?.event_settings),
    halls: hallsRes.data ?? [],
    packages: packagesRes.error ? [] : packagesRes.data ?? [],
  })
}
