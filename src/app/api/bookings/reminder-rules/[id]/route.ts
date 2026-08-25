import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

// uuid v4 plus the looser shape Postgres gen_random_uuid emits — same
// guard as src/app/api/whatsapp/templates/[id]/route.ts.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid rule id.' }, { status: 400 })
  }

  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const patch: Record<string, unknown> = {}
  if (body.offset_minutes !== undefined) {
    const offsetMinutes = Number(body.offset_minutes)
    if (!Number.isFinite(offsetMinutes) || offsetMinutes <= 0) {
      return NextResponse.json({ error: 'offset_minutes must be a positive number' }, { status: 400 })
    }
    patch.offset_minutes = offsetMinutes
  }
  if (body.message_text !== undefined) {
    if (typeof body.message_text !== 'string' || !body.message_text.trim()) {
      return NextResponse.json({ error: 'message_text is required' }, { status: 400 })
    }
    patch.message_text = body.message_text
  }
  if (body.template_name !== undefined) {
    patch.template_name =
      typeof body.template_name === 'string' && body.template_name ? body.template_name : null
  }
  if (body.template_language !== undefined) {
    patch.template_language =
      typeof body.template_language === 'string' && body.template_language
        ? body.template_language
        : null
  }
  if (body.enabled !== undefined) {
    patch.enabled = !!body.enabled
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const { data, error } = await ctx.supabase
    .from('booking_reminder_rules')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ rule: data })
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid rule id.' }, { status: 400 })
  }

  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await ctx.supabase.from('booking_reminder_rules').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
