import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

// Booking reminder rule CRUD. RLS (migration 052: select → any member,
// insert/update/delete → admin) already scopes every query to the
// caller's account, so this route uses the RLS-scoped client — same
// pattern as `src/app/api/bookings/route.ts`.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('booking_reminder_rules')
      .select('*')
      .order('offset_minutes', { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ rules: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const offsetMinutes = Number(body.offset_minutes)
  const messageText = typeof body.message_text === 'string' ? body.message_text : ''
  const templateName =
    typeof body.template_name === 'string' && body.template_name ? body.template_name : null
  const templateLanguage =
    typeof body.template_language === 'string' && body.template_language
      ? body.template_language
      : null
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true

  if (!Number.isFinite(offsetMinutes) || offsetMinutes <= 0) {
    return NextResponse.json({ error: 'offset_minutes must be a positive number' }, { status: 400 })
  }
  if (!messageText.trim()) {
    return NextResponse.json({ error: 'message_text is required' }, { status: 400 })
  }

  const { data, error } = await ctx.supabase
    .from('booking_reminder_rules')
    .insert({
      account_id: ctx.accountId,
      offset_minutes: offsetMinutes,
      message_text: messageText,
      template_name: templateName,
      template_language: templateLanguage,
      enabled,
    })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rule: data }, { status: 201 })
}
