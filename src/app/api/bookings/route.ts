import { NextResponse, after } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { syncBookingToGoogle } from '@/lib/google-calendar/sync'
import { checkBookingSchedule } from '@/lib/ai/booking'

const PROFESSIONAL_OVERLAP = '23P01'

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
    // Migration 068: appointment | table | event. The agenda asks for
    // appointments only; restaurant and events have their own pages.
    const kind = searchParams.get('kind')

    const build = (byKind: boolean) => {
      let query = supabase
        .from('bookings')
        .select('*, contact:contacts(*)')
        .order('starts_at', { ascending: true })

      if (from) query = query.gte('starts_at', from)
      if (to) query = query.lte('starts_at', to)
      if (contactId) query = query.eq('contact_id', contactId)
      if (byKind && kind) query = query.eq('kind', kind)
      return query
    }

    let { data, error } = await build(true)
    // Before migration 068 every booking is an appointment.
    if (error?.code === '42703' && kind) {
      if (kind !== 'appointment') return NextResponse.json({ bookings: [] })
      ;({ data, error } = await build(false))
    }
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
  // Clinic module: the doctor the appointment is with. Only sent when the
  // account uses doctors, so accounts without migration 066 never touch it.
  const professionalId =
    typeof body.professional_id === 'string' && body.professional_id ? body.professional_id : null
  // Clinic module, migration 067: only sent when set, for the same reason.
  const clinicServiceId =
    typeof body.clinic_service_id === 'string' && body.clinic_service_id ? body.clinic_service_id : null
  const insurance = typeof body.insurance === 'string' && body.insurance.trim() ? body.insurance.trim().slice(0, 200) : null

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

  // On a holiday, a closed day or outside the hours (the doctor's in
  // clinic mode): ask first, and save anyway when the agent confirms
  // (`force`).
  if (body.force !== true) {
    const problem = await checkBookingSchedule(ctx.supabase, ctx.accountId, professionalId, startsAt, endsAt)
    if (problem) return NextResponse.json({ error: 'outside_doctor_hours', reason: problem }, { status: 409 })
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
      ...(professionalId ? { professional_id: professionalId } : {}),
      ...(clinicServiceId ? { clinic_service_id: clinicServiceId } : {}),
      ...(insurance ? { insurance } : {}),
    })
    .select('*, contact:contacts(*)')
    .single()

  if (error) {
    // bookings_no_professional_overlap (migration 066): that doctor already
    // has a live appointment overlapping this time.
    if (error.code === PROFESSIONAL_OVERLAP) {
      return NextResponse.json({ error: 'professional_busy' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  after(() => syncBookingToGoogle(data.id))
  return NextResponse.json({ booking: data }, { status: 201 })
}
