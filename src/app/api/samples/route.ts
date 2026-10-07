import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { parseAppliesTo } from '@/app/api/bookings/reminder-rules/fields'
import { countSamples, loadSamples, removeSamples, SampleError, SAMPLE_MODULES, type SampleModule } from '@/lib/samples/seed'

// "Cargar ejemplos" / "Quitar ejemplos" (migration 068).
// GET → how many example rows each module has.
// POST {module, scope?} → replace that module's examples with a fresh set.
// DELETE {module, scope?} → remove them. Only rows flagged is_sample.

const MODULE_SWITCH: Record<SampleModule, 'restaurant' | 'events' | 'clinic' | null> = {
  restaurant: 'restaurant',
  events: 'events',
  clinic: 'clinic',
  reminders: null,
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    return NextResponse.json({ counts: await countSamples({ db: ctx.supabase, accountId: ctx.accountId, userId: ctx.userId }) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function handle(request: Request, action: 'load' | 'remove') {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const body = (await request.json().catch(() => null)) as { module?: unknown; scope?: unknown } | null
  const sampleModule = SAMPLE_MODULES.find((m) => m === body?.module)
  if (!sampleModule) return NextResponse.json({ error: 'Invalid module' }, { status: 400 })
  const scope = body?.scope === undefined ? null : parseAppliesTo(body.scope)
  if (body?.scope !== undefined && !scope) return NextResponse.json({ error: 'Invalid scope' }, { status: 400 })

  const gate = MODULE_SWITCH[sampleModule]
  if (action === 'load' && gate && !(await accountModuleEnabled(ctx.supabase, ctx.accountId, gate))) {
    return NextResponse.json({ error: 'Module disabled', code: 'module_disabled' }, { status: 403 })
  }

  const sctx = { db: ctx.supabase, accountId: ctx.accountId, userId: ctx.userId }
  try {
    if (action === 'remove') {
      await removeSamples(sctx, sampleModule, scope)
      return NextResponse.json({ ok: true })
    }
    const created = await loadSamples(sctx, sampleModule, scope)
    return NextResponse.json({ ok: true, created }, { status: 201 })
  } catch (err) {
    if (err instanceof SampleError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    console.error('[samples] failed:', err)
    return NextResponse.json({ error: 'Could not load the examples' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return handle(request, 'load')
}

export async function DELETE(request: Request) {
  return handle(request, 'remove')
}
