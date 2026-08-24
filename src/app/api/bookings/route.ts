import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

// Agenda module CRUD. RLS (migration 046: bookings_select/insert/update/
// delete, all `is_account_member`) already scopes every query to the
// caller's account, so this route uses the RLS-scoped client from
// `requireRole` rather than the service-role client — same pattern as
// `pipelines`/`deals`, unlike the settings-tier routes that need to bypass
// RLS (quick_replies, automations).

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount()
    const { searchParams } = new URL(request.url)
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const contactId = searchParams.get('contact_id')

    let query = supabase
      .from('bookings')
      .select('*, contact:contacts(*)')
      .order('starts_at', { ascending: true })

    if (from) query = query.gte('starts_at', from)
    if (to) query = query.lte('starts_at', to)
    if (contactId) query = query.eq('contact_id', contactId)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ bookings: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const contactId = typeof body.contact_id === 'string' ? body.contact_id : ''
  const startsAt = typeof body.starts_at === 'string' ? body.starts_at : ''
  const endsAt = typeof body.ends_at === 'string' ? body.ends_at : ''
  const service = typeof body.service === 'string' ? body.service : ''
  const notes = typeof body.notes === 'string' ? body.notes : null
  const conversationId =
    typeof body.conversation_id === 'string' ? body.conversation_id : null

  if (!contactId || !startsAt || !endsAt) {
    return NextResponse.json(
      { error: 'contact_id, starts_at, and ends_at are required' },
      { status: 400 },
    )
  }
  if (new Date(endsAt) <= new Date(startsAt)) {
    return NextResponse.json(
      { error: 'ends_at must be after starts_at' },
      { status: 400 },
    )
  }

  const { data, error } = await ctx.supabase
    .from('bookings')
    .insert({
      account_id: ctx.accountId,
      contact_id: contactId,
      conversation_id: conversationId,
      service,
      starts_at: startsAt,
      ends_at: endsAt,
      notes,
      created_by: ctx.userId,
    })
    .select('*, contact:contacts(*)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ booking: data }, { status: 201 })
}
