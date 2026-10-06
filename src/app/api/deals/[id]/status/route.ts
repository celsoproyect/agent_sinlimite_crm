import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { closeDeal, DealCloseError, isLostReason, reopenDeal } from '@/lib/deals/close'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Close a deal as won/lost, or reopen it. Body:
 * `{ status: 'won' | 'lost' | 'open', lost_reason?, note?, stage_id? }`.
 *
 * The caller must be an agent of the deal's account (checked through the
 * RLS client); the write itself goes through `closeDeal` with the
 * service-role client, because winning also creates/assigns the
 * "Cliente" tag and fires automations.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid deal id.' }, { status: 400 })
  }

  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  const status = body?.status
  if (status !== 'won' && status !== 'lost' && status !== 'open') {
    return NextResponse.json({ error: 'status must be won, lost or open' }, { status: 400 })
  }
  if (status === 'lost' && !isLostReason(body.lost_reason)) {
    return NextResponse.json({ error: 'A valid lost_reason is required' }, { status: 400 })
  }

  const { data: visible, error: visErr } = await ctx.supabase
    .from('deals')
    .select('id')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (visErr) return NextResponse.json({ error: visErr.message }, { status: 500 })
  if (!visible) return NextResponse.json({ error: 'Deal not found' }, { status: 404 })

  try {
    const db = supabaseAdmin()
    const result =
      status === 'open'
        ? await reopenDeal(db, { accountId: ctx.accountId, dealId: id })
        : await closeDeal(db, {
            accountId: ctx.accountId,
            dealId: id,
            status,
            lostReason: status === 'lost' ? body.lost_reason : null,
            note: typeof body.note === 'string' ? body.note.slice(0, 1000) : null,
            actorUserId: ctx.userId,
            stageId: typeof body.stage_id === 'string' && UUID_RE.test(body.stage_id) ? body.stage_id : null,
          })
    return NextResponse.json(result)
  } catch (err) {
    const statusCode = err instanceof DealCloseError ? err.status : 500
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: statusCode },
    )
  }
}
