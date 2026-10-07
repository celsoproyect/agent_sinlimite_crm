import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { intIn, restaurantDbError, restaurantGuard, str } from '@/lib/restaurant/api'

// Restaurant module, waitlist feature (migration 068).
// GET ?date=YYYY-MM-DD → that day's entries (default: today onwards).
// POST → add someone by hand (contact optional; name or phone required).

const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(request: Request) {
  let ctx
  try {
    ctx = await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }
  for (const m of ['restaurant', 'waitlist'] as const) {
    if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, m))) {
      return NextResponse.json({ error: 'module_disabled' }, { status: 403 })
    }
  }
  const date = new URL(request.url).searchParams.get('date')
  let query = ctx.supabase
    .from('restaurant_waitlist')
    .select('*')
    .eq('account_id', ctx.accountId)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true })
  if (date && DATE.test(date)) query = query.eq('date', date)
  const { data, error } = await query
  if (error) return restaurantDbError(error)
  return NextResponse.json({ entries: data ?? [] })
}

export async function POST(request: Request) {
  const guard = await restaurantGuard('agent', { waitlist: true })
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  const date = typeof body.date === 'string' && DATE.test(body.date) ? body.date : null
  const partySize = intIn(body.party_size, 1, 500)
  let name = str(body.customer_name, 100)
  let phone = str(body.customer_phone, 40)
  const contactId = str(body.contact_id, 64)
  if (contactId && (!name || !phone)) {
    const { data: contact } = await ctx.supabase.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()
    name = name ?? (contact?.name as string | null) ?? null
    phone = phone ?? (contact?.phone as string | null) ?? null
  }
  if (!date || !partySize || (!name && !phone)) return NextResponse.json({ error: 'required_fields' }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('restaurant_waitlist')
    .insert({
      account_id: ctx.accountId,
      contact_id: contactId,
      date,
      party_size: partySize,
      preferred_time: str(body.preferred_time, 20),
      customer_name: name,
      customer_phone: phone,
      notes: str(body.notes, 500),
    })
    .select('*')
    .single()
  if (error) return restaurantDbError(error)
  return NextResponse.json({ entry: data }, { status: 201 })
}
