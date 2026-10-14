import { NextResponse } from 'next/server'
import { isMissingPropertiesSchema, toProperty } from '@/lib/real-estate/directory'
import { parsePropertyInput, propertiesDbError, propertiesGuard } from '@/lib/real-estate/api'

// Real estate module: the listings and the advisors who show them.
// GET for any member, POST for admins.

const VISITS_PAST_DAYS = 60

export async function GET() {
  const guard = await propertiesGuard('viewer')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const [props, advisors] = await Promise.all([
    ctx.supabase
      .from('properties')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(2000),
    ctx.supabase.from('professionals').select('id, name, bio, active, slot_minutes, sort_order, is_sample').eq('account_id', ctx.accountId).eq('kind', 'advisor').order('sort_order'),
  ])
  if (props.error) {
    if (isMissingPropertiesSchema(props.error.code)) {
      return NextResponse.json({ migrated: false, properties: [], advisors: advisors.data ?? [] })
    }
    return propertiesDbError(props.error)
  }
  // Visits from VISITS_PAST_DAYS days back (so the calendar can look at
  // recent weeks) onwards, oldest first, with their contact for the edit
  // form. Best-effort.
  const { data: visits } = await ctx.supabase
    .from('bookings')
    .select('*, contact:contacts(*)')
    .eq('account_id', ctx.accountId)
    .not('property_id', 'is', null)
    .gte('starts_at', new Date(Date.now() - VISITS_PAST_DAYS * 24 * 3600_000).toISOString())
    .order('starts_at', { ascending: true })
    .limit(1000)
  return NextResponse.json({
    migrated: true,
    properties: (props.data ?? []).map((r) => toProperty(r as Record<string, unknown>)),
    advisors: advisors.data ?? [],
    visits: visits ?? [],
  })
}

export async function POST(request: Request) {
  const guard = await propertiesGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parsePropertyInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('properties')
    .insert({ account_id: ctx.accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return propertiesDbError(error)
  return NextResponse.json({ property: toProperty(data as Record<string, unknown>) }, { status: 201 })
}
