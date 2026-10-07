import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseRuleKind, parseAppliesTo } from './fields'

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
      .order('created_at', { ascending: true })

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
  // Migration 068: a reminder (before) or a follow-up (after), and which
  // bookings it applies to. Defaults keep the old behaviour.
  const kind = parseRuleKind(body.kind) ?? 'before'
  const appliesTo = parseAppliesTo(body.applies_to) ?? 'all'

  if (!Number.isFinite(offsetMinutes) || offsetMinutes <= 0) {
    return NextResponse.json({ error: 'offset_minutes must be a positive number' }, { status: 400 })
  }
  if (!messageText.trim()) {
    return NextResponse.json({ error: 'message_text is required' }, { status: 400 })
  }

  const base = {
    account_id: ctx.accountId,
    offset_minutes: offsetMinutes,
    message_text: messageText,
    template_name: templateName,
    template_language: templateLanguage,
    enabled,
  }
  const extended = kind === 'before' && appliesTo === 'all' ? base : { ...base, kind, applies_to: appliesTo }
  let { data, error } = await ctx.supabase.from('booking_reminder_rules').insert(extended).select('*').single()
  if (error?.code === '42703') {
    // Before migration 068 only plain "before, all bookings" rules exist.
    if (extended !== base) {
      return NextResponse.json({ error: 'Run migration 068 first.', code: 'needs_migration' }, { status: 503 })
    }
    ;({ data, error } = await ctx.supabase.from('booking_reminder_rules').insert(base).select('*').single())
  }

  if (error?.code === '23505') {
    return NextResponse.json({ error: 'A rule with that timing already exists.', code: 'duplicate_rule' }, { status: 409 })
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rule: data }, { status: 201 })
}
