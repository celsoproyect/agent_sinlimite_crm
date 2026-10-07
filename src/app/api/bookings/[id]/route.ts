import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { deleteGoogleEvent, syncBookingToGoogle } from '@/lib/google-calendar/sync'
import { checkBookingSchedule } from '@/lib/ai/booking'

const PROFESSIONAL_OVERLAP = '23P01'

// Update / cancel a single booking. RLS (bookings_update/delete) already
// scopes to the caller's account — the explicit `account_id` filter below
// is defense in depth, matching quick-replies' [id] route.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.service === 'string') update.service = body.service
  if (typeof body.notes === 'string' || body.notes === null) update.notes = body.notes
  if (typeof body.starts_at === 'string') update.starts_at = body.starts_at
  if (typeof body.ends_at === 'string') update.ends_at = body.ends_at
  if (typeof body.professional_id === 'string' || body.professional_id === null) {
    update.professional_id = body.professional_id || null
  }
  // Clinic module, migration 067: only sent by the clinic booking form.
  if (typeof body.clinic_service_id === 'string' || body.clinic_service_id === null) {
    update.clinic_service_id = body.clinic_service_id || null
  }
  if (typeof body.insurance === 'string' || body.insurance === null) {
    update.insurance = typeof body.insurance === 'string' && body.insurance.trim() ? body.insurance.trim().slice(0, 200) : null
  }
  if (
    body.status === 'confirmed' ||
    body.status === 'cancelled' ||
    body.status === 'completed' ||
    // Migration 068: the customer never came.
    body.status === 'no_show'
  ) {
    update.status = body.status
  }

  if (
    typeof update.starts_at === 'string' &&
    typeof update.ends_at === 'string' &&
    new Date(update.ends_at) <= new Date(update.starts_at)
  ) {
    return NextResponse.json(
      { error: 'ends_at must be after starts_at' },
      { status: 400 },
    )
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  // Moving it, or giving it a doctor: check holidays and the hours (the
  // doctor's, or the business's) unless the agent already confirmed
  // (`force`).
  const movesSchedule = 'starts_at' in update || 'ends_at' in update || !!update.professional_id
  if (movesSchedule && body.force !== true && update.status !== 'cancelled') {
    const { data: current } = await ctx.supabase
      .from('bookings')
      .select('*')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const row = current as { starts_at: string; ends_at: string; professional_id?: string | null; status?: string; kind?: string } | null
    const professionalId = 'professional_id' in update ? (update.professional_id as string | null) : row?.professional_id
    // Tables and events follow their own hours (their pages check them).
    const appointment = !row?.kind || row.kind === 'appointment'
    if (row && appointment && row.status !== 'cancelled') {
      const problem = await checkBookingSchedule(
        ctx.supabase,
        ctx.accountId,
        professionalId ?? null,
        (update.starts_at as string | undefined) ?? row.starts_at,
        (update.ends_at as string | undefined) ?? row.ends_at,
      )
      if (problem) return NextResponse.json({ error: 'outside_doctor_hours', reason: problem }, { status: 409 })
    }
  }

  const { data, error } = await ctx.supabase
    .from('bookings')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*, contact:contacts(*)')
    .single()

  if (error) {
    // bookings_no_professional_overlap (migration 066): that doctor already
    // has a live appointment overlapping this time.
    if (error.code === PROFESSIONAL_OVERLAP) {
      return NextResponse.json({ error: 'professional_busy' }, { status: 409 })
    }
    // Before migration 068 the status check rejects 'no_show'.
    if (error.code === '23514' && update.status === 'no_show') {
      return NextResponse.json({ error: 'needs_migration', code: 'needs_migration' }, { status: 503 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  after(() => syncBookingToGoogle(id))
  return NextResponse.json({ booking: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  // Return the deleted row: its Google event id goes away with it.
  const { data: rows, error } = await ctx.supabase
    .from('bookings')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const eventId = (rows?.[0] as { google_event_id?: string | null } | undefined)?.google_event_id
  if (eventId) after(() => deleteGoogleEvent(ctx.accountId, eventId))
  return NextResponse.json({ ok: true })
}
